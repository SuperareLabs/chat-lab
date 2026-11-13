import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../lib/runtime.mjs';
import { ChatStore } from '../lib/store.mjs';
import { ProviderError } from '../lib/provider.mjs';
import { memoryRepairRequestFor } from '../lib/memory-repair.mjs';

const NOW = '2026-11-13T12:00:00.000Z';
const OLD_SUMMARY = '用户希望聊天时助手多主动询问自己的相关情况。';
const NEW_SUMMARY = '用户希望助手主动询问近况，并有方向地了解自己的兴趣。';
const model = 'doubao-seed-2-1-lite-260915';
const empty = () => ({ creates: [], updates: [], mentions: [], retractions: [], overview: null });
const receipt = index => ({ model, provider_id: `mock-memory-${index}`, finish_reason: 'stop',
  usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, prompt_tokens_details: { cached_tokens: 0 } } });

function fixture(t, respond) {
  const store = new ChatStore(':memory:');
  const requests = [];
  let f;
  const runtime = new ChatRuntime({ store, clock: () => new Date(NOW), appVersion: 'repair-flow-test',
    model: { name: 'unused-chat', configured: true }, memoryModel: { name: model, configured: true },
    allowDataReset: false, contextBriefEnabled: false,
    provider: { async chat() { assert.fail('repair flow must use the dedicated memory provider'); } },
    memoryProvider: { async chat(request) { requests.push(request); return respond(f, request, requests.length); } } });
  runtime.initialize();
  t.after(async () => { await runtime.stop(); store.close(); });
  const scope = { childId: store.children()[0].id, agentId: runtime.state().agents[0].id };
  const queue = (texts, at = NOW) => {
    const run = store.beginChat({ ...scope, messages: texts.map(text => ({ text })), requestId: crypto.randomUUID() }, at, 900_000);
    store.finishChat(run, { reply: '好。' }, at);
    store.manuallyOpen(scope.childId, scope.agentId, at);
    const job = store.claimJob(at);
    assert(job); return job;
  };
  const seed = queue(['请多主动问问我的近况。'], '2026-11-12T12:00:00.000Z');
  const seedUser = seed.snapshot.find(message => message.role === 'user');
  const initial = empty();
  initial.creates.push({ kind: 'understanding', topics: ['相处方式'], summary: OLD_SUMMARY,
    detail: { notes: '希望聊天时多一点主动关注。' }, anchorMessageId: seedUser.id, sourceMessageIds: [seedUser.id] });
  initial.overview = { summary: OLD_SUMMARY, memoryIds: [], createIndexes: [0] };
  const oldId = store.commitJob(seed, initial, '2026-11-12T12:01:00.000Z').createdIds[0];
  const job = queue(['我们上次聊天是什么时候了？', '你尝试挖掘一下我的兴趣呢，有方向的挖掘。',
    '不问我去哪？', '你太冷漠了。', '我每周末练习吉他，准备参加明年的社团演出。']);
  const snapshot = structuredClone(job.snapshot);
  const commits = [];
  const commit = store.commitJob.bind(store);
  store.commitJob = (...args) => { commits.push(args[0].session_id); return commit(...args); };
  const saved = () => store.jobList(scope.childId, scope.agentId).find(item => item.sessionId === job.session_id);
  const memoryState = () => Object.fromEntries(['memories', 'memory_mentions', 'user_overviews', 'memory_scopes']
    .map(table => [table, store.sql('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  f = { store, runtime, requests, scope, oldId, job, snapshot, queue, commits, saved, memoryState,
    targetCommits: () => commits.filter(id => id === job.session_id).length };
  f.baseline = memoryState();
  return f;
}

function validPlan(f, request) {
  const input = JSON.parse(request.messages[1].content);
  const users = input.userMessages;
  const plan = empty();
  plan.creates.push({ sourceMessageIds: [users[4].id], kind: 'understanding', topics: ['吉他'],
    summary: '用户每周末练习吉他。', detail: { notes: '准备参加明年的社团演出。' } });
  plan.updates.push({ sourceMessageIds: users.slice(1, 4).map(user => user.id), memoryId: f.oldId,
    changeType: 'supplement', summary: NEW_SUMMARY,
    detailDelta: { notes: '希望有方向地挖掘兴趣，不要过于冷漠。' } });
  plan.overview = { summary: '用户希望得到主动关注，每周末练吉他。', memoryIds: [f.oldId], createIndexes: [0] };
  return plan;
}

function conflictingPlan(f, request) {
  const plan = validPlan(f, request);
  plan.mentions.push({ memoryId: f.oldId, sourceMessageIds: [JSON.parse(request.messages[1].content).userMessages[0].id] });
  return plan;
}

function assertNoMemoryCommit(f) {
  assert.equal(f.targetCommits(), 0);
  assert.deepEqual(f.memoryState(), f.baseline);
}

function assertFrozenRepairInput(f, firstRaw) {
  assert.equal(f.requests.length, 2);
  const [first, repair] = f.requests;
  assert.deepEqual(repair.messages.slice(0, first.messages.length), first.messages,
    'repair retains the exact initial source snapshot, candidates and short references');
  assert.equal(repair.messages.length, first.messages.length + 1);
  assert.deepEqual(repair.messages.slice(first.messages.length).map(message => message.role), ['user']);
  assert(repair.messages.every(message => !message.content.includes(firstRaw)),
    'the rejected full JSON is retained locally but is never sent back to the model');
  assert.match(repair.messages.at(-1).content, /同一记忆 ID 在本轮只能对应一种操作/);
  const diagnosis = JSON.parse(repair.messages.at(-1).content.split('\n\n').at(-1));
  assert.equal(diagnosis.validationContext.memoryId, f.oldId);
  assert.equal(diagnosis.validationContext.channel, 'mentions');
  assert.equal(diagnosis.validationContext.index, 0);
  assert.deepEqual(diagnosis.validationContext.conflictingOperation, { channel: 'updates', index: 0 });
  assert.equal(diagnosis.validationContext.anchorUserRef, JSON.parse(first.messages[1].content).userMessages[0].id);
  assert.equal(Object.hasOwn(diagnosis.validationContext, 'anchorMessageId'), false);
  for (const message of f.snapshot.filter(item => item.role === 'user')) {
    assert(!repair.messages.at(-1).content.includes(message.id), 'diagnostics use only the original U references');
  }
  assert.deepEqual(repair.responseFormat, first.responseFormat);
  assert.deepEqual(f.job.snapshot, f.snapshot);
}

test('normal valid extraction makes exactly one model call and one atomic commit', async t => {
  const f = fixture(t, async (current, request, index) => ({ content: JSON.stringify(validPlan(current, request)), receipt: receipt(index) }));
  assert.equal(f.runtime.memoryFrameworkVersion, 6);
  await f.runtime.extract(f.job, new AbortController().signal);
  const saved = f.saved();
  assert.equal(saved.status, 'succeeded', saved.error);
  assert.equal(f.requests.length, 1);
  assert.equal(f.targetCommits(), 1);
  assert.equal(f.store.usage(f.job.session_id).memoryCalls, 1);
  assert.equal(saved.output.stages.repair, undefined);
  assert.equal((saved.output.validationFailures ?? []).length, 0);
});

test('a duplicate update and mention is strictly rejected, repaired once and committed without losing content', async t => {
  let firstRaw;
  const f = fixture(t, async (current, request, index) => {
    if (index === 1) {
      firstRaw = JSON.stringify(conflictingPlan(current, request));
      return { content: firstRaw, receipt: receipt(index), metrics: { total_ms: 3 } };
    }
    assertNoMemoryCommit(current);
    assertFrozenRepairInput(current, firstRaw);
    return { content: JSON.stringify(validPlan(current, request)), receipt: receipt(index), metrics: { total_ms: 4 } };
  });
  await f.runtime.extract(f.job, new AbortController().signal);
  const saved = f.saved();
  assert.equal(saved.status, 'succeeded', saved.error);
  assert.equal(f.requests.length, 2);
  assert.equal(f.targetCommits(), 1);
  assert.equal(saved.output.content, firstRaw, 'top-level audit keeps the original rejected response');
  assert.equal(saved.output.stages.extraction.content, firstRaw);
  assert(saved.output.stages.repair.content.includes(NEW_SUMMARY));
  assert.deepEqual(saved.output.stages.extraction.receipt, receipt(1));
  assert.deepEqual(saved.output.stages.repair.receipt, receipt(2));
  assert.equal(saved.output.stages.extraction.metrics.total_ms, 3);
  assert.equal(saved.output.stages.repair.metrics.total_ms, 4);
  assert.deepEqual(saved.output.validationFailures.map(failure => failure.stage), ['extraction']);
  assert.match(saved.output.validationFailures[0].message, /同一记忆 ID/);
  assert.equal(saved.output.validationFailures[0].validationContext.anchorMessageId,
    f.snapshot.find(message => message.role === 'user').id, 'local audit retains the original UUID');
  const updated = f.store.memoryDetail(f.oldId, f.scope.childId, f.scope.agentId);
  assert.equal(updated.summary, NEW_SUMMARY);
  assert.equal(updated.version, 2);
  assert.equal(updated.detail.notes, '希望聊天时多一点主动关注。');
  assert.equal(updated.detailChanges[0].detailDelta.notes, '希望有方向地挖掘兴趣，不要过于冷漠。');
  assert.equal(updated.summaryHistory[0].summary, OLD_SUMMARY);
  const created = f.store.memoryDetail(saved.result.createdIds[0], f.scope.childId, f.scope.agentId);
  assert.equal(created.detail.notes, '准备参加明年的社团演出。');
  assert.equal(saved.result.createdIds.length, 1);
  assert.deepEqual(saved.result.updatedIds, [f.oldId]);
  assert.deepEqual(saved.result.mentionedIds, []);
  const overview = f.store.userOverview(f.scope.childId, f.scope.agentId);
  assert.deepEqual(overview.memoryIds, [f.oldId, created.memoryId]);
  assert(overview.summary.includes(NEW_SUMMARY)); assert(overview.summary.includes(created.summary));
  const usage = f.store.usage(f.job.session_id);
  assert.equal(usage.memoryCalls, 2);
  assert.equal(usage.inputTokens, 40); assert.equal(usage.outputTokens, 24);
  assert.deepEqual(usage.calls.map(call => [call.name, call.providerId]), [['extraction', 'mock-memory-1'], ['repair', 'mock-memory-2']]);
  assertFrozenRepairInput(f, firstRaw);
});

test('two invalid responses stop after the sole repair and write no partial memories', async t => {
  const f = fixture(t, async (current, request, index) => ({ content: JSON.stringify(conflictingPlan(current, request)), receipt: receipt(index) }));
  await f.runtime.extract(f.job, new AbortController().signal);
  const saved = f.saved();
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /已修正1次仍失败/);
  assert.equal(f.requests.length, 2);
  assertNoMemoryCommit(f);
  assert.deepEqual(saved.output.validationFailures.map(failure => failure.stage), ['extraction', 'repair']);
  assert.equal(f.store.usage(f.job.session_id).memoryCalls, 2);
  assert(saved.output.stages.extraction && saved.output.stages.repair);
});

test('a provider timeout is recorded without a semantic repair call', async t => {
  const f = fixture(t, async () => { throw new ProviderError('模型请求超时；未自动重试', { code: 'TIMEOUT', outcomeUnknown: true }); });
  await f.runtime.extract(f.job, new AbortController().signal);
  assert.equal(f.saved().status, 'failed');
  assert.match(f.saved().error, /超时/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.store.usage(f.job.session_id).memoryCalls, 1);
  assert.equal((f.saved().output?.validationFailures ?? []).length, 0);
  assertNoMemoryCommit(f);
});

test('an already aborted task does not dispatch any model request', async t => {
  const f = fixture(t, async () => { assert.fail('aborted task dispatched a model request'); });
  const controller = new AbortController(); controller.abort();
  await f.runtime.extract(f.job, controller.signal);
  assert.equal(f.requests.length, 0);
  assert.equal(f.saved().status, 'failed');
  assertNoMemoryCommit(f);
});

test('abort after an invalid first response prevents repair and preserves the source snapshot', async t => {
  const controller = new AbortController();
  const f = fixture(t, async (current, request, index) => {
    controller.abort();
    return { content: JSON.stringify(conflictingPlan(current, request)), receipt: receipt(index) };
  });
  await f.runtime.extract(f.job, controller.signal);
  assert.equal(f.requests.length, 1);
  assert.equal(f.saved().status, 'failed');
  assert.equal(f.saved().output.stages.repair, undefined);
  assert.deepEqual(f.job.snapshot, f.snapshot);
  assertNoMemoryCommit(f);
});

test('a concurrent scope change prevents a paid repair and preserves the newer committed fact', async t => {
  const concurrentSummary = '用户希望每次只被问一个问题。';
  const f = fixture(t, async (current, request, index) => {
    const invalid = JSON.stringify(conflictingPlan(current, request));
    const concurrent = current.queue(['更正一下，每次只问我一个问题。'], '2026-11-13T12:00:01.000Z');
    const user = concurrent.snapshot.find(message => message.role === 'user');
    const plan = empty();
    plan.updates.push({ memoryId: current.oldId, changeType: 'correction', summary: concurrentSummary,
      anchorMessageId: user.id, sourceMessageIds: [user.id] });
    plan.overview = { summary: concurrentSummary, memoryIds: [current.oldId], createIndexes: [] };
    current.store.commitJob(concurrent, plan, '2026-11-13T12:00:02.000Z');
    return { content: invalid, receipt: receipt(index) };
  });
  await f.runtime.extract(f.job, new AbortController().signal);
  assert.equal(f.requests.length, 1, 'changed scope is fenced before dispatching repair');
  assert.equal(f.saved().status, 'failed');
  assert.equal(f.targetCommits(), 0);
  assert.equal(f.store.memoryDetail(f.oldId, f.scope.childId, f.scope.agentId).summary, concurrentSummary);
  assert.equal(f.store.memoryCounts(f.scope.childId, f.scope.agentId).active, 1);
  assert.equal(f.saved().output.stages.repair, undefined);
  assert.equal(f.store.usage(f.job.session_id).memoryCalls, 1);
});

test('a repair response with an unknown user reference is still strictly rejected', async t => {
  const f = fixture(t, async (current, request, index) => {
    const plan = index === 1 ? conflictingPlan(current, request) : validPlan(current, request);
    if (index === 2) plan.creates[0].sourceMessageIds = ['U999'];
    return { content: JSON.stringify(plan), receipt: receipt(index) };
  });
  await f.runtime.extract(f.job, new AbortController().signal);
  const saved = f.saved();
  assert.equal(saved.status, 'failed');
  assert.equal(f.requests.length, 2);
  assertNoMemoryCommit(f);
  assert.deepEqual(saved.output.validationFailures.map(failure => failure.stage), ['extraction', 'repair']);
  assert.match(saved.output.validationFailures[1].message, /用户编号|来源/);
  assert(saved.output.stages.repair.content.includes('U999'));
});

test('truncated output does not enter the semantic repair path', async t => {
  const f = fixture(t, async (current, request, index) => ({ content: JSON.stringify(conflictingPlan(current, request)),
    receipt: { ...receipt(index), finish_reason: 'length' } }));
  await f.runtime.extract(f.job, new AbortController().signal);
  assert.equal(f.requests.length, 1);
  assert.equal(f.saved().status, 'failed');
  assert.match(f.saved().error, /长度上限/);
  assert.equal((f.saved().output.validationFailures ?? []).length, 0);
  assertNoMemoryCommit(f);
});

test('repair helper accepts only the original request and diagnosis, without rejected model content', () => {
  const request = { messages: [{ role: 'system', content: 'original task' }, { role: 'user', content: 'original sources' }],
    responseFormat: { type: 'json_object' }, references: [{ ref: 'U1', messageId: 'actual-source-uuid' }] };
  const error = Object.assign(new Error('同一记忆 ID 在本轮只能对应一种操作'), {
    validationContext: { channel: 'mentions', index: 0, memoryId: 'existing-memory-id',
      anchorMessageId: 'actual-source-uuid', conflictingOperation: { channel: 'updates', index: 0 } },
  });
  const repaired = memoryRepairRequestFor({ request, error });
  assert.deepEqual(repaired.messages.slice(0, request.messages.length), request.messages);
  assert.equal(repaired.messages.length, request.messages.length + 1);
  assert.equal(repaired.messages.at(-1).role, 'user');
  assert(!repaired.messages.at(-1).content.includes('actual-source-uuid'));
  const diagnosis = JSON.parse(repaired.messages.at(-1).content.split('\n\n').at(-1));
  assert.equal(diagnosis.validationContext.anchorUserRef, 'U1');
  assert.equal(Object.hasOwn(diagnosis.validationContext, 'anchorMessageId'), false);
  assert.deepEqual(repaired.responseFormat, request.responseFormat);
});
