import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../lib/store.mjs';

const now = '2026-11-13T10:00:00.000Z';
const resetAt = '2026-11-13T11:00:00.000Z';
const later = '2026-11-13T12:00:00.000Z';
const idleMs = 900_000;
const clearedTables = ['memory_mentions', 'user_overviews', 'context_briefs', 'memory_scopes',
  'memories', 'soul_profiles', 'profile_writes'];
const retainedTables = ['children', 'messages', 'runs', 'usage_records', 'agents'];
const rawRows = (store, table) => store.sql('SELECT * FROM ' + table + ' ORDER BY rowid').all();
const snapshot = (store, tables) => Object.fromEntries(tables.map(table => [table, rawRows(store, table)]));
const allTables = store => store.sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(row => row.name);

function populate(store) {
  store.initializeAgents([{ id: 'fixture-agent', name: '合成测试角色', definition: '\n保持的角色定义\n',
    metadata: { card: { theme: 'pine' }, legacySoul: { schemaVersion: 1 } }, version: 'fixture-v1' }], now, { importSeeds: true });
  store.sql("INSERT INTO lab_meta(key,value) VALUES('data_version','fixture-memory-version')").run();
  const child = store.createChild({ name: '合成测试用户', age: 25, interests: ['阅读'] }, now);
  const scope = { childId: child.id, agentId: 'fixture-agent' };
  const run = store.beginChat({ ...scope, text: '我喜欢阅读，以后叫我测试别名。', requestId: 'old-completed' }, now, idleMs);
  store.applyProfile(run, { field: 'preferred_name', operation: 'set', value: '测试别名' }, now);
  store.finishChat(run, { reply: '先记下来。\n\n好的。', parts: ['先记下来。', '好的。'] }, now);
  store.recordUsage({ key: 'old-chat', sessionId: run.sessionId, runId: run.runId, kind: 'chat',
    usageStatus: 'reported', modelCostCny: .002, toolCostCny: 0, totalCostCny: .002, knownCostCny: .002 }, now);
  store.manuallyOpen(scope.childId, scope.agentId, now);
  const job = store.claimJob(now), user = job.snapshot.find(message => message.role === 'user');
  const refs = { anchorMessageId: user.id, sourceMessageIds: [user.id] };
  store.recordMemoryInput(job, { ...store.memoryInput(scope.childId, scope.agentId, job.snapshot), diagnostic: '待清除的输入审计' });
  store.recordMemoryOutput(job, { content: '待清除的模型原始输出', receipt: { model: 'synthetic-only' } });
  const committed = store.commitJob(job, { creates: [
    { kind: 'understanding', topics: ['阅读'], summary: '用户喜欢阅读。', detail: { notes: '旧偏好详情。' }, ...refs },
    { kind: 'event', topics: ['旅行'], summary: '用户曾参加合成旅行。', detail: { place: '合成地点' }, ...refs },
    { kind: 'event', topics: ['撤回'], summary: '将撤回的合成记录。', ...refs },
  ], updates: [], mentions: [], retractions: [], overview: { summary: '用户喜欢阅读。', memoryIds: [], createIndexes: [0] } }, now);
  store.sql("UPDATE memories SET state='archived',archived_at=? WHERE id=?").run(now, committed.createdIds[1]);
  store.sql("UPDATE memories SET state='retracted',retracted_at=? WHERE id=?").run(now, committed.createdIds[2]);
  store.recordUsage({ key: 'old-memory', sessionId: run.sessionId, kind: 'memory', name: 'extraction',
    usageStatus: 'reported', modelCostCny: .003, toolCostCny: 0, totalCostCny: .003, knownCostCny: .003 }, now);
  store.ensureContextBrief(scope.childId, scope.agentId, now, { modelName: 'synthetic-only', sessionId: run.sessionId });

  const failedRun = store.beginChat({ ...scope, text: '第二条合成旧消息。', requestId: 'old-failed' }, now, idleMs);
  store.finishChat(failedRun, { reply: '旧回答。' }, now);
  store.manuallyOpen(scope.childId, scope.agentId, now);
  const failedJob = store.claimJob(now);
  store.recordMemoryInput(failedJob, { memoryIndex: [{ summary: '待清除的候选摘要' }], revision: store.memoryRevision(scope.childId, scope.agentId) });
  store.recordMemoryOutput(failedJob, { content: '待清除的失败输出' });
  store.failJob(failedJob, '合成失败诊断', now);
  store.sql('UPDATE jobs SET attempt_history=? WHERE session_id=?')
    .run(JSON.stringify([{ input: { memoryIndex: ['旧输入'] }, output: { content: '旧尝试输出' }, result: { plan: '旧计划' } }]), failedRun.sessionId);

  const queuedRun = store.beginChat({ ...scope, text: '第三条合成旧消息。', requestId: 'old-queued' }, now, idleMs);
  store.finishChat(queuedRun, { reply: '待整理的旧回答。' }, now);
  const emptySession = store.manuallyOpen(scope.childId, scope.agentId, now);
  for (const session of rawRows(store, 'sessions')) {
    store.recordContext(session.id, { userOverview: '待清除的概括', toolCalls: [{ result: '待清除的工具记忆' }] });
    store.sql('UPDATE sessions SET recent_snapshot=? WHERE id=?').run('[{"summary":"待清除的最近记忆"}]', session.id);
  }
  return { store, child, scope, run, failedRun, queuedRun, emptySession, committed };
}

function fixture(t) {
  const store = new ChatStore(':memory:');
  t.after(() => store.close());
  return populate(store);
}

for (const kind of ['runs', 'jobs', 'context_briefs']) {
  test('atomically refuses a reset while ' + kind + ' has a running task', t => {
    const f = fixture(t), { store } = f;
    if (kind === 'runs') store.beginChat({ ...f.scope, text: '仍在生成的合成消息。', requestId: 'running' }, now, idleMs);
    else if (kind === 'jobs') assert(store.claimJob(now));
    else assert(store.claimContextBrief(now, { modelName: 'synthetic-only' }));
    const before = snapshot(store, allTables(store));
    assert.throws(() => store.clearMemories(resetAt), error => error.status === 409);
    assert.deepEqual(snapshot(store, allTables(store)), before);
    assert.equal(store.sql("SELECT value FROM lab_meta WHERE key='memory_reset_at'").get(), undefined);
  });
}

test('clears every memory and legacy profile, seals all old sessions and jobs, and preserves source history and billing', t => {
  const f = fixture(t), { store } = f;
  const retained = snapshot(store, retainedTables);
  const deletedCounts = Object.fromEntries(clearedTables.map(table => [table, rawRows(store, table).length]));
  assert(clearedTables.every(table => deletedCounts[table] > 0));
  const oldSessions = rawRows(store, 'sessions');
  const usageBefore = store.usage(f.run.sessionId);
  const result = store.clearMemories(resetAt);
  assert.deepEqual(result, { deleted: deletedCounts, closedSessions: oldSessions.length, sealedJobs: oldSessions.length, resetAt });
  assert.deepEqual(snapshot(store, retainedTables), retained);
  for (const table of clearedTables) assert.equal(rawRows(store, table).length, 0, table);
  assert.equal(store.agentsInitialized(), true);
  assert.equal(store.sql("SELECT value FROM lab_meta WHERE key='data_version'").get().value, 'fixture-memory-version');
  assert.equal(store.sql("SELECT value FROM lab_meta WHERE key='memory_reset_at'").get().value, resetAt);
  for (const session of rawRows(store, 'sessions')) {
    const original = oldSessions.find(row => row.id === session.id);
    assert.equal(session.status, 'closed');
    assert.equal(session.closed_at, original.closed_at ?? resetAt, 'historical closure time is preserved');
    assert.equal(session.context, null);
    assert.equal(session.recent_snapshot, null);
    assert.equal(session.title, original.title);
    assert.equal(session.updated_at, original.updated_at);
  }
  const sealed = rawRows(store, 'jobs');
  assert.equal(sealed.length, oldSessions.length, 'even the empty session gets a terminal job');
  for (const job of sealed) {
    assert.equal(job.status, 'succeeded');
    assert.equal(job.item_count, 0);
    assert.equal(job.finished_at, resetAt);
    for (const key of ['started_at', 'error', 'source_snapshot', 'input_context', 'output_snapshot']) assert.equal(job[key], null, key);
    assert.equal(job.attempt_history, '[]');
    assert.deepEqual(JSON.parse(job.result), { resetSkipped: true, resetAt });
  }
  const usageAfter = store.usage(f.run.sessionId);
  assert.equal(usageAfter.knownCostCny, usageBefore.knownCostCny);
  assert.equal(usageAfter.recordedCalls, usageBefore.recordedCalls);
  assert.equal(usageAfter.memoryCalls, usageBefore.memoryCalls);
  assert.deepEqual(usageAfter.calls, usageBefore.calls);
  assert.equal(store.usage(f.emptySession.id).untrackedMemoryJobs, 0, 'a sealed empty session did not make a model request');
  assert.equal(store.usage(f.emptySession.id).partial, false);
  assert.deepEqual(store.profile(f.child.id, f.scope.agentId).soulProfile,
    { preferred_name: null, interest: [], conversation_preference: [] });
});

test('old failed and queued jobs cannot be retried or repopulated by closeSession, closeDue or a late commit', t => {
  const f = fixture(t), { store } = f;
  const oldRows = rawRows(store, 'sessions');
  store.clearMemories(resetAt);
  const sealedBefore = rawRows(store, 'jobs');
  for (const session of oldRows) {
    assert.throws(() => store.retryJob(session.id, session.child_id, session.agent_id, later), error => error.status === 409);
    store.closeSession(session, later);
  }
  assert.equal(store.closeDue(later, idleMs), 0);
  assert.equal(store.claimJob(later), null);
  assert.deepEqual(rawRows(store, 'jobs'), sealedBefore);
  const late = store.commitJob({ session_id: f.run.sessionId, child_id: f.child.id, agent_id: f.scope.agentId },
    { creates: [], updates: [], mentions: [], retractions: [], overview: null }, later);
  assert.equal(late.committed, false);
  assert.equal(late.result.resetSkipped, true);
  assert.equal(rawRows(store, 'memories').length, 0);
});

test('new messages start a fresh session and their new memory job can extract and commit normally', t => {
  const f = fixture(t), { store } = f;
  const oldIds = new Set(rawRows(store, 'sessions').map(row => row.id));
  store.clearMemories(resetAt);
  const run = store.beginChat({ ...f.scope, sessionId: f.run.sessionId, text: '我现在喜欢学习天文。', requestId: 'new-after-reset' }, later, idleMs);
  assert(!oldIds.has(run.sessionId));
  assert.deepEqual(run.recent, []);
  assert.deepEqual(store.messages(run.sessionId).map(message => message.text), ['我现在喜欢学习天文。']);
  store.finishChat(run, { reply: '我们接着聊。' }, later);
  store.manuallyOpen(f.child.id, f.scope.agentId, later);
  const job = store.claimJob(later);
  assert.equal(job.session_id, run.sessionId);
  assert.equal(job.snapshot.filter(message => message.role === 'user').length, 1);
  const user = job.snapshot.find(message => message.role === 'user');
  const result = store.commitJob(job, { creates: [{ kind: 'understanding', topics: ['天文'], summary: '用户喜欢学习天文。',
    anchorMessageId: user.id, sourceMessageIds: [user.id] }], updates: [], mentions: [], retractions: [],
  overview: { summary: '用户喜欢学习天文。', memoryIds: [], createIndexes: [0] } }, later);
  assert.equal(result.committed, true);
  assert.equal(result.createdIds.length, 1);
  assert.equal(store.allMemories(f.child.id, f.scope.agentId)[0].summary, '用户喜欢学习天文。');
  assert.equal(store.userOverview(f.child.id, f.scope.agentId).summary, '用户喜欢学习天文。');
  assert.equal(store.claimJob(later), null);
  assert.equal(store.usage(run.sessionId).untrackedMemoryJobs, 1, 'only reset-skipped historical jobs bypass the usage warning');
});

test('a failure after deletions rolls back the entire reset rather than partially clearing data', t => {
  const { store } = fixture(t);
  store.db.exec("CREATE TRIGGER reject_fixture_job_reset BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'fixture reset failure'); END;");
  const before = snapshot(store, allTables(store));
  assert.throws(() => store.clearMemories(resetAt), /fixture reset failure/u);
  assert.deepEqual(snapshot(store, allTables(store)), before);
});

test('a cleared temporary database stays cleared after restart without requeueing historical messages', t => {
  const directory = mkdtempSync(join(tmpdir(), 'croco-clear-memories-'));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'fixture.sqlite');
  store = new ChatStore(path);
  const f = populate(store);
  const retained = snapshot(store, retainedTables);
  store.clearMemories(resetAt);
  store.close();
  store = new ChatStore(path);
  store.recover(later);
  assert.deepEqual(snapshot(store, retainedTables), retained);
  for (const table of clearedTables) assert.equal(rawRows(store, table).length, 0, table);
  assert.equal(store.agentsInitialized(), true);
  assert.equal(store.closeDue(later, idleMs), 0);
  assert.equal(store.claimJob(later), null);
  assert.throws(() => store.retryJob(f.failedRun.sessionId, f.child.id, f.scope.agentId, later), error => error.status === 409);
  const counts = store.clearMemories(later).deleted;
  assert(clearedTables.every(table => counts[table] === 0), 'repeated clearing has no remaining memory rows to delete');
});
