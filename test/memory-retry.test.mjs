import { loadSouls } from '../lib/prompts.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createLabServer } from '../server.mjs';

test('two invalid source responses are logged without writes and only an explicit scoped retry starts another attempt', async t => {
  let memoryCalls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const lab = createLabServer({ souls: loadSouls(), dbPath: ':memory:', provider: { async chat(options) {
    assert.equal(options.responseFormat, undefined, 'chat provider does not perform memory work');
    return { content: '好，小禾。', toolCalls: [], receipt: { finish_reason: 'stop' } };
  } }, memoryModel: { name: 'separate-memory-model', configured: true, mode: 'test' }, memoryProvider: { async chat(options) {
    assert(options.responseFormat, 'memory provider only performs extraction');
    assert.equal(options.responseFormat.json_schema.name, 'general_chat_memory_v2');
    memoryCalls++;
    const { userMessages, assistantContext } = JSON.parse(options.messages[1].content);
    const user = userMessages[0];
    assert.deepEqual(options.responseFormat.json_schema.schema.properties.creates.items.properties.sourceMessageIds.items.enum, [user.id]);
    assert.equal(options.responseFormat.json_schema.schema.properties.creates.items.properties.anchorMessageId, undefined);
    assert.deepEqual(assistantContext, [], 'a trailing assistant answer is not evidence for the preceding user question');
    const anchor = memoryCalls <= 2 ? { id: 'A' + memoryCalls } : user;
    if (memoryCalls === 3) await gate;
    return { content: JSON.stringify({
      creates: [{ kind: 'understanding', topics: ['称呼'], summary: '用户希望被称为小禾。',
        sourceMessageIds: [anchor.id] }],
      updates: [], mentions: [], retractions: [], overview: { summary: '用户希望被称为小禾。', memoryIds: [], createIndexes: [0] },
    }), receipt: { finish_reason: 'stop' }, metrics: { total_ms: 1 } };
  } } });
  const { port } = await lab.listen(0);
  t.after(() => lab.close());
  const origin = 'http://127.0.0.1:' + port;
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const open = async () => (await (await post('/api/sessions', scope)).json()).session;
  const first = await open();
  const r = await post('/api/chat', { ...scope, sessionId: first.id, text: '以后叫我小禾。', requestId: 'intro' });
  assert.match(await r.text(), /"type":"done"/);
  await open();
  const read = () => fetch(origin + '/api/memory?' + new URLSearchParams(scope)).then(x => x.json());
  const until = async status => {
    for (let i = 0; i < 100; i++) { const d = await read(); if (d.jobs[0]?.status === status) return d; await pause(5); }
    assert.fail('Job did not reach ' + status);
  };
  const failed = await until('failed');
  assert.equal(failed.items.length, 0);
  assert(failed.jobs[0].output.content.includes('用户希望被称为小禾'));
  assert.equal(failed.jobs[0].result.validationContext.reference, 'A2');
  assert.match(failed.jobs[0].error, /已修正1次仍失败/);
  assert.deepEqual(failed.jobs[0].output.validationFailures.map(item => item.validationContext.reference), ['A1', 'A2']);
  assert(failed.jobs[0].output.stages.repair.content.includes('A2'));
  await read(); await read();
  assert.equal(memoryCalls, 2, 'reading the bounded repair failure never starts another attempt');
  const retryPath = '/api/memory/jobs/' + first.id + '/retry';
  const other = lab.store.createChild({ name: '另一用户', age: 9, interests: [] }, new Date().toISOString());
  assert.equal((await post(retryPath, { ...scope, childId: other.id })).status, 404);
  assert.equal((await post(retryPath, scope)).status, 202);
  assert.equal((await post(retryPath, scope)).status, 409);
  release();
  const done = await until('succeeded');
  assert.equal(memoryCalls, 3);
  assert.equal(done.jobs[0].output.stages.review, undefined, 'the successful explicit retry needs no second review request');
  assert.equal(done.jobs[0].output.stages.repair, undefined, 'the successful explicit retry is already valid on its first response');
  assert.equal(done.items.length, 1);
  assert.equal(done.jobs[0].attempts.length, 1);
  assert.equal(done.jobs[0].attempts[0].result.validationContext.reference, 'A2');
  assert.equal(done.jobs[0].attempts[0].output.validationFailures.length, 2);
  assert(done.jobs[0].attempts[0].output.stages.repair.content.includes('A2'));
  assert(done.jobs[0].attempts[0].output.content.includes('用户希望被称为小禾'));
  assert.equal(done.jobs[0].output.receipt.finish_reason, 'stop');
  assert.equal(done.jobs[0].input.messageReferences.length, 1);
  const ref = done.jobs[0].input.messageReferences[0];
  assert.equal(ref.ref, 'U1');
  assert.equal(done.jobs[0].result.plan.creates[0].anchorMessageId, ref.messageId);
  assert.notEqual(ref.messageId, 'U1', 'only real IDs are committed to persisted sources');
  const usage = lab.store.usage(first.id);
  assert.equal(usage.memoryCalls, 3, 'the failed extraction, one repair and explicit successful retry remain separately charged');
  assert.deepEqual(usage.calls.filter(call => call.kind === 'memory').map(call => call.name), ['extraction', 'repair', 'extraction']);
  assert(usage.calls.filter(call => call.kind === 'memory').every(call => call.model === 'separate-memory-model'));
  assert.equal(lab.runtime.state().memoryModel.name, 'separate-memory-model');
  assert.equal((await post(retryPath, scope)).status, 409);
});

test('a mixed invalid extraction still failing after one repair preserves both outputs without partial memory or further retry', async t => {
  let calls = 0;
  const receipt = { model: 'doubao-seed-2-1-lite-260915', finish_reason: 'stop',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } } };
  const lab = createLabServer({ souls: loadSouls(), dbPath: ':memory:',
    provider: { async chat() { return { content: '好。', toolCalls: [], receipt: { finish_reason: 'stop' } }; } },
    memoryModel: { name: receipt.model, configured: true, mode: 'test' },
    memoryProvider: { async chat(options) {
      calls++;
      assert.equal(options.responseFormat.json_schema.name, 'general_chat_memory_v2');
      const user = JSON.parse(options.messages[1].content).userMessages[0];
      return { content: JSON.stringify({ creates: [{ sourceMessageIds: [user.id], kind: 'event', topics: ['水壶'],
        summary: '用户昨天找回蓝水壶。' }], updates: [{ sourceMessageIds: [user.id], memoryId: 'unknown-memory',
          changeType: 'correction', summary: '不存在的旧记忆更正。' }], mentions: [], retractions: [], overview: null }), receipt };
    } } });
  const { port } = await lab.listen(0); t.after(() => lab.close());
  const origin = 'http://127.0.0.1:' + port;
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = (await (await post('/api/sessions', scope)).json()).session;
  await (await post('/api/chat', { ...scope, sessionId: first.id, text: '昨天找回了蓝水壶。', requestId: 'invalid-extraction' })).text();
  await post('/api/sessions', scope);
  for (let i = 0; i < 100; i++) {
    const data = await fetch(origin + '/api/memory?' + new URLSearchParams(scope)).then(r => r.json());
    if (data.jobs[0]?.status === 'failed') {
      assert.match(data.jobs[0].error, /记忆 ID 不在本次有效候选中/);
      assert.match(data.jobs[0].error, /已修正1次仍失败/);
      assert.equal(data.items.length, 0);
      assert.equal(data.overview.summary, '');
      assert.equal(lab.store.sql('SELECT count(*) AS n FROM memory_mentions').get().n, 0);
      assert(data.jobs[0].output.stages.extraction.content.includes('蓝水壶'));
      assert.equal(data.jobs[0].output.stages.review, undefined);
      assert(data.jobs[0].output.stages.repair.content.includes('unknown-memory'));
      assert.deepEqual(data.jobs[0].output.validationFailures.map(item => item.stage), ['extraction', 'repair']);
      assert.equal(lab.store.usage(first.id).memoryCalls, 2);
      for (let read = 0; read < 3; read++) {
        await fetch(origin + '/api/memory?' + new URLSearchParams(scope));
        lab.runtime.tick();
      }
      await pause(10);
      assert.equal(calls, 2, 'the bounded repair failure and repeated reads do not trigger another paid call');
      return;
    }
    await pause(5);
  }
  assert.fail('invalid extraction failure not recorded');
});
