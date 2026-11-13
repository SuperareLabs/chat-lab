import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { createLabServer } from '../server.mjs';

const snapshot = store => JSON.stringify(Object.fromEntries(['memories', 'memory_mentions', 'user_overviews', 'memory_scopes']
  .map(table => [table, store.sql('SELECT * FROM ' + table + ' ORDER BY rowid').all()])));
const seed = (lab, scope) => {
  const now = '2026-11-12T00:00:00.000Z';
  const run = lab.store.beginChat({ ...scope, messages: [{ text: '英语和游戏。' }], requestId: crypto.randomUUID() }, now, 900000);
  lab.store.finishChat(run, { reply: '好。' }, now);
  lab.store.manuallyOpen(scope.childId, scope.agentId, now);
  const job = lab.store.claimJob(now), user = job.snapshot.find(m => m.role === 'user');
  const summaries = ['用户正在学习英语。', '用户常玩英雄联盟。', '用户正在学习英语，希望通过英语电影辅助，并按1-10级推荐。'];
  lab.store.commitJob(job, { creates: summaries.map(summary => ({ kind: 'understanding', summary, topics: [],
    anchorMessageId: user.id, sourceMessageIds: [user.id] })), updates: [], mentions: [], retractions: [],
  overview: { summary: summaries.join('\n'), memoryIds: [], createIndexes: [0, 1, 2] } }, now);
  return job;
};
const until = async predicate => {
  for (let i = 0; i < 100; i++) { const value = predicate(); if (value) return value; await pause(5); }
  assert.fail('derived brief did not settle');
};

test('HTTP chat injects cached grouped source text while original memory and overview rows remain intact', async t => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release?.());
  const inputs = [];
  const lab = createLabServer({ dbPath: ':memory:', contextBriefEnabled: true, allowDataReset: false,
    provider: { async chat(options) { inputs.push(options.messages); return { content: '在。', toolCalls: [], receipt: { finish_reason: 'stop' } }; } },
    memoryProvider: { async chat(options) {
      assert.equal(options.responseFormat.json_schema.name, 'context_brief_selection_v1'); calls++;
      const { records } = JSON.parse(options.messages[1].content);
      const movie = records.find(r => r.summary.includes('电影')), game = records.find(r => r.summary.includes('英雄联盟'));
      const english = records.find(r => r !== movie && r.summary.includes('英语'));
      await gate;
      return { content: JSON.stringify({ groups: [
        { category: 'goals', representativeId: movie.id, memberIds: [english.id, movie.id] },
        { category: 'preferences', representativeId: game.id, memberIds: [game.id] },
      ], deferredIds: [] }), receipt: { finish_reason: 'stop' } };
    } } });
  const { port } = await lab.listen(0); t.after(() => lab.close());
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const job = seed(lab, scope), before = snapshot(lab.store);
  const pending = lab.runtime.queueContextBrief(scope.childId, scope.agentId, job.session_id);
  assert.equal(pending.mode, 'source_fallback');
  release();
  const view = await until(() => { const v = lab.runtime.chatOverview(scope.childId, scope.agentId); return v.status === 'ready' && v; });
  assert.equal(view.sourceCount, 3); assert.equal(view.itemCount, 2); assert.equal(view.coveredMemoryIds.length, 3);
  assert(view.summary.includes('1-10级')); assert(!view.summary.includes('用户正在学习英语。'));
  assert.equal(snapshot(lab.store), before);
  const origin = 'http://127.0.0.1:' + port;
  const memory = await fetch(origin + '/api/memory?' + new URLSearchParams(scope)).then(r => r.json());
  assert.equal(memory.overview.memoryIds.length, 3); assert.equal(memory.chatOverview.itemCount, 2);
  assert.equal(memory.chatOverview.sourceRecords.length, 3);
  const sessionId = lab.store.sessions(scope.childId, scope.agentId).find(s => s.status === 'open').id;
  for (const text of ['在吗', '继续']) {
    const r = await fetch(origin + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, sessionId, text, requestId: crypto.randomUUID() }) });
    assert.match(await r.text(), /"type":"done"/);
  }
  for (const messages of inputs) assert.equal(JSON.parse(messages[1].content.split('\n')[1]).userOverview, view.summary);
  assert.equal(calls, 1, 'ordinary turns reuse the completed projection');
  assert.equal(snapshot(lab.store), before);
  assert.equal(lab.store.usage(job.session_id).calls.filter(c => c.kind === 'context_brief').length, 1);
});

test('bad brief output falls back to current sources and reads never retry the paid request', async t => {
  let calls = 0;
  const lab = createLabServer({ dbPath: ':memory:', contextBriefEnabled: true,
    provider: { async chat() { throw new Error('unused'); } },
    memoryProvider: { async chat() { calls++; return { content: '{"groups":[],"deferredIds":[]}', receipt: { finish_reason: 'stop' } }; } } });
  await lab.listen(0); t.after(() => lab.close());
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const job = seed(lab, scope), before = snapshot(lab.store);
  lab.runtime.queueContextBrief(scope.childId, scope.agentId, job.session_id);
  const view = await until(() => { const v = lab.runtime.chatOverview(scope.childId, scope.agentId); return v.status === 'failed' && v; });
  assert.equal(view.mode, 'source_fallback'); assert(view.summary.includes('英语电影'));
  for (let i = 0; i < 5; i++) lab.runtime.queueContextBrief(scope.childId, scope.agentId, job.session_id);
  await pause(10); assert.equal(calls, 1); assert.equal(snapshot(lab.store), before);
  assert.equal(lab.store.jobList(scope.childId, scope.agentId)[0].status, 'succeeded', 'projection failure does not mark memory failed');
});
