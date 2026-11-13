import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChatStore } from '../lib/store.mjs';

const CORE = ['children', 'sessions', 'messages', 'jobs', 'memories', 'memory_mentions', 'user_overviews', 'memory_scopes'];
const coreSnapshot = store => JSON.stringify(Object.fromEntries(CORE.map(table => [table,
  store.sql('SELECT * FROM ' + table + ' ORDER BY rowid').all()])));
const allKept = records => ({ groups: records.map(row => ({ category: 'other', representativeId: row.id, memberIds: [row.id] })), deferredIds: [] });
const now = '2026-11-12T10:00:00.000Z';

function fixture(t) {
  const store = new ChatStore(':memory:'); t.after(() => store.close());
  const child = store.createChild({ name: '概括只读投影用户', age: 9, interests: [] }, now);
  const agentId = 'brief-soul', modelName = 'brief-model';
  const texts = ['用户有学习英语的需求，曾主动向AI询问英语学习方法。',
    '用户近期正在学习英语，希望通过观看英语电影的方式辅助学习，并希望按1-10难度推荐。',
    '用户常玩《英雄联盟》（简称LoL）。', '用户昨天玩过一次英语猜词游戏。'];
  const run = store.beginChat({ childId: child.id, agentId, messages: texts.map(text => ({ text })), requestId: randomUUID() }, now, 900_000);
  store.finishChat(run, { reply: '好。' }, now); store.manuallyOpen(child.id, agentId, now);
  const job = store.claimJob(now), users = job.snapshot.filter(row => row.role === 'user');
  const result = store.commitJob(job, {
    creates: texts.map((summary, index) => ({ summary, kind: index === 3 ? 'event' : 'understanding', topics: [],
      anchorMessageId: users[index].id, sourceMessageIds: [users[index].id] })),
    updates: [], mentions: [], retractions: [], overview: { summary: texts.slice(0, 3).join('\n'), memoryIds: [], createIndexes: [0, 1, 2] },
  }, now);
  const [english, movies, lol, event] = result.createdIds;
  const options = { modelName };
  const ensure = () => store.ensureContextBrief(child.id, agentId, now, options);
  const read = () => store.readContextBrief(child.id, agentId, options);
  const sources = () => store.readBriefSources(child.id, agentId, options);
  const claim = () => store.claimContextBrief(now, options);
  const selection = { groups: [
    { category: 'goals', representativeId: movies, memberIds: [english, movies] },
    { category: 'preferences', representativeId: lol, memberIds: [lol] },
  ], deferredIds: [] };
  const complete = () => { ensure(); const task = claim(); return store.commitContextBrief(task, selection, now, options); };
  return { store, child, agentId, modelName, options, texts, english, movies, lol, event, ensure, read, sources, claim, selection, complete, sessionId: run.sessionId };
}

test('context cache merges three source selections into two views without changing original tables', t => {
  const f = fixture(t), before = coreSnapshot(f.store);
  const first = f.read(); assert.equal(first.mode, 'source_fallback'); assert.equal(first.sourceCount, 3);
  assert.equal(f.ensure().queued, true); assert.equal(f.ensure().queued, false);
  const job = f.claim(); assert.equal(job.records.length, 3); assert(!job.records.some(row => row.id === f.event));
  assert.equal(f.store.recordContextBriefOutput(job, { content: '{"selection":"raw"}',
    receipt: { api_key: 'secret', usage: { prompt_tokens: 10 }, authorization: 'secret' } }), true);
  const result = f.store.commitContextBrief(job, f.selection, now, f.options);
  assert.equal(result.committed, true); assert.equal(result.view.mode, 'cached'); assert.equal(result.view.status, 'ready');
  assert.equal(result.view.sourceCount, 3); assert.equal(result.view.itemCount, 2);
  assert.equal(result.view.memoryIds.length, 2); assert.equal(result.view.coveredMemoryIds.length, 3);
  assert(result.view.summary.includes(f.texts[1])); assert(result.view.summary.includes(f.texts[2]));
  assert(!result.view.summary.includes(f.texts[0]));
  const cached = f.store.sql('SELECT * FROM context_briefs').get();
  assert(!cached.output.includes('secret'));
  f.store.sql('UPDATE context_briefs SET result=?').run('{"summary":"模型凭空发明的内容"}');
  assert(!f.read().summary.includes('凭空发明'), 'cached paragraphs are never trusted over source selection');
  assert.equal(coreSnapshot(f.store), before);
});

test('mention timestamps, memory versions and unrelated scope revisions do not invalidate a brief', t => {
  const f = fixture(t); f.complete(); const fingerprint = f.sources().fingerprint;
  f.store.sql('UPDATE memories SET version=version+1,last_mentioned_at=? WHERE child_id=?')
    .run('2026-11-13T10:00:00.000Z', f.child.id);
  f.store.sql('UPDATE memory_scopes SET revision=revision+1 WHERE child_id=?').run(f.child.id);
  assert.equal(f.sources().fingerprint, fingerprint);
  assert.equal(f.ensure().queued, false); assert.equal(f.read().mode, 'cached'); assert.equal(f.claim(), null);
  assert.equal(f.store.sql('SELECT count(*) AS n FROM context_briefs').get().n, 1);
});

test('corrected or retracted sources immediately stop serving old cached wording', t => {
  const f = fixture(t); f.complete(); const old = f.sources().fingerprint;
  f.store.sql('UPDATE memories SET summary=? WHERE id=?').run('用户现在通过英语播客学习。', f.movies);
  const revised = f.read(); assert.notEqual(revised.fingerprint, old); assert.equal(revised.mode, 'source_fallback');
  assert(revised.summary.includes('英语播客')); assert(!revised.summary.includes('1-10'));
  assert.equal(f.ensure().queued, true);
  const job = f.claim(); f.store.commitContextBrief(job, allKept(job.records), now, f.options);
  f.store.sql("UPDATE memories SET state='retracted' WHERE id=?").run(f.lol);
  const withdrawn = f.read(); assert.equal(withdrawn.mode, 'source_fallback');
  assert(!withdrawn.summary.includes('英雄联盟'));
  assert(!withdrawn.coveredMemoryIds.includes(f.lol));
});

test('late results use a content-fingerprint compare-and-set and cannot cover a changed source', t => {
  const f = fixture(t); f.ensure(); const task = f.claim();
  f.store.sql('UPDATE memories SET summary=? WHERE id=?').run('用户改为学习日语。', f.english);
  const before = coreSnapshot(f.store);
  const result = f.store.commitContextBrief(task, f.selection, now, f.options);
  assert.deepEqual(result, { committed: false, stale: true });
  assert.equal(f.read().mode, 'source_fallback'); assert.equal(coreSnapshot(f.store), before);
  assert.equal(f.store.sql('SELECT status FROM context_briefs').get().status, 'stale');
});

test('brief output and commits stay scoped, and invalid/unknown/duplicate selections are refused', t => {
  const f = fixture(t), other = f.store.createChild({ name: '其他用户', age: 10, interests: [] }, now);
  assert.throws(() => f.store.ensureContextBrief(other.id, f.agentId, now, { ...f.options, sessionId: f.sessionId }), /不属于/);
  f.ensure(); const task = f.claim(), forged = { ...task, child_id: other.id };
  assert.equal(f.store.recordContextBriefOutput(forged, { content: 'wrong user' }), false);
  assert.equal(f.store.failContextBrief(forged, 'wrong user', now), false);
  assert.deepEqual(f.store.commitContextBrief(forged, f.selection, now, f.options), { committed: false });
  for (const invalid of [
    { groups: [{ category: 'goals', representativeId: f.movies, memberIds: [f.movies] }], deferredIds: [] },
    { groups: [...f.selection.groups], deferredIds: [f.movies] },
    { groups: [{ category: 'goals', representativeId: 'foreign', memberIds: ['foreign'] }], deferredIds: [f.english, f.movies, f.lol] },
    { groups: [{ category: 'made-up', representativeId: f.english, memberIds: [f.english, f.movies, f.lol] }], deferredIds: [] },
  ]) assert.throws(() => f.store.commitContextBrief(task, invalid, now, f.options), /概括/);
  assert.equal(f.store.sql('SELECT status FROM context_briefs').get().status, 'running');
  assert.equal(f.read().mode, 'source_fallback');
});

test('failure, restart recovery and repeated reads never automatically requeue the same fingerprint', t => {
  const f = fixture(t); f.ensure(); const task = f.claim();
  f.store.recordContextBriefOutput(task, { content: 'invalid selection', receipt: { model: f.modelName } });
  f.store.failContextBrief(task, '模型输出未通过校验', now);
  assert.equal(f.read().status, 'failed'); assert.equal(f.ensure().queued, false); assert.equal(f.claim(), null);
  f.store.sql('UPDATE memories SET summary=? WHERE id=?').run('用户在学习日语。', f.english);
  f.ensure(); const interrupted = f.claim(); assert(interrupted);
  f.store.recover(now); assert.equal(f.read().status, 'failed'); assert.equal(f.ensure().queued, false); assert.equal(f.claim(), null);
});

test('active sources survive an omitted old overview and archived cited sources do not refresh', t => {
  const f = fixture(t); f.complete(); const original = f.sources().fingerprint;
  f.store.sql("UPDATE user_overviews SET summary='',memory_ids='[]' WHERE child_id=?").run(f.child.id);
  assert.equal(f.sources().records.length, 3); assert.equal(f.sources().fingerprint, original);
  f.store.sql('UPDATE user_overviews SET memory_ids=? WHERE child_id=?').run(JSON.stringify([f.english]), f.child.id);
  const before = f.store.memoryDetail(f.english, f.child.id, f.agentId);
  f.store.sql("UPDATE memories SET state='archived' WHERE id=?").run(f.english);
  assert.equal(f.sources().fingerprint, original, 'active to valid cited archive has the same content');
  assert.equal(f.read().mode, 'cached');
  assert.equal(f.store.memoryDetail(f.english, f.child.id, f.agentId).lastMentionedAt, before.lastMentionedAt);
  assert.equal(f.store.memoryDetail(f.english, f.child.id, f.agentId).state, 'archived');
});

test('queued work for changed sources or a different current model is discarded before a paid call', t => {
  const f = fixture(t); f.ensure();
  assert.equal(f.store.claimContextBrief(now, { modelName: 'new-model' }), null);
  assert.equal(f.store.sql('SELECT status FROM context_briefs').get().status, 'stale');
  assert.equal(f.store.ensureContextBrief(f.child.id, f.agentId, now, { modelName: 'new-model' }).queued, true);
  f.store.sql('UPDATE memories SET summary=? WHERE id=?').run('用户正在学习日语。', f.english);
  assert.equal(f.store.claimContextBrief(now, { modelName: 'new-model' }), null);
});

test('no-reset mode refuses incompatible adoption before deleting any source or cache data', t => {
  const f = fixture(t); f.complete(); const before = coreSnapshot(f.store);
  assert.throws(() => f.store.activateVersion('new-version', now, { allowReset: false }), /禁止重置/);
  assert.equal(coreSnapshot(f.store), before); assert.equal(f.read().mode, 'cached');
  f.store.sql("INSERT INTO lab_meta(key,value) VALUES('data_version','old-version')").run();
  assert.throws(() => f.store.activateVersion('new-version', now, { allowReset: false }), /禁止重置/);
  assert.equal(coreSnapshot(f.store), before);
  f.store.activateVersion('new-version', now, { allowReset: false, compatibleVersions: ['old-version'] });
  assert.equal(coreSnapshot(f.store), before);
  f.store.activateVersion('new-version', now, { allowReset: false });
  assert.equal(f.store.sql("SELECT value FROM lab_meta WHERE key='data_version'").get().value, 'new-version');
});

test('a genuinely empty database may initialize without permitting deletion on a later version change', t => {
  const store = new ChatStore(':memory:'); t.after(() => store.close());
  store.activateVersion('v1', now, { allowReset: false });
  assert.equal(store.children()[0].name, '马超'); const original = coreSnapshot(store);
  assert.throws(() => store.activateVersion('v2', now, { allowReset: false }), /禁止重置/);
  assert.equal(coreSnapshot(store), original);
});
