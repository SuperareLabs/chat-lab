import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../lib/runtime.mjs';
import { ChatStore } from '../lib/store.mjs';

test('one extraction response atomically adds, corrects and selects overview sources without a review or brief call', async t => {
  const store = new ChatStore(':memory:');
  const now = '2026-11-13T02:00:00.000Z';
  const calls = [];
  const receipt = { model: 'doubao-seed-2-1-lite-260915', finish_reason: 'stop',
    usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } };
  let oldId, rawOutput;
  const runtime = new ChatRuntime({ store, clock: () => new Date(now), appVersion: '1.3.0',
    model: { name: 'unused-chat', configured: true }, memoryModel: { name: receipt.model, configured: true },
    allowDataReset: false, contextBriefEnabled: false,
    provider: { async chat() { assert.fail('memory extraction must use the dedicated provider'); } },
    memoryProvider: { async chat(options) {
      calls.push(options);
      assert.equal(options.responseFormat.json_schema.name, 'general_chat_memory_v2');
      const input = JSON.parse(options.messages[1].content), user = input.userMessages[0];
      assert.equal(input.memoryIndex.find(item => item.id === oldId).summary, '用户喜欢红茶。');
      rawOutput = JSON.stringify({
        creates: [{ sourceMessageIds: [user.id], kind: 'understanding', topics: ['吉他'],
          summary: '用户每周末练习吉他。', detail: { notes: '准备参加明年的社团演出。' } }],
        updates: [{ sourceMessageIds: [user.id], memoryId: oldId, changeType: 'correction',
          summary: '用户的饮品偏好改为乌龙茶。', detailDelta: { notes: '原先喜欢红茶，现在更喜欢乌龙茶。' } }],
        mentions: [], retractions: [],
        overview: { summary: '用户喜欢乌龙茶，每周末练习吉他。', memoryIds: [oldId], createIndexes: [0] },
      });
      return { content: rawOutput, receipt, metrics: { total_ms: 3 } };
    } } });
  runtime.initialize();
  t.after(async () => { await runtime.stop(); store.close(); });
  const scope = { childId: store.children()[0].id, agentId: runtime.state().agents[0].id };
  const prepareJob = (text, at) => {
    const run = store.beginChat({ ...scope, text, requestId: crypto.randomUUID() }, at, 900_000);
    store.finishChat(run, { reply: '好。' }, at);
    store.manuallyOpen(scope.childId, scope.agentId, at);
    const job = store.claimJob(at);
    assert(job);
    return job;
  };
  const seed = prepareJob('我喜欢红茶。', '2026-11-12T02:00:00.000Z');
  const seedUser = seed.snapshot.find(message => message.role === 'user');
  const seeded = store.commitJob(seed, { creates: [{ kind: 'understanding', topics: ['饮品'], summary: '用户喜欢红茶。',
    detail: { notes: '早餐时常喝一杯。' }, anchorMessageId: seedUser.id, sourceMessageIds: [seedUser.id] }],
  updates: [], mentions: [], retractions: [], overview: { summary: '用户喜欢红茶。', memoryIds: [], createIndexes: [0] } }, now);
  oldId = seeded.createdIds[0];
  const job = prepareJob('更正一下，现在我更喜欢乌龙茶。我每周末练习吉他，准备参加明年的社团演出。', now);
  await runtime.extract(job, new AbortController().signal);

  assert.equal(calls.length, 1, 'new facts, correction and overview all come from a single response');
  const saved = store.jobList(scope.childId, scope.agentId).find(item => item.sessionId === job.session_id);
  assert.equal(saved.status, 'succeeded', saved.error);
  assert.equal(saved.result.createdIds.length, 1);
  assert.deepEqual(saved.result.updatedIds, [oldId]);
  assert.equal(saved.result.overviewUpdated, true);
  assert.equal(saved.input.reviewRequest, undefined);
  assert.equal(saved.output.content, rawOutput);
  assert.equal(saved.output.stages.extraction.content, rawOutput);
  assert.equal(saved.output.stages.review, undefined);
  assert.deepEqual(saved.output.receipt, receipt);
  assert.deepEqual(saved.output.metrics, { total_ms: 3 });
  const updated = store.memoryDetail(oldId, scope.childId, scope.agentId);
  assert.equal(updated.summary, '用户的饮品偏好改为乌龙茶。');
  assert.deepEqual(updated.detail, { notes: '早餐时常喝一杯。' }, 'the original detail is retained');
  assert.equal(updated.detailChanges.length, 1);
  assert.equal(updated.detailChanges[0].detailDelta.notes, '原先喜欢红茶，现在更喜欢乌龙茶。');
  assert.equal(updated.summaryHistory[0].summary, '用户喜欢红茶。');
  const created = store.memoryDetail(saved.result.createdIds[0], scope.childId, scope.agentId);
  assert.equal(created.detail.notes, '准备参加明年的社团演出。');
  assert.equal(created.anchorMessageId, job.snapshot.find(message => message.role === 'user').id);
  const overview = runtime.chatOverview(scope.childId, scope.agentId);
  assert.deepEqual(overview.memoryIds, [oldId, created.memoryId]);
  assert.match(overview.summary, /乌龙茶/);
  assert.match(overview.summary, /吉他/);
  assert.doesNotMatch(overview.summary, /红茶/);
  const usage = store.usage(job.session_id);
  assert.equal(usage.memoryCalls, 1);
  assert.deepEqual(usage.calls.map(call => [call.kind, call.name]), [['memory', 'extraction']]);
  assert.equal(store.sql('SELECT count(*) AS n FROM context_briefs').get().n, 0);
  assert.equal(runtime.promptDetail(scope.agentId).memoryReview, '');
  assert.equal(runtime.promptDetail(scope.agentId).contextBrief, '');
});
