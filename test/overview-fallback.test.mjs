import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChatStore } from '../lib/store.mjs';
import { applyMemoryReview } from '../lib/memory-review.mjs';

const empty = () => ({ creates: [], updates: [], mentions: [], retractions: [], overview: null });

function fixture(t) {
  const store = new ChatStore(':memory:');
  t.after(() => store.close());
  const child = store.createChild({ name: '概括回归用户', age: 29, interests: [] }, '2026-11-12T00:00:00.000Z');
  const agentId = 'overview-fallback-soul';
  let turn = 0;
  const queue = text => {
    const at = new Date(Date.parse('2026-11-12T01:00:00.000Z') + turn++ * 60_000).toISOString();
    const run = store.beginChat({ childId: child.id, agentId, messages: [{ text }], requestId: randomUUID() }, at, 900_000);
    store.finishChat(run, { reply: '好。' }, at);
    store.manuallyOpen(child.id, agentId, at);
    return store.claimJob(at);
  };
  const evidence = job => {
    const user = job.snapshot.find(message => message.role === 'user');
    return { anchorMessageId: user.id, sourceMessageIds: [user.id] };
  };
  const commit = (job, plan) => store.commitJob(job, plan, '2026-11-12T08:00:00.000Z');
  const overview = () => store.userOverview(child.id, agentId);
  const detail = (id, options) => store.memoryDetail(id, child.id, agentId, options);
  const seed = (summary, kind = 'understanding') => {
    const job = queue(summary), plan = empty();
    plan.creates.push({ kind, topics: [], summary, ...evidence(job) });
    if (kind === 'understanding') plan.overview = {
      summary: '用于测试的明确来源选择。', memoryIds: overview().memoryIds, createIndexes: [0],
    };
    return commit(job, plan).createdIds[0];
  };
  return { store, child, agentId, queue, evidence, commit, overview, detail, seed };
}

test('null overview derives new understanding and preserves prior source order, excluding events', t => {
  const f = fixture(t);
  const prior = f.seed('用户喜欢先听结论。');
  const job = f.queue('我正在学习英语，昨天还参加了一次词汇游戏。'), plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['英语'], summary: '用户正在学习英语。', ...f.evidence(job) },
    { kind: 'event', topics: ['词汇游戏'], summary: '用户昨天参加了一次词汇游戏。', ...f.evidence(job) });
  const result = f.commit(job, plan);
  assert.equal(result.overviewFallback, true);
  assert.equal(result.overviewUpdated, true);
  assert.deepEqual(f.overview().memoryIds, [prior, result.createdIds[0]]);
  assert.equal(f.overview().summary, '用户喜欢先听结论。\n用户正在学习英语。');
  assert(!f.overview().memoryIds.includes(result.createdIds[1]));
});

test('null overview correction keeps original IDs and refreshes the referenced current summary', t => {
  const f = fixture(t);
  const tea = f.seed('用户喜欢白茶。');
  const style = f.seed('用户喜欢简短回复。');
  const job = f.queue('饮品偏好更正一下，我现在改喝乌龙茶。'), plan = empty();
  plan.updates.push({ memoryId: tea, changeType: 'correction', summary: '用户的饮品偏好已改为乌龙茶。', ...f.evidence(job) });
  const result = f.commit(job, plan);
  assert.equal(result.overviewFallback, true);
  assert.deepEqual(f.overview().memoryIds, [tea, style]);
  assert.equal(f.overview().summary, '用户的饮品偏好已改为乌龙茶。\n用户喜欢简短回复。');
  assert.equal(f.detail(tea).summaryHistory[0].summary, '用户喜欢白茶。');
});

test('null overview withdrawal of its final source stores an effective empty overview', t => {
  const f = fixture(t), nickname = f.seed('用户希望被称呼为阿澈。');
  const job = f.queue('请忘掉阿澈这个称呼。'), plan = empty();
  plan.retractions.push({ memoryId: nickname, reason: '用户明确要求忘记称呼。', ...f.evidence(job) });
  const result = f.commit(job, plan);
  assert.equal(result.overviewFallback, true);
  assert.equal(result.overviewUpdated, true);
  assert.equal(f.overview().summary, '');
  assert.deepEqual(f.overview().memoryIds, []);
  assert.equal(f.overview().stale, false);
  assert.equal(f.detail(nickname), null);
  assert.equal(f.detail(nickname, { includeRetracted: true }).state, 'retracted');
});

test('null overview deduplication reuses the archived ID without touching unrelated overview sources', t => {
  const f = fixture(t);
  const style = f.seed('用户喜欢简短回复。');
  const rust = f.seed('用户喜欢 Rust。');
  f.store.sql("UPDATE memories SET state='archived',archived_at=? WHERE id=?").run('2026-11-12T02:00:00.000Z', rust);
  const beforeStyle = f.detail(style);
  const job = f.queue('我还是喜欢 Rust。'), plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['Rust'], summary: '  用户喜欢 Ｒｕｓｔ。  ', ...f.evidence(job) });
  const result = f.commit(job, plan);
  assert.equal(result.overviewFallback, true);
  assert.deepEqual(result.createdIds, []);
  assert.deepEqual(result.exactDuplicates, [{ createIndex: 0, memoryId: rust }]);
  assert.deepEqual(result.reactivatedIds, [rust]);
  assert.deepEqual(f.overview().memoryIds, [style, rust]);
  assert.equal(f.detail(rust).state, 'active');
  assert.equal(f.detail(rust).lastMentionedAt, job.snapshot.find(message => message.role === 'user').createdAt);
  assert.deepEqual(f.detail(style), beforeStyle, 'assembling the overview does not refresh other cited memories');
});

test('an understanding candidate deduplicated to an actual event never enters the overview', t => {
  const f = fixture(t);
  const style = f.seed('用户喜欢先听结论。');
  const event = f.seed('用户去年参观过南京城墙。', 'event');
  const before = f.overview();
  const job = f.queue('去年参观南京城墙那件事没变。'), plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['南京城墙'], summary: '用户去年参观过南京城墙。', ...f.evidence(job) });
  const result = f.commit(job, plan);
  assert.deepEqual(result.createdIds, []);
  assert.deepEqual(result.exactDuplicates, [{ createIndex: 0, memoryId: event }]);
  assert.equal(f.detail(event).kind, 'event');
  assert.deepEqual(f.overview().memoryIds, [style]);
  assert.deepEqual(f.overview(), before);
  assert.notEqual(result.overviewFallback, true);
});

test('an explicitly empty overview remains empty even when a new understanding is committed', t => {
  const f = fixture(t);
  f.seed('用户喜欢白茶。');
  const job = f.queue('我最近在长期学习日语。'), plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['日语'], summary: '用户正在长期学习日语。', ...f.evidence(job) });
  plan.overview = { summary: '', memoryIds: [], createIndexes: [] };
  const result = f.commit(job, plan);
  assert.equal(result.createdIds.length, 1);
  assert.notEqual(result.overviewFallback, true);
  assert.deepEqual(f.overview().memoryIds, []);
  assert.equal(f.overview().summary, '');
});

test('pure event changes with null overview do not rewrite the existing overview', t => {
  const f = fixture(t);
  f.seed('用户喜欢简短回复。');
  const before = f.overview();
  const job = f.queue('昨天我参加了学校运动会。'), plan = empty();
  plan.creates.push({ kind: 'event', topics: ['运动会'], summary: '用户昨天参加了学校运动会。', ...f.evidence(job) });
  const result = f.commit(job, plan);
  assert.equal(result.overviewUpdated, false);
  assert.notEqual(result.overviewFallback, true);
  assert.deepEqual(f.overview(), before);
});

test('an understanding dropped by review contributes no fallback source or overview change', t => {
  const f = fixture(t);
  f.seed('用户喜欢先听结论。');
  const before = f.overview();
  const job = f.queue('我是谁？昨天我确实玩了一次词汇游戏。'), draft = empty();
  draft.creates.push({ kind: 'understanding', topics: ['错误年龄'], summary: '用户今年八岁。', ...f.evidence(job) },
    { kind: 'event', topics: ['词汇游戏'], summary: '用户昨天玩了一次词汇游戏。', ...f.evidence(job) });
  const reviewed = applyMemoryReview({ reviews: [
    { channel: 'creates', index: 0, decision: 'drop' },
    { channel: 'creates', index: 1, decision: 'keep' },
  ] }, draft);
  const result = f.commit(job, reviewed);
  assert.equal(result.createdIds.length, 1);
  assert.equal(f.detail(result.createdIds[0]).kind, 'event');
  assert.deepEqual(f.overview(), before);
  assert.notEqual(result.overviewFallback, true);
  assert(!f.store.allMemories(f.child.id, f.agentId).some(memory => memory.summary.includes('八岁')));
});
