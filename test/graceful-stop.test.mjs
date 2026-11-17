import { loadSouls } from '../lib/prompts.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLabServer } from '../server.mjs';

const deferred = () => Promise.withResolvers();
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('draining shutdown waits for an active chat without aborting its provider or losing the reply', { timeout: 5000 }, async t => {
  const gate = deferred(), entered = deferred();
  let signal, closing, chat, closed = false, completed;
  const lab = createLabServer({ souls: loadSouls(), dbPath: ':memory:', contextBriefEnabled: false,
    provider: { async chat(options) {
      assert.equal(options.responseFormat.type, 'json_object');
      signal = options.signal;
      entered.resolve();
      await gate.promise;
      return { content: '回复已经完整保存。', toolCalls: [], receipt: { finish_reason: 'stop' } };
    } } });
  t.after(async () => {
    gate.resolve();
    await Promise.allSettled([chat].filter(Boolean));
    await (closing || lab.close());
  });
  const finish = lab.store.finishChat.bind(lab.store);
  lab.store.finishChat = (run, answer, now) => {
    const result = finish(run, answer, now);
    completed = { ...lab.store.sql('SELECT status,error FROM runs WHERE id=?').get(run.runId),
      reply: lab.store.messages(run.sessionId).at(-1), providerAborted: signal.aborted };
    return result;
  };
  const { port } = await lab.listen(0);
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  chat = fetch('http://127.0.0.1:' + port + '/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ ...scope, text: '请等一会儿再回复。', requestId: 'drain-chat' }) })
    .then(async response => ({ status: response.status, events: await response.text() }));
  await entered.promise;
  assert.equal(lab.runtime.chatRuns.size, 1);
  closing = lab.close({ drain: true }).then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false, 'close remains pending while the provider is gated');
  assert.equal(signal.aborted, false, 'drain does not turn shutdown into a cancelled chat');
  gate.resolve();
  const response = await chat;
  await closing;
  assert.equal(response.status, 200);
  assert.match(response.events, /"type":"done"/);
  assert.doesNotMatch(response.events, /"type":"error"/);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.error, null);
  assert.equal(completed.reply.role, 'assistant');
  assert.equal(completed.reply.text, '回复已经完整保存。');
  assert.equal(completed.providerAborted, false);
  assert.equal(closed, true);
});

test('draining shutdown waits for a claimed memory job and lets it commit before closing SQLite', { timeout: 5000 }, async t => {
  const gate = deferred(), entered = deferred();
  let signal, closing, closed = false, committed, calls = 0;
  const lab = createLabServer({ souls: loadSouls(), dbPath: ':memory:', contextBriefEnabled: false,
    provider: { async chat() { throw new Error('This test does not call the chat provider'); } },
    memoryModel: { name: 'gated-memory-test', configured: true, mode: 'test' },
    memoryProvider: { async chat(options) {
      calls++;
      assert(options.responseFormat);
      signal = options.signal;
      entered.resolve();
      await gate.promise;
      return { content: JSON.stringify({ creates: [], updates: [], mentions: [], retractions: [], overview: null }),
        receipt: { finish_reason: 'stop' } };
    } } });
  t.after(async () => {
    gate.resolve();
    await (closing || lab.close());
  });
  const commit = lab.store.commitJob.bind(lab.store);
  lab.store.commitJob = (job, plan, now, options) => {
    const result = commit(job, plan, now, options);
    committed = { ...lab.store.sql('SELECT status,error,item_count FROM jobs WHERE session_id=?').get(job.session_id),
      committed: result.committed, providerAborted: signal.aborted };
    return result;
  };
  await lab.listen(0);
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const now = lab.runtime.now();
  const run = lab.store.beginChat({ ...scope, messages: [{ text: '只是普通寒暄。' }], requestId: 'drain-memory' }, now, 900_000);
  lab.store.finishChat(run, { reply: '好。' }, now);
  lab.store.manuallyOpen(scope.childId, scope.agentId, now);
  lab.runtime.tick();
  await entered.promise;
  assert(lab.runtime.worker, 'the memory job was claimed before shutdown');
  assert.equal(lab.store.jobList(scope.childId, scope.agentId)[0].status, 'running');
  closing = lab.close({ drain: true }).then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false, 'close waits for the existing memory request');
  assert.equal(signal.aborted, false);
  gate.resolve();
  await closing;
  assert.equal(committed.status, 'succeeded');
  assert.equal(committed.error, null);
  assert.equal(committed.item_count, 0);
  assert.equal(committed.committed, true);
  assert.equal(committed.providerAborted, false);
  assert.equal(calls, 1, 'draining neither retries extraction nor starts another model request');
  assert.equal(closed, true);
});
