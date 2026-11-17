import { loadSouls } from '../lib/prompts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLabServer } from '../server.mjs';
import { ChatStore } from '../lib/store.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const call = (name, args, id = 'tool-1') => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const answer = text => ({ content: text, toolCalls: [], receipt: { finish_reason: 'stop' } });
const toolReply = (text, name = 'search_web', args = { query: '火星表面颜色', limit: 1 }) => ({
  content: text, toolCalls: [call(name, args)], receipt: { finish_reason: 'tool_calls' },
});

async function fixture(t, provider, search) {
  const lab = createLabServer({ souls: loadSouls(), provider, search, dbPath: ':memory:' });
  const { port } = await lab.listen(0);
  t.after(() => lab.close());
  const origin = 'http://127.0.0.1:' + port;
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const request = async (text, requestId = crypto.randomUUID()) => {
    const response = await fetch(origin + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, text, requestId }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    return response;
  };
  return { lab, scope, request };
}

function streamEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const events = [];
  async function readUntil(predicate) {
    while (!predicate(events)) {
      assert.equal(ended, false, 'stream ended before expected event');
      const { done, value } = await reader.read();
      if (done) ended = true;
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
      }
    }
    return events;
  }
  return { events, readUntil, close: () => reader.cancel() };
}

test('a real tool acknowledgement arrives before the tool completes, then the result arrives in the same SSE request', async t => {
  const entered = deferred();
  const release = deferred();
  const trace = [];
  const f = await fixture(t, {
    async chat(options) {
      const last = options.messages.at(-1);
      trace.push(last.role);
      if (last.role === 'tool') {
        const result = JSON.parse(last.content);
        assert.equal(result.ok, true);
        assert.equal(result.results[0].title, '火星');
        return answer('查到了，火星表面的红色与含铁矿物有关。');
      }
      options.onDelta?.('我去');
      options.onDelta?.('查查。');
      return toolReply('我去查查。');
    },
  }, {
    configured: true,
    async search() {
      entered.resolve();
      await release.promise;
      return { results: [{ title: '火星', url: 'https://example.com/mars', snippet: '表面有含铁矿物。' }],
        metadata: { retrieved_at: '2026-11-12T00:00:00.000Z' } };
    },
  });
  t.after(release.resolve);
  const requestId = 'one-search-turn';
  const response = await f.request('帮我查查火星为什么是红的。', requestId);
  const stream = streamEvents(response);
  await entered.promise;
  await stream.readUntil(events => events.some(event => event.type === 'reply_part'));
  assert.deepEqual(stream.events.find(event => event.type === 'reply_part'), {
    type: 'reply_part', index: 0, text: '我去查查。', kind: 'acknowledgement',
  });
  assert.equal(stream.events.some(event => event.type === 'done'), false);
  assert.equal(stream.events.some(event => event.type === 'reply_part' && event.kind === 'answer'), false);
  assert.deepEqual(trace, ['user']);
  await stream.readUntil(events => events.some(event => event.type === 'tool_status'));
  assert.equal(stream.events.find(event => event.type === 'tool_status').status, 'running');
  release.resolve();
  await stream.readUntil(events => events.some(event => event.type === 'done'));
  await stream.close();

  const parts = stream.events.filter(event => event.type === 'reply_part');
  assert.deepEqual(parts.map(part => part.kind), ['acknowledgement', 'answer']);
  assert.deepEqual(trace, ['user', 'tool']);
  assert.equal(stream.events.filter(event => event.type === 'tool_status').at(-1).status, 'complete');
  const combined = parts.map(part => part.text).join('\n\n');
  assert.equal(stream.events.filter(event => event.type === 'delta').map(event => event.text).join(''), combined);
  const sessionId = stream.events[0].sessionId;
  const session = f.lab.store.session(sessionId, f.scope.childId, f.scope.agentId);
  assert.deepEqual(session.messages.at(-1).parts, parts.map(part => part.text));
  assert.equal(session.messages.at(-1).text, combined);
  assert.deepEqual(session.context.modelRequests.map(request => request.finish_reason), ['tool_calls', 'stop']);
  assert.deepEqual(session.context.modelRequests[0].toolNames, ['search_web']);

  const replay = streamEvents(await f.request('帮我查查火星为什么是红的。', requestId));
  await replay.readUntil(events => events.some(event => event.type === 'done'));
  await replay.close();
  assert.deepEqual(replay.events.filter(event => event.type === 'reply_part'), parts);
  assert.equal(replay.events.some(event => event.type === 'tool_status'), false);
  assert.deepEqual(trace, ['user', 'tool'], 'replay does not invoke model or tool again');
  assert.equal(f.lab.store.messages(sessionId).length, 2, 'history remains one user turn plus one multipart assistant turn');
});

test('a tool failure is returned to the model and followed by a failure answer without another user message', async t => {
  let calls = 0;
  const f = await fixture(t, {
    async chat({ messages }) {
      calls++;
      if (messages.at(-1).role === 'tool') {
        assert.equal(JSON.parse(messages.at(-1).content).ok, false);
        return answer('这次没查到可靠的结果。');
      }
      return toolReply('');
    },
  }, { configured: true, async search() { throw new Error('simulated timeout'); } });
  const stream = streamEvents(await f.request('查查火星的颜色。'));
  await stream.readUntil(events => events.some(event => event.type === 'done'));
  await stream.close();
  assert.deepEqual(stream.events.filter(event => event.type === 'reply_part').map(event => event.text), [
    '我查查。', '这次没查到可靠的结果。',
  ]);
  assert.equal(calls, 2);
});

test('ordinary replies have no tool acknowledgement or working status', async t => {
  const f = await fixture(t, { async chat() { return answer('在。'); } });
  const stream = streamEvents(await f.request('在吗'));
  await stream.readUntil(events => events.some(event => event.type === 'done'));
  await stream.close();
  assert.deepEqual(stream.events.filter(event => event.type === 'reply_part'), [
    { type: 'reply_part', index: 0, text: '在。', kind: 'answer' },
  ]);
  assert.equal(stream.events.some(event => event.type === 'tool_status'), false);
});

test('an acknowledgement alone cannot finish a tool turn when the model returns no final answer', async t => {
  const f = await fixture(t, {
    async chat({ messages }) {
      if (messages.at(-1).role === 'tool') return answer('');
      return toolReply('我算一下。', 'calculate', { expression: '2+3' });
    },
  });
  const stream = streamEvents(await f.request('二加三等于几？'));
  await stream.readUntil(events => events.some(event => event.type === 'error'));
  await stream.close();
  assert.equal(stream.events.some(event => event.type === 'done'), false);
  assert.equal(stream.events.filter(event => event.type === 'reply_part').length, 1);
  const run = f.lab.store.sql('SELECT status, error FROM runs').get();
  assert.equal(run.status, 'failed');
  assert.match(run.error, /回复格式不完整/);
});

test('parts schema migration preserves old text and keeps multipart replies across a same-version restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'croco-tool-parts-'));
  const path = join(directory, 'chat.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatStore(path);
  store.activateVersion('test-parts', '2026-11-12T00:00:00.000Z');
  const child = store.children()[0];
  const session = store.manuallyOpen(child.id, 'croco-lab', '2026-11-12T00:00:00.000Z');
  const run = store.beginChat({ childId: child.id, agentId: 'croco-lab', sessionId: session.id, text: '算一下。', requestId: 'parts' },
    '2026-11-12T00:00:00.000Z', 15 * 60 * 1000);
  const parts = ['我算一下。', '等于五。'];
  store.finishChat(run, { reply: parts.join('\n\n'), parts }, '2026-11-12T00:00:01.000Z');
  store.close();
  const restarted = new ChatStore(path);
  restarted.activateVersion('test-parts', '2026-11-12T00:00:02.000Z');
  assert.deepEqual(restarted.messages(session.id).at(-1).parts, parts);
  restarted.db.exec('ALTER TABLE messages DROP COLUMN parts');
  restarted.close();
  const legacy = new ChatStore(path);
  assert.equal(legacy.messages(session.id).at(-1).text, parts.join('\n\n'));
  assert.equal(legacy.messages(session.id).at(-1).parts, undefined);
  legacy.close();
});
