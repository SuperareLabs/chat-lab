import { loadSouls } from '../lib/prompts.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLabServer } from '../server.mjs';

const CHAT = 'deepseek-v4-1-flash-economy-261017';
const SEARCH = 'doubao-seed-2-0-mini-260428';
const instant = '2026-11-12T03:00:00.000Z';
const receipt = (input, output, model = CHAT, extra = {}) => ({
  model, service_tier: 'default', finish_reason: 'stop',
  usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: Math.min(100, input) },
    completion_tokens_details: { reasoning_tokens: 0 } }, ...extra,
});
const response = (text, input = 1000, output = 10) => ({ content: text, toolCalls: [], receipt: receipt(input, output) });
const tool = (name, args) => ({ id: 'tool-one', type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function fixture(t, provider, options = {}) {
  const lab = createLabServer({ souls: loadSouls(),
    provider, dbPath: ':memory:', clock: () => new Date(instant),
    model: { name: CHAT, configured: true, searchConfigured: !!options.search, searchModel: SEARCH, mode: 'test' },
    ...options,
  });
  const { port } = await lab.listen(0);
  t.after(() => lab.close());
  const origin = 'http://127.0.0.1:' + port;
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const chat = async (text, requestId = crypto.randomUUID()) => {
    const r = await fetch(origin + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, text, requestId }) });
    assert.equal(r.status, 200);
    return (await r.text()).trim().split('\n\n').filter(Boolean).map(block => JSON.parse(block.slice(6)));
  };
  const session = id => fetch(origin + '/api/sessions/' + id + '?' + new URLSearchParams(scope)).then(r => r.json());
  return { lab, scope, origin, chat, session };
}

test('usage is durable per call, replay is free, and current context is separate from accumulated tokens', async t => {
  let calls = 0;
  const f = await fixture(t, { async chat() { calls++; return response('在。', calls === 1 ? 1000 : 1200, calls === 1 ? 10 : 12); } });
  const events = await f.chat('在吗', 'dedupe');
  const sessionId = events[0].sessionId;
  const first = (await f.session(sessionId)).usage;
  assert.equal(first.totalTokens, 1010);
  assert.equal(first.cachedTokens, 100);
  assert.equal(first.recordedCalls, 1);
  assert.equal(first.partial, false);
  assert.ok(first.modelCostCny > 0);
  assert.equal(first.toolCostCny, 0);
  assert.equal(first.latestContext.inputTokens, 1000);
  assert.equal(first.latestContext.contextWindowTokens, 1024 * 1024);
  assert.ok(events.some(event => event.type === 'usage' && event.sessionId === sessionId && event.usage.totalTokens === 1010));
  await f.chat('在吗', 'dedupe');
  assert.equal(calls, 1);
  assert.deepEqual((await f.session(sessionId)).usage, first);
  const nextEvents = await f.chat('再说一句');
  assert.equal(nextEvents.find(event => event.type === 'usage').usage.latestContext.inputTokens, 1000,
    'pending requests retain the last measured context until a new receipt arrives');
  const next = (await f.session(sessionId)).usage;
  assert.equal(next.inputTokens, 2200);
  assert.equal(next.outputTokens, 22);
  assert.equal(next.totalTokens, 2222);
  assert.equal(next.latestContext.inputTokens, 1200);
  assert.equal(next.recordedCalls, 2);
  assert.equal(f.lab.store.sql('SELECT count(*) AS n FROM usage_records').get().n, 2);
});

test('search usage travels outside the model result, includes plugin cost, and updates live tool metadata', async t => {
  let calls = 0;
  const f = await fixture(t, {
    async chat({ messages }) {
      calls++;
      if (messages.at(-1).role === 'tool') {
        const result = JSON.parse(messages.at(-1).content);
        assert.deepEqual(Object.keys(result).sort(), ['ok', 'query', 'results', 'retrieved_at', 'untrusted']);
        assert.equal('receipt' in result, false);
        assert.equal('usage' in result, false);
        return response('查到了。', 700, 25);
      }
      return { content: '我查查。', toolCalls: [tool('search_web', { query: '故宫官网' })], receipt: receipt(500, 20) };
    },
  }, { search: { configured: true, metadata: { endpoint: SEARCH }, async search() {
    return { results: [{ title: '故宫', url: 'https://www.dpm.org.cn/', snippet: '官方网站' }],
      metadata: { retrieved_at: instant }, receipt: { model: SEARCH, service_tier: 'default', status: 'completed',
        usage: { input_tokens: 2000, output_tokens: 50, total_tokens: 2050, input_tokens_details: { cached_tokens: 0 },
          tool_usage: { web_search: 1 }, tool_usage_details: { web_search: { search_engine: 1 } } },
        search_calls: 1 }, metrics: { total_ms: 10 } };
  } } });
  const events = await f.chat('查一下故宫官网');
  assert.equal(calls, 2);
  const session = await f.session(events[0].sessionId);
  assert.equal(session.usage.totalTokens, 3295);
  assert.equal(session.usage.recordedCalls, 3);
  assert.equal(session.usage.searchCalls, 1);
  assert.equal(session.usage.toolCostCny, .004);
  assert.equal(session.usage.partial, false);
  const usage = session.context.toolCalls[0].usage;
  assert.equal(usage.model, SEARCH);
  assert.equal(usage.inputTokens, 2000);
  assert.equal(usage.toolCostCny, .004);
  assert.ok(usage.modelCostCny > 0);
  assert.ok(events.some(event => event.type === 'tool_usage' && event.call.pending && event.call.model === SEARCH));
  assert.equal(events.filter(event => event.type === 'tool_usage').at(-1).call.totalCostCny, usage.totalCostCny);
  assert.equal(session.context.modelRequests[0].usage.inputTokens, 500);
  assert.equal(session.usage.latestContext.inputTokens, 700);
});

test('provider errors retain reported billable usage and missing usage is not represented as zero', async t => {
  const f = await fixture(t, { async chat() {
    const error = new Error('stream failed after usage');
    error.receipt = receipt(800, 7);
    throw error;
  } });
  const events = await f.chat('测试断流');
  assert.equal(events.at(-1).type, 'error');
  const usage = (await f.session(events[0].sessionId)).usage;
  assert.equal(usage.totalTokens, 807);
  assert.ok(usage.totalCostCny > 0);
  assert.equal(usage.calls[0].status, 'failed');

  const missing = await fixture(t, { async chat() { return { content: '在。', toolCalls: [], receipt: { finish_reason: 'stop' } }; } });
  const missingEvents = await missing.chat('在吗');
  const incomplete = (await missing.session(missingEvents[0].sessionId)).usage;
  assert.equal(incomplete.inputTokens, null);
  assert.equal(incomplete.outputTokens, null);
  assert.equal(incomplete.totalCostCny, null);
  assert.equal(incomplete.missingUsageCalls, 1);
  assert.equal(incomplete.partial, true);
});

test('local tools have zero incremental external fees while model requests remain counted', async t => {
  const f = await fixture(t, { async chat({ messages }) {
    if (messages.at(-1).role === 'tool') return response('等于五。');
    return { content: '我算一下。', toolCalls: [tool('calculate', { expression: '2+3' })], receipt: receipt(1000, 10) };
  } });
  const events = await f.chat('算二加三');
  const session = await f.session(events[0].sessionId);
  assert.equal(session.context.toolCalls[0].usage.local, true);
  assert.equal(session.context.toolCalls[0].usage.model, null);
  assert.equal(session.context.toolCalls[0].usage.totalCostCny, 0);
  assert.equal(session.usage.recordedCalls, 2);
  assert.equal(session.usage.totalTokens, 2020);
  assert.equal(session.usage.toolCalls, 1);
  assert.equal(session.usage.partial, false);
});

test('failed searches preserve a known plugin fee even if the model usage was not returned', async t => {
  const f = await fixture(t, { async chat({ messages }) {
    if (messages.at(-1).role === 'tool') return response('这次没查到。');
    return { content: '我查查。', toolCalls: [tool('search_web', { query: '故宫官网' })], receipt: receipt(1000, 10) };
  } }, { search: { configured: true, metadata: { endpoint: SEARCH }, async search() {
    const error = new Error('search response incomplete');
    error.receipt = { model: SEARCH, search_calls: 1 };
    throw error;
  } } });
  const events = await f.chat('查一下官网');
  const session = await f.session(events[0].sessionId);
  assert.equal(session.context.toolCalls[0].result.ok, false);
  assert.equal(session.context.toolCalls[0].usage.toolCostCny, .004);
  assert.equal(session.context.toolCalls[0].usage.totalCostCny, null);
  assert.equal(session.usage.missingUsageCalls, 1);
  assert.equal(session.usage.partial, true);
  assert.ok(session.usage.knownCostCny > session.usage.totalCostCny);
});

test('memory extraction is associated with its archived session and remains separate from new-session context', async t => {
  const f = await fixture(t, { async chat(options) {
    if (options.responseFormat) return response(JSON.stringify({
      creates: [], updates: [], mentions: [], retractions: [], overview: null,
    }), 400, 20);
    return response('在。', 1000, 10);
  } });
  const events = await f.chat('在吗');
  const oldId = events[0].sessionId;
  const responseSession = await fetch(f.origin + '/api/sessions', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.scope) });
  const nextId = (await responseSession.json()).session.id;
  if (f.lab.runtime.worker) await f.lab.runtime.worker;
  const old = await f.session(oldId);
  assert.equal(f.lab.store.jobList(f.scope.childId, f.scope.agentId)[0].status, 'succeeded');
  assert.equal(old.usage.memoryCalls, 1);
  assert.equal(old.usage.totalTokens, 1430);
  assert.equal(old.usage.latestContext.inputTokens, 1000);
  const fresh = await f.session(nextId);
  assert.equal(fresh.usage.totalTokens, 0);
  assert.equal(fresh.usage.latestContext, null);
  assert.equal(fresh.usage.partial, false);
  const wrong = await fetch(f.origin + '/api/sessions/' + oldId + '?' + new URLSearchParams({ ...f.scope, agentId: 'pinecone-lab' }));
  assert.equal(wrong.status, 404);
});

test('additive accounting migration retains existing messages and flags previous turns as untracked', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'croco-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'chat.sqlite');
  const provider = { async chat() { return response('在。'); } };
  const old = createLabServer({ souls: loadSouls(), provider, dbPath, clock: () => new Date(instant) });
  await old.listen(0);
  const child = old.store.children()[0];
  const agentId = old.runtime.state().agents[0].id;
  const session = old.store.manuallyOpen(child.id, agentId, instant);
  const run = old.store.beginChat({ childId: child.id, agentId, sessionId: session.id, text: '旧消息', requestId: 'legacy' }, instant, 900000);
  old.store.finishChat(run, { reply: '旧回复' }, instant);
  const before = old.store.session(session.id, child.id, agentId);
  const version = old.runtime.dataVersion;
  await old.close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec('DROP TABLE usage_records');
  legacy.close();
  const next = createLabServer({ souls: loadSouls(), provider, dbPath, clock: () => new Date(instant) });
  await next.listen(0);
  t.after(() => next.close());
  assert.equal(next.runtime.dataVersion, version);
  const after = next.store.session(session.id, child.id, agentId);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(next.store.children()[0].id, child.id);
  assert.equal(after.usage.untrackedTurns, 1);
  assert.equal(after.usage.partial, true);
  assert.equal(after.usage.recordedCalls, 0);
  assert.equal(after.usage.latestContext, null);
});
