import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../lib/store.mjs';

const empty = () => ({ creates: [], updates: [], mentions: [], retractions: [], overview: null });
function fixture(t) {
  const store = new ChatStore(':memory:');
  t.after(() => store.close());
  const child = store.createChild({ name: '测试用户', age: 28, interests: [] }, '2024-01-01T00:00:00Z');
  const agentId = 'test-soul';
  const queue = (texts, at = '2026-11-12T00:00:00Z') => {
    const run = store.beginChat({ childId: child.id, agentId, messages: texts.map(text => ({ text })), requestId: randomUUID() }, at, 900_000);
    store.finishChat(run, { reply: '好。' }, at);
    store.manuallyOpen(child.id, agentId, at);
    return store.claimJob(at);
  };
  const base = queue(['过去聊过的一些事情。'], '2024-01-01T00:00:00Z');
  store.commitJob(base, empty(), '2024-01-01T01:00:00Z');
  const seed = ({ id = randomUUID(), kind = 'event', state = 'active', summary = '用户记得这件事情。',
    at = '2025-06-01T00:00:00Z', createdAt = '2024-01-01T00:00:00Z', detail = {}, agent = agentId } = {}) => {
    const anchor = base.snapshot.find(message => message.role === 'user');
    store.sql(`INSERT INTO memories(id,child_id,agent_id,session_id,anchor_id,source_ids,mentioned_at,mentioned_on,
      summary,detail,committed_at,version,state,kind,topics,created_at,last_mentioned_at,content_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`).run(id, child.id, agent, base.session_id, anchor.id,
      JSON.stringify([anchor.id]), at, at.slice(0, 10), summary, JSON.stringify(detail), createdAt, state, kind,
      '[]', createdAt, at, at);
    store.sql(`INSERT INTO memory_mentions(memory_id,anchor_id,session_id,source_ids,mentioned_at,mentioned_on,operation)
      VALUES(?,?,?,?,?,?,'create')`).run(id, anchor.id, base.session_id, JSON.stringify([anchor.id]), at, at.slice(0, 10));
    return id;
  };
  const refs = (job, index = 0) => {
    const anchor = job.snapshot.filter(message => message.role === 'user')[index];
    return { anchorMessageId: anchor.id, sourceMessageIds: [anchor.id] };
  };
  return { store, child, agentId, queue, seed, refs };
}

test('same-call overview resolves new understanding IDs and remains isolated by Soul', t => {
  const f = fixture(t), job = f.queue(['以后叫我阿澈。']);
  const plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['称呼'], summary: '用户希望被称呼为阿澈。', ...f.refs(job) });
  plan.overview = { summary: '用户希望被称呼为阿澈。', memoryIds: [], createIndexes: [0] };
  const context = f.store.memoryInput(f.child.id, f.agentId, job.snapshot);
  f.store.recordMemoryInput(job, context);
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z', { revision: context.revision });
  assert.equal(result.createdIds.length, 1);
  assert.deepEqual(f.store.userOverview(f.child.id, f.agentId).memoryIds, result.createdIds);
  assert.match(f.store.userOverview(f.child.id, f.agentId).summary, /阿澈/);
  assert.equal(f.store.userOverview(f.child.id, 'other-soul').summary, '');
  assert.equal(f.store.jobList(f.child.id, f.agentId)[0].result.counts.created, 1);
  assert.equal(f.store.jobList(f.child.id, f.agentId)[0].input.revision, 0);
});

test('effective overview uses only cited atomic understandings even when the model paragraph includes an event', t => {
  const f = fixture(t), job = f.queue(['以后叫我小澈，我昨天还去南京城墙走错出口了。']);
  const plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['称呼'], summary: '用户希望被称呼为小澈。', ...f.refs(job) });
  plan.creates.push({ kind: 'event', topics: ['南京城墙'], summary: '用户昨天在南京城墙走错出口。', ...f.refs(job) });
  plan.overview = { summary: '用户希望被称呼为小澈，昨天在南京城墙走错出口。', memoryIds: [], createIndexes: [0] };
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  const overview = f.store.userOverview(f.child.id, f.agentId);
  assert.equal(overview.summary, '用户希望被称呼为小澈。');
  assert.deepEqual(overview.memoryIds, [result.createdIds[0]]);
  const stored = f.store.sql('SELECT summary,memory_ids FROM user_overviews WHERE child_id=? AND agent_id=?').get(f.child.id, f.agentId);
  assert.equal(stored.summary, overview.summary);
  assert.deepEqual(JSON.parse(stored.memory_ids), overview.memoryIds);
  assert.match(f.store.jobList(f.child.id, f.agentId)[0].result.plan.overview.summary, /南京城墙/);
  f.store.sql('UPDATE user_overviews SET summary=? WHERE child_id=? AND agent_id=?')
    .run('这段旧自由文本不应进入上下文。', f.child.id, f.agentId);
  assert.equal(f.store.userOverview(f.child.id, f.agentId).summary, '用户希望被称呼为小澈。');
});

test('withdrawn nickname cannot survive as a negative aside in the model overview while remaining preferences stay', t => {
  const f = fixture(t);
  const nickname = f.seed({ kind: 'understanding', summary: '用户希望被称呼为阿澈。' });
  const tea = f.seed({ kind: 'understanding', summary: '用户的饮品偏好是桂花乌龙。' });
  const style = f.seed({ kind: 'understanding', summary: '用户喜欢先听结论，再按需要看解释。' });
  f.store.sql('INSERT INTO user_overviews(child_id,agent_id,summary,memory_ids,version) VALUES(?,?,?,?,1)')
    .run(f.child.id, f.agentId, '用户希望叫阿澈，喜欢桂花乌龙和先听结论。', JSON.stringify([nickname, tea, style]));
  const job = f.queue(['忘掉阿澈这个称呼，饮品和说话习惯保持不变。']);
  const plan = empty();
  plan.retractions.push({ memoryId: nickname, reason: '用户明确要求忘记该称呼。', ...f.refs(job) });
  plan.overview = { summary: '用户不再叫阿澈，饮品偏好是桂花乌龙，喜欢先听结论。', memoryIds: [tea, style], createIndexes: [] };
  f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  const overview = f.store.userOverview(f.child.id, f.agentId);
  assert.doesNotMatch(overview.summary, /阿澈/);
  assert.equal(overview.summary, '用户的饮品偏好是桂花乌龙。\n用户喜欢先听结论，再按需要看解释。');
  assert.deepEqual(overview.memoryIds, [tea, style]);
  assert.equal(f.store.memoryDetail(nickname, f.child.id, f.agentId), null);
});

test('overview budget includes complete atomic entries only and stores exactly their source IDs', t => {
  const f = fixture(t);
  const tooLong = f.seed({ kind: 'understanding', summary: '用户偏好' + '甲'.repeat(1300) + '。' });
  const firstText = '用户偏好' + '乙'.repeat(595) + '。';
  const secondText = '用户习惯' + '丙'.repeat(595) + '。';
  assert.equal(firstText.length, 600);
  const first = f.seed({ kind: 'understanding', summary: firstText });
  const second = f.seed({ kind: 'understanding', summary: secondText });
  const lastText = '用户希望周末安静阅读。';
  const last = f.seed({ kind: 'understanding', summary: lastText });
  const job = f.queue(['这些长期了解仍然成立。']);
  const plan = empty();
  plan.overview = { summary: '模型选择了一组长期了解。', memoryIds: [tooLong, first, second, last], createIndexes: [] };
  f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  const overview = f.store.userOverview(f.child.id, f.agentId);
  assert.equal(overview.summary, firstText + '\n' + lastText);
  assert(overview.summary.length <= 1200);
  assert.deepEqual(overview.memoryIds, [first, last]);
  const stored = f.store.sql('SELECT summary,memory_ids FROM user_overviews WHERE child_id=? AND agent_id=?').get(f.child.id, f.agentId);
  assert.equal(stored.summary, overview.summary);
  assert.deepEqual(JSON.parse(stored.memory_ids), [first, last]);
});

test('a repeated oldest memory refreshes to the last user message and survives capacity archival', t => {
  const f = fixture(t);
  const repeated = f.seed({ id: 'repeat', summary: '用户每周六上午练大提琴。', at: '2025-01-01T00:00:00Z' });
  f.seed({ id: 'oldest', summary: '用户收藏一张唱片封套。', at: '2025-01-02T00:00:00Z' });
  for (let i = 0; i < 498; i++) f.seed({ id: 'filler-' + i, summary: '用户保存作品' + i });
  const job = f.queue(['我周六上午还是练大提琴。', '再说一句，拉琴仍是周六上午。']);
  const users = job.snapshot.filter(message => message.role === 'user');
  // Explicitly distinguish last user-message time from extraction time.
  users[0].createdAt = '2026-11-11T15:55:00Z'; users[1].createdAt = '2026-11-11T16:13:00Z';
  f.store.sql('UPDATE jobs SET source_snapshot=? WHERE session_id=?').run(JSON.stringify(job.snapshot), job.session_id);
  const plan = empty();
  plan.mentions.push({ memoryId: repeated, anchorMessageId: users[1].id, sourceMessageIds: users.map(user => user.id) });
  plan.creates.push({ kind: 'event', topics: ['骑行'], summary: '用户今天骑行到了江边。', ...f.refs(job, 1) });
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  assert.deepEqual(result.archivedIds, ['oldest']);
  assert.equal(f.store.memoryDetail(repeated, f.child.id, f.agentId).lastMentionedAt, users[1].createdAt);
  assert.equal(f.store.memoryCounts(f.child.id, f.agentId).active, 500);
});

test('all read paths and candidate loading leave mention time and archive state unchanged', t => {
  const f = fixture(t), id = f.seed({ state: 'archived', summary: '用户收藏南京城墙图录。' });
  const before = f.store.memoryDetail(id, f.child.id, f.agentId);
  f.store.allMemories(f.child.id, f.agentId);
  f.store.recall(f.child.id, f.agentId, { query: '南京城墙' });
  f.store.userOverview(f.child.id, f.agentId);
  f.store.memoryInput(f.child.id, f.agentId, [{ role: 'user', text: '南京城墙' }]);
  f.store.recent(f.child.id, f.agentId, '2026-11-12T00:00:00Z');
  const after = f.store.memoryDetail(id, f.child.id, f.agentId);
  assert.deepEqual(after, before);
  assert.equal(f.store.memoryRevision(f.child.id, f.agentId), 0);
});

test('same-timestamp consecutive user messages choose the last snapshot position as anchor', t => {
  const f = fixture(t), id = f.seed({ summary: '用户每周六上午练大提琴。' });
  const job = f.queue(['周六上午拉琴这事没变。', '对，仍然是周六上午。']);
  const users = job.snapshot.filter(message => message.role === 'user');
  assert.equal(users[0].createdAt, users[1].createdAt);
  const plan = empty();
  plan.mentions.push({ memoryId: id, anchorMessageId: users[0].id, sourceMessageIds: users.map(user => user.id) });
  assert.throws(() => f.store.commitJob(job, plan, '2026-11-12T09:00:00Z'), /最后一条/);
  plan.mentions[0].anchorMessageId = users[1].id;
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  assert.equal(result.committed, true);
  assert.equal(f.store.memoryDetail(id, f.child.id, f.agentId).anchorMessageId, users[1].id);
});

test('global exact duplicate fallback activates an archived ID without creating a copy', t => {
  const f = fixture(t), id = f.seed({ state: 'archived', kind: 'understanding', summary: '用户喜欢 Rust。' });
  const job = f.queue(['我喜欢 Rust 这点没变。']);
  const plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['Rust'], summary: '  用户喜欢 Ｒｕｓｔ。  ', ...f.refs(job) });
  plan.overview = { summary: '用户喜欢 Rust。', memoryIds: [], createIndexes: [0] };
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  assert.deepEqual(result.createdIds, []);
  assert.deepEqual(result.reactivatedIds, [id]);
  assert.equal(f.store.allMemories(f.child.id, f.agentId).length, 1);
  assert.equal(f.store.memoryDetail(id, f.child.id, f.agentId).state, 'active');
});

test('updates retain original detail and dates, with sourced history separate from current summary', t => {
  const f = fixture(t), id = f.seed({ summary: '六月十号在杭州骑行后修车。',
    detail: { occurredAt: '2026-06-10', sequence: '从西湖东岸出发。', notes: '原来没有说明坏了哪里。' } });
  const job = f.queue(['那次在断桥边摔坏的是车铃，人没有受伤。']);
  const plan = empty();
  plan.updates.push({ memoryId: id, changeType: 'supplement', summary: '六月十号在杭州骑行摔坏了车铃，人未受伤，随后修车。',
    detailDelta: { place: '杭州断桥边', notes: '车铃损坏，人未受伤。' }, ...f.refs(job) });
  f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  const current = f.store.memoryDetail(id, f.child.id, f.agentId);
  assert.equal(current.detail.occurredAt, '2026-06-10');
  assert.equal(current.detail.sequence, '从西湖东岸出发。');
  assert.equal(current.detailChanges[0].detailDelta.place, '杭州断桥边');
  assert.equal(current.summaryHistory[0].summary, '六月十号在杭州骑行后修车。');
  assert.equal(current.version, 2);
});

test('retracting an archived understanding never activates it and clears its old overview from valid sources', t => {
  const f = fixture(t), id = f.seed({ kind: 'understanding', state: 'archived', summary: '用户养了一只叫雾豆的猫。' });
  f.store.sql('INSERT INTO user_overviews(child_id,agent_id,summary,memory_ids,version) VALUES(?,?,?,?,1)')
    .run(f.child.id, f.agentId, '用户养雾豆猫。', JSON.stringify([id]));
  const job = f.queue(['我没有养雾豆猫，忘掉那条。']);
  const plan = empty();
  plan.retractions.push({ memoryId: id, reason: '用户明确说明是错记并要求忘记。', ...f.refs(job) });
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  assert.deepEqual(result.reactivatedIds, []);
  assert.equal(f.store.memoryDetail(id, f.child.id, f.agentId), null);
  assert.equal(f.store.recall(f.child.id, f.agentId, { query: '雾豆' }).status, 'no_match');
  assert.equal(f.store.userOverview(f.child.id, f.agentId).summary, '');
  assert.equal(f.store.userOverview(f.child.id, f.agentId).stale, false);
  assert.equal(result.overviewFallback, true);
  assert.match(f.store.memoryDetail(id, f.child.id, f.agentId, { includeRetracted: true }).retractionReason, /忘记/);
});

test('a later explicit new assertion does not resurrect the withdrawn record ID', t => {
  const f = fixture(t), id = f.seed({ state: 'retracted', summary: '用户周二游泳。' });
  const job = f.queue(['我现在周二游泳。']);
  const plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['游泳'], summary: '用户周二游泳。', ...f.refs(job) });
  plan.overview = { summary: '用户周二游泳。', memoryIds: [], createIndexes: [0] };
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  assert.equal(result.createdIds.length, 1);
  assert.notEqual(result.createdIds[0], id);
  assert.equal(f.store.memoryDetail(id, f.child.id, f.agentId, { includeRetracted: true }).state, 'retracted');
});

test('invalid anchors, cross-Soul IDs and conflicting operations roll back the entire job', t => {
  const f = fixture(t), foreign = f.seed({ agent: 'other-soul' }), local = f.seed();
  const job = f.queue(['一条用户消息。']);
  const assistant = job.snapshot.find(message => message.role === 'assistant');
  const badPlans = [];
  let plan = empty(); plan.mentions.push({ memoryId: local, anchorMessageId: assistant.id, sourceMessageIds: [assistant.id] }); badPlans.push(plan);
  plan = empty(); plan.mentions.push({ memoryId: foreign, ...f.refs(job) }); badPlans.push(plan);
  plan = empty(); plan.mentions.push({ memoryId: local, ...f.refs(job) }); plan.retractions.push({ memoryId: local, reason: '撤回', ...f.refs(job) }); badPlans.push(plan);
  for (const bad of badPlans) {
    assert.throws(() => f.store.commitJob(job, bad, '2026-11-12T09:00:00Z'));
    assert.equal(f.store.memoryRevision(f.child.id, f.agentId), 0);
  }
  assert.equal(f.store.jobList(f.child.id, f.agentId)[0].status, 'running');
});

test('scope revision conflict and old content conflicts do not overwrite newer facts or trigger another call', t => {
  const f = fixture(t), id = f.seed({ kind: 'understanding', summary: '用户喝咖啡。' });
  const older = f.queue(['我现在喝红茶。'], '2026-11-11T00:00:00Z');
  const context = f.store.memoryInput(f.child.id, f.agentId, older.snapshot);
  const newer = f.queue(['我现在喝白茶。'], '2026-11-12T00:00:00Z');
  const fresh = empty(); fresh.updates.push({ memoryId: id, changeType: 'correction', summary: '用户现在喝白茶。', ...f.refs(newer) });
  fresh.overview = { summary: '用户现在喝白茶。', memoryIds: [id], createIndexes: [] };
  f.store.commitJob(newer, fresh, '2026-11-12T09:00:00Z');
  const stale = empty(); stale.updates.push({ memoryId: id, changeType: 'correction', summary: '用户现在喝红茶。', ...f.refs(older) });
  assert.throws(() => f.store.commitJob(older, stale, '2026-11-12T10:00:00Z', { revision: context.revision }), e => e.code === 'MEMORY_REVISION_CONFLICT');
  assert.throws(() => f.store.commitJob(older, stale, '2026-11-12T10:00:00Z', { revision: 1 }), e => e.code === 'MEMORY_CONTENT_CONFLICT');
  assert.equal(f.store.memoryDetail(id, f.child.id, f.agentId).summary, '用户现在喝白茶。');
});

test('duplicate job completion is idempotent for summaries, changes and mentions', t => {
  const f = fixture(t), id = f.seed();
  const job = f.queue(['补充这件事情的新结果。']);
  const plan = empty(); plan.updates.push({ memoryId: id, changeType: 'supplement', summary: '用户这件事情已经完成。', detailDelta: { notes: '事情已完成。' }, ...f.refs(job) });
  f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  const again = f.store.commitJob(job, plan, '2026-11-12T10:00:00Z');
  assert.equal(again.replay, true);
  const item = f.store.memoryDetail(id, f.child.id, f.agentId);
  assert.equal(item.detailChanges.length, 1);
  assert.equal(item.summaryHistory.length, 1);
  assert.equal(item.mentions.length, 2);
});

test('failed extraction preserves the raw response and validation context without provider credentials', t => {
  const f = fixture(t), job = f.queue(['需要诊断的用户消息。']);
  f.store.recordMemoryInput(job, { revision: 0, memoryIndex: [], overview: { summary: '' } });
  const content = '{"creates":[],"updates":[],"mentions":[],"retractions":[],"overview":null}';
  assert.equal(f.store.recordMemoryOutput(job, { content, receipt: { model: 'test-model', usage: { prompt_tokens: 123 },
    headers: { authorization: 'credential-do-not-store' }, apiKey: 'credential-do-not-store' },
    metrics: { elapsedMs: 25, access_token: 'credential-do-not-store' }, apiKey: 'credential-do-not-store' }), true);
  f.store.failJob(job, '模型选用了助手作为锚点。', '2026-11-12T09:00:00Z', {
    validationContext: { stage: 'source-validation', anchorMessageId: job.snapshot.at(-1).id,
      authorization: 'credential-do-not-store' },
  });
  const saved = f.store.jobList(f.child.id, f.agentId)[0];
  assert.equal(saved.status, 'failed');
  assert.equal(saved.output.content, content);
  assert.equal(saved.output.receipt.usage.prompt_tokens, 123);
  assert.equal(saved.result.validationContext.stage, 'source-validation');
  assert.doesNotMatch(JSON.stringify(saved), /credential-do-not-store/);
  assert.equal(f.store.memoryCounts(f.child.id, f.agentId).active, 0);
});

test('two-stage memory output preserves extraction and scoped review evidence', t => {
  const f = fixture(t), job = f.queue(['要提取与核对的用户消息。']);
  const extraction = { content: 'initial extraction', receipt: { model: 'extract-model', usage: { prompt_tokens: 123 } }, metrics: { elapsedMs: 10 } };
  assert.equal(f.store.recordMemoryOutput(job, extraction), true);
  assert.equal(f.store.recordMemoryOutput({ ...job, child_id: 'other-user' }, { content: 'foreign review' }, { stage: 'review' }), false);
  assert.equal(f.store.recordMemoryOutput({ ...job, agent_id: 'other-soul' }, { content: 'foreign review' }, { stage: 'review' }), false);
  assert.throws(() => f.store.recordMemoryOutput(job, { content: 'invalid stage' }, { stage: 'other' }), error => error.status === 400);
  assert.equal(f.store.recordMemoryOutput(job, {
    content: 'fact review', receipt: { model: 'review-model', usage: { prompt_tokens: 12 }, nested: { authorization: 'credential-do-not-store' } },
    metrics: { elapsedMs: 5, nested: [{ api_key: 'credential-do-not-store', count: 1 }] },
  }, { stage: 'review' }), true);
  const output = f.store.jobList(f.child.id, f.agentId)[0].output;
  assert.equal(output.content, extraction.content);
  assert.deepEqual(output.receipt, extraction.receipt);
  assert.deepEqual(output.metrics, extraction.metrics);
  assert.deepEqual(output.stages.extraction, extraction);
  assert.equal(output.stages.review.content, 'fact review');
  assert.equal(output.stages.review.receipt.model, 'review-model');
  assert.equal(output.stages.review.receipt.usage.prompt_tokens, 12);
  assert.doesNotMatch(JSON.stringify(output), /credential-do-not-store|foreign review/);
  f.store.failJob(job, '核对失败', '2026-11-12T09:00:00Z');
  assert.equal(f.store.recordMemoryOutput(job, { content: 'late review' }, { stage: 'review' }), false);
  assert.deepEqual(f.store.jobList(f.child.id, f.agentId)[0].output, output);
});

test('review appends to a legacy top-level extraction snapshot without replacing it', t => {
  const f = fixture(t), job = f.queue(['兼容已有审计快照。']);
  const legacy = { content: 'legacy extraction', receipt: { model: 'old-model' }, metrics: null };
  f.store.sql('UPDATE jobs SET output_snapshot=? WHERE session_id=?').run(JSON.stringify(legacy), job.session_id);
  f.store.recordMemoryOutput(job, { content: 'new review' }, { stage: 'review' });
  const output = f.store.jobList(f.child.id, f.agentId)[0].output;
  assert.equal(output.content, legacy.content);
  assert.deepEqual(output.stages.extraction, legacy);
  assert.equal(output.stages.review.content, 'new review');
});

test('repair and validation diagnostics append without replacing original output or historical review evidence', t => {
  const f = fixture(t), job = f.queue(['这份原始会话需要修正一次。']);
  const extraction = { content: 'first invalid JSON', receipt: { model: 'memory-model' }, metrics: { elapsedMs: 1 } };
  f.store.recordMemoryOutput(job, extraction);
  const failure = Object.assign(new Error('首次重复操作'), { validationContext: {
    memoryId: 'old-memory', channel: 'mentions', nested: { api_key: 'credential-do-not-store', index: 2 },
  } });
  assert.equal(f.store.recordMemoryValidationFailure({ ...job, child_id: 'other-user' },
    { stage: 'extraction', error: failure }, '2026-11-12T09:00:00Z'), false);
  assert.equal(f.store.recordMemoryValidationFailure({ ...job, agent_id: 'other-soul' },
    { stage: 'extraction', error: failure }, '2026-11-12T09:00:00Z'), false);
  assert.throws(() => f.store.recordMemoryValidationFailure(job, { stage: 'other', error: failure },
    '2026-11-12T09:00:00Z'), error => error.status === 400);
  assert.equal(f.store.recordMemoryValidationFailure(job, { stage: 'extraction', error: failure }, '2026-11-12T09:00:00Z'), true);
  const repair = { content: 'repair JSON', receipt: { model: 'memory-model' }, metrics: { elapsedMs: 2 } };
  assert.equal(f.store.recordMemoryOutput(job, repair, { stage: 'repair' }), true);
  f.store.recordMemoryOutput(job, { content: 'retained legacy review' }, { stage: 'review' });
  f.store.recordMemoryValidationFailure(job, { stage: 'repair', error: new Error('修正仍未通过') }, '2026-11-12T09:00:01Z');
  const output = f.store.jobList(f.child.id, f.agentId)[0].output;
  assert.deepEqual(output.stages.extraction, extraction);
  assert.deepEqual(output.stages.repair, repair);
  assert.equal(output.stages.review.content, 'retained legacy review');
  assert.equal(output.content, extraction.content);
  assert.deepEqual(output.validationFailures.map(item => [item.stage, item.message]), [
    ['extraction', '首次重复操作'], ['repair', '修正仍未通过'],
  ]);
  assert.equal(output.validationFailures[0].validationContext.nested.index, 2);
  assert.equal(output.validationFailures[1].validationContext, null);
  assert.doesNotMatch(JSON.stringify(output), /credential-do-not-store/);
  f.store.failJob(job, '已修正1次仍失败', '2026-11-12T09:00:02Z');
  assert.equal(f.store.recordMemoryValidationFailure(job, { stage: 'repair', error: failure }, '2026-11-12T09:00:03Z'), false);
  assert.deepEqual(f.store.jobList(f.child.id, f.agentId)[0].output, output);
  f.store.retryJob(job.session_id, f.child.id, f.agentId, '2026-11-12T09:01:00Z');
  const retried = f.store.jobList(f.child.id, f.agentId)[0];
  assert.equal(retried.output, null);
  assert.deepEqual(retried.attempts[0].output, output, 'an explicit retry archives both responses and both diagnoses');
});

test('explicit failed-job retry keeps attempt evidence and frozen source, without duplicate queuing', t => {
  const f = fixture(t), job = f.queue(['手动重试仍用这份冻结会话。']);
  const sourceBefore = f.store.sql('SELECT source_snapshot FROM jobs WHERE session_id=?').get(job.session_id).source_snapshot;
  f.store.recordMemoryInput(job, { revision: 0, memoryIndex: [] });
  f.store.recordMemoryOutput(job, { content: 'first raw response', receipt: { model: 'test-model' }, metrics: { elapsedMs: 1 } });
  f.store.recordMemoryOutput(job, { content: 'first review response', receipt: { model: 'review-model' }, metrics: { elapsedMs: 2 } }, { stage: 'review' });
  f.store.failJob(job, '第一次来源校验失败', '2026-11-12T09:00:00Z', { validationContext: { phase: 'validation' } });
  assert.throws(() => f.store.retryJob(job.session_id, f.child.id, 'other-soul', '2026-11-12T09:01:00Z'), error => error.status === 404);
  const retried = f.store.retryJob(job.session_id, f.child.id, f.agentId, '2026-11-12T09:01:00Z');
  assert.deepEqual(retried, { sessionId: job.session_id, status: 'queued', attempts: 1 });
  let saved = f.store.jobList(f.child.id, f.agentId)[0];
  assert.equal(saved.status, 'queued');
  assert.equal(saved.input, null); assert.equal(saved.output, null); assert.equal(saved.result, null);
  assert.equal(saved.startedAt, null); assert.equal(saved.finishedAt, null); assert.equal(saved.error, null);
  assert.equal(saved.attempts[0].output.content, 'first raw response');
  assert.equal(saved.attempts[0].output.stages.extraction.content, 'first raw response');
  assert.equal(saved.attempts[0].output.stages.review.content, 'first review response');
  assert.equal(saved.attempts[0].output.stages.review.receipt.model, 'review-model');
  assert.equal(saved.attempts[0].result.validationContext.phase, 'validation');
  assert.equal(saved.attempts[0].error, '第一次来源校验失败');
  assert.equal(f.store.sql('SELECT source_snapshot FROM jobs WHERE session_id=?').get(job.session_id).source_snapshot, sourceBefore);
  assert.throws(() => f.store.retryJob(job.session_id, f.child.id, f.agentId, '2026-11-12T09:02:00Z'), error => error.status === 409);
  const again = f.store.claimJob('2026-11-12T09:02:00Z');
  assert.equal(again.session_id, job.session_id);
  assert.deepEqual(again.snapshot, job.snapshot);
  assert.throws(() => f.store.retryJob(job.session_id, f.child.id, f.agentId, '2026-11-12T09:03:00Z'), error => error.status === 409);
  f.store.recordMemoryOutput(again, { content: 'second raw response' });
  f.store.commitJob(again, empty(), '2026-11-12T09:04:00Z');
  saved = f.store.jobList(f.child.id, f.agentId)[0];
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.output.content, 'second raw response');
  assert.equal(saved.output.stages.extraction.content, 'second raw response');
  assert.equal(saved.output.stages.review, undefined);
  assert.equal(saved.attempts[0].output.stages.review.content, 'first review response');
  assert.throws(() => f.store.retryJob(job.session_id, f.child.id, f.agentId, '2026-11-12T09:05:00Z'), error => error.status === 409);
  assert.equal(f.store.memoryRevision(f.child.id, f.agentId), 0);
});

test('diagnostic writes and failure status changes cannot alter another user or Soul job', t => {
  const f = fixture(t), job = f.queue(['原始消息。']);
  const foreign = { ...job, agent_id: 'other-soul' };
  assert.equal(f.store.recordMemoryOutput(foreign, { content: 'wrong scope' }), false);
  f.store.failJob(foreign, 'wrong scope', '2026-11-12T09:00:00Z', { validationContext: { wrong: true } });
  const saved = f.store.jobList(f.child.id, f.agentId)[0];
  assert.equal(saved.status, 'running'); assert.equal(saved.output, null); assert.equal(saved.result, null);
});

test('recall retains the original chat-date lookup after a later remention', t => {
  const f = fixture(t), id = f.seed({ summary: '用户去过南京城墙。', at: '2025-10-04T00:00:00Z' });
  const job = f.queue(['南京城墙那次我还记得。']);
  const plan = empty(); plan.mentions.push({ memoryId: id, ...f.refs(job) });
  f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  assert.equal(f.store.recall(f.child.id, f.agentId, { query: '南京城墙', fromDate: '2025-10-04', toDate: '2025-10-04' }).items[0].memoryId, id);
  assert.equal(f.store.recall(f.child.id, f.agentId, { query: '南京城墙', fromDate: '2025-10-05', toDate: '2025-10-05' }).status, 'no_match');
});

test('overview cannot reference an event, missing record, withdrawn record or nonexistent create index', t => {
  const f = fixture(t), event = f.seed(), withdrawn = f.seed({ kind: 'understanding', state: 'retracted' });
  const job = f.queue(['一些消息。']);
  for (const overview of [
    { summary: '错误概括', memoryIds: [event], createIndexes: [] },
    { summary: '错误概括', memoryIds: ['missing'], createIndexes: [] },
    { summary: '错误概括', memoryIds: [withdrawn], createIndexes: [] },
    { summary: '错误概括', memoryIds: [], createIndexes: [1] },
  ]) assert.throws(() => f.store.commitJob(job, { ...empty(), overview }, '2026-11-12T09:00:00Z'), /概括/);
  assert.equal(f.store.userOverview(f.child.id, f.agentId).version, 0);
});

test('candidate selection includes relevant archive and overview references within 500, without a fixed archive quota', t => {
  const f = fixture(t);
  for (let i = 0; i < 500; i++) f.seed({ id: 'active-' + i, summary: '用户保存普通作品' + i });
  const archive = f.seed({ state: 'archived', kind: 'understanding', summary: '用户喜欢研究火星探测。' });
  f.store.sql('INSERT INTO user_overviews(child_id,agent_id,summary,memory_ids,version) VALUES(?,?,?,?,1)')
    .run(f.child.id, f.agentId, '用户喜欢研究火星探测。', JSON.stringify([archive]));
  const context = f.store.memoryInput(f.child.id, f.agentId, [{ role: 'user', text: '火星探测有什么新东西？' }]);
  assert.equal(context.memoryIndex.length, 500);
  assert(context.memoryIndex.some(item => item.id === archive && item.state === 'archived'));
  assert.equal(f.store.memoryDetail(archive, f.child.id, f.agentId).state, 'archived');
});

test('assistant context resolves a short user acknowledgement for archive retrieval without touching until user-anchored commit', t => {
  const f = fixture(t);
  for (let i = 0; i < 500; i++) f.seed({ id: 'active-' + i, summary: '用户保存普通作品' + i });
  const archive = f.seed({ state: 'archived', summary: '用户与姐姐游览南京城墙时按导航走错出口。', at: '2025-10-04T00:00:00Z' });
  const job = f.queue(['我好像想起一件事。']);
  const assistant = job.snapshot.find(message => message.role === 'assistant');
  assistant.text = '你说的是和姐姐游览南京城墙，按导航走错出口那回吗？';
  f.store.sql('UPDATE messages SET text=? WHERE id=?').run(assistant.text, assistant.id);
  const acknowledgement = { id: randomUUID(), role: 'user', text: '对，就是那次。', createdAt: '2026-11-12T00:01:00Z' };
  job.snapshot.push(acknowledgement);
  f.store.sql("INSERT INTO messages(id,session_id,role,text,created_at) VALUES(?,?,'user',?,?)")
    .run(acknowledgement.id, job.session_id, acknowledgement.text, acknowledgement.createdAt);
  f.store.sql('UPDATE jobs SET source_snapshot=? WHERE session_id=?').run(JSON.stringify(job.snapshot), job.session_id);

  const before = f.store.memoryDetail(archive, f.child.id, f.agentId);
  const userOnly = f.store.memoryInput(f.child.id, f.agentId, job.snapshot.filter(message => message.role === 'user'));
  assert(!userOnly.memoryIndex.some(item => item.id === archive));
  const fullConversation = f.store.memoryInput(f.child.id, f.agentId, job.snapshot);
  assert(fullConversation.memoryIndex.some(item => item.id === archive));
  assert.deepEqual(f.store.memoryDetail(archive, f.child.id, f.agentId), before);

  const plan = empty();
  plan.mentions.push({ memoryId: archive, anchorMessageId: assistant.id, sourceMessageIds: [assistant.id] });
  assert.throws(() => f.store.commitJob(job, plan, '2026-11-12T09:00:00Z'), /用户来源/);
  assert.deepEqual(f.store.memoryDetail(archive, f.child.id, f.agentId), before);
  plan.mentions[0] = { memoryId: archive, anchorMessageId: acknowledgement.id,
    sourceMessageIds: [assistant.id, acknowledgement.id] };
  f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  const after = f.store.memoryDetail(archive, f.child.id, f.agentId);
  assert.equal(after.state, 'active');
  assert.equal(after.lastMentionedAt, acknowledgement.createdAt);
  assert.equal(after.anchorMessageId, acknowledgement.id);
});

test('capacity sorting compares actual instants instead of textual timezone representations', t => {
  const f = fixture(t);
  f.seed({ id: 'a', at: '2025-01-01T08:00:00+08:00' });
  f.seed({ id: 'b', at: '2025-01-01T00:30:00Z' });
  for (let i = 0; i < 498; i++) f.seed({ id: 'filler-' + i, summary: '用户保存资料' + i });
  const job = f.queue(['今天去了一次博物馆。']);
  const plan = empty(); plan.creates.push({ kind: 'event', topics: ['博物馆'], summary: '用户今天去了博物馆。', ...f.refs(job) });
  assert.deepEqual(f.store.commitJob(job, plan, '2026-11-12T09:00:00Z').archivedIds, ['a']);
});

test('500 active plus 100 archived apply additions, revivals and withdrawals before selecting exactly five oldest', t => {
  const f = fixture(t);
  const repeat = f.seed({ id: 'repeat', at: '2025-01-01T00:00:00Z' });
  const oldest = Array.from({ length: 5 }, (_, i) => f.seed({ id: 'old-' + i, at: `2025-01-0${i + 2}T00:00:00Z`, summary: '旧事件' + i }));
  const retract = f.seed({ id: 'wrong-cat', summary: '用户养了一只猫。' });
  for (let i = 0; i < 493; i++) f.seed({ id: 'active-' + i, summary: '普通事件' + i });
  const archives = Array.from({ length: 100 }, (_, i) => f.seed({ id: 'archive-' + i, state: 'archived', summary: '历史事件' + i }));
  const job = f.queue(['重复旧事，三个历史事件也重新聊到；新增三件事情，猫和最后一个历史事件都是错记。']);
  const plan = empty();
  plan.mentions = [repeat, ...archives.slice(0, 3)].map(memoryId => ({ memoryId, ...f.refs(job) }));
  plan.retractions = [retract, archives.at(-1)].map(memoryId => ({ memoryId, reason: '用户明确撤回错误记忆。', ...f.refs(job) }));
  plan.creates = Array.from({ length: 3 }, (_, i) => ({ kind: 'event', topics: ['新事件'], summary: '新事件' + i, ...f.refs(job) }));
  const result = f.store.commitJob(job, plan, '2026-11-12T09:00:00Z');
  assert.deepEqual(result.archivedIds.sort(), oldest.sort());
  assert.deepEqual(result.reactivatedIds.sort(), archives.slice(0, 3).sort());
  assert.deepEqual(result.counts, { created: 3, updated: 0, mentioned: 4, retracted: 2, archived: 5, reactivated: 3, deduplicated: 0 });
  assert.deepEqual(f.store.memoryCounts(f.child.id, f.agentId), { active: 500, archived: 101, retracted: 2, activeLimit: 500 });
  assert.equal(f.store.memoryDetail(repeat, f.child.id, f.agentId).state, 'active');
});

test('opening a legacy database adds memory metadata without deleting its records', t => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-memory-v2-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite');
  const original = new ChatStore(path);
  const child = original.createChild({ name: '迁移测试', age: null, interests: [] }, '2026-01-01T00:00:00Z');
  const run = original.beginChat({ childId: child.id, agentId: 'soul', text: '我去过南京城墙。', requestId: 'migration' }, '2026-01-01T00:00:00Z', 900_000);
  original.finishChat(run, { reply: '记住这件事了。' }, '2026-01-01T00:00:01Z');
  original.manuallyOpen(child.id, 'soul', '2026-01-01T00:01:00Z');
  const job = original.claimJob('2026-01-01T00:01:01Z');
  original.commitJob(job, [{ anchorMessageId: run.userId, sourceMessageIds: [run.userId],
    summary: '用户去过南京城墙。', mentionedAt: '2026-01-01T00:00:00Z', mentionedOn: '2026-01-01' }], '2026-01-01T00:01:02Z');
  const id = original.allMemories(child.id, 'soul')[0].memoryId;
  original.db.exec('DROP TABLE memory_mentions; DROP TABLE user_overviews; DROP TABLE memory_scopes; DROP INDEX memories_by_scope_state;');
  for (const column of ['state', 'kind', 'topics', 'created_at', 'last_mentioned_at', 'content_at', 'detail_changes', 'summary_history', 'archived_at', 'retracted_at', 'retraction_reason']) {
    original.db.exec(`ALTER TABLE memories DROP COLUMN ${column}`);
  }
  original.db.exec('ALTER TABLE jobs DROP COLUMN input_context; ALTER TABLE jobs DROP COLUMN result; ALTER TABLE jobs DROP COLUMN output_snapshot; ALTER TABLE jobs DROP COLUMN attempt_history;');
  original.close();
  const migrated = new ChatStore(path);
  t.after(() => migrated.close());
  assert.equal(migrated.child(child.id).name, '迁移测试');
  const memory = migrated.memoryDetail(id, child.id, 'soul');
  assert.equal(memory.summary, '用户去过南京城墙。');
  assert.equal(memory.state, 'active');
  assert.equal(memory.kind, 'event');
  assert.equal(memory.lastMentionedAt, '2026-01-01T00:00:00Z');
  assert.equal(memory.mentions.length, 1);
});
