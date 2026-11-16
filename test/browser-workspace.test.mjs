import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrowserWorkspace, BROWSER_WORKSPACE_MAX_BYTES } from '../lib/browser-workspace.mjs';

const seeds = [
  { id: 'public-a', name: '公开角色甲', definition: '自然接住对话，按需查找记忆。', metadata: {} },
  { id: 'public-b', name: '公开角色乙', definition: '温和地交流。', metadata: {} },
];
const receipt = { model: 'doubao-seed-2-1-lite-260915', finish_reason: 'stop',
  usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } };
const query = scope => '?' + new URLSearchParams(scope);
function fixture(options = {}) {
  let now = new Date('2026-11-15T03:00:00.000Z');
  const calls = { chat: [], memory: [], tools: [] };
  const provider = { async chat(input) {
    calls.chat.push(input);
    const toolResponse = input.messages.findLast(message => message.role === 'tool');
    const latest = input.messages.findLast(message => message.role === 'user')?.content;
    if (/回忆/u.test(latest) && !toolResponse) return { content: '我想想。', toolCalls: [{ id: 'recall-1', type: 'function',
      function: { name: 'recall_memory', arguments: JSON.stringify({ query: '吉他' }) } }], receipt };
    if (toolResponse) calls.tools.push(JSON.parse(toolResponse.content));
    const content = toolResponse ? '你之前说过每周末练习吉他。' : '好的，我听见了。';
    input.onDelta?.(content);
    return { content, toolCalls: [], receipt };
  } };
  const memoryProvider = { async chat(input) {
    calls.memory.push(input);
    const { userMessages } = JSON.parse(input.messages[1].content);
    assert(userMessages[0]?.id, 'uses the existing extractor reference contract');
    const result = { creates: [{ sourceMessageIds: [userMessages[0].id], kind: 'understanding', topics: ['吉他'],
      summary: '用户每周末练习吉他。', detail: { notes: '准备参加明年的社团演出。' } }],
      updates: [], mentions: [], retractions: [],
      overview: { summary: '用户每周末练习吉他。', memoryIds: [], createIndexes: [0] } };
    return { content: JSON.stringify(result), receipt };
  } };
  const config = { appVersion: 'browser-test', defaultAgents: seeds, defaultChildren: [{ name: '访客', age: null, interests: [] }],
    model: { name: receipt.model, configured: true }, memoryModel: { name: receipt.model, configured: true },
    provider, memoryProvider, clock: () => now, ...options };
  const workspace = createBrowserWorkspace(config);
  return { workspace, calls, config, advance(ms) { now = new Date(now.getTime() + ms); } };
}
async function client(f, initial = null) {
  let snapshot = initial, scope;
  const send = async (method, path, body, extra = {}) => {
    const events = [];
    const result = await f.workspace.execute({ method, path, ...(body === undefined ? {} : { body }), snapshot,
      ...(scope ? { scope } : {}), ...extra }, { emit: event => events.push(event) });
    snapshot = result.snapshot;
    return { ...result, events };
  };
  const state = await send('GET', '/api/state');
  scope = { childId: state.value.children[0]?.id, agentId: state.value.agents[0]?.id };
  return { send, state: state.value, get snapshot() { return snapshot; }, get scope() { return scope; },
    select(value) { scope = value; },
    chat(text, requestId = crypto.randomUUID()) { return send('POST', '/api/chat', { ...scope, text, requestId }); },
    sessions() { return send('GET', '/api/sessions' + query(scope)); },
    memory() { return send('GET', '/api/memory' + query(scope)); },
    newSession() { return send('POST', '/api/sessions', scope); } };
}

test('only the untouched initial visitor receives the adult demo age while memories and other profiles remain intact', async () => {
  const f = fixture(), a = await client(f);
  await a.chat('每周末练习吉他。');
  await a.newSession();
  await a.send('POST', '/api/children', { name: '小朋友', age: 8, interests: [] });
  await a.send('POST', '/api/children', { name: '访客', age: null, interests: [] });
  const before = structuredClone(a.snapshot);
  const updated = createBrowserWorkspace({ ...f.config, defaultChildren: [{ name: '访客', age: 22, interests: [] }] });
  const result = await updated.execute({ method: 'GET', path: '/api/state', snapshot: before });
  assert.equal(result.snapshot.tables.children[0].age, 22);
  assert.equal(result.snapshot.tables.children[0].version, before.tables.children[0].version + 1);
  assert.deepEqual(result.snapshot.tables.children.slice(1), before.tables.children.slice(1));
  assert(result.invalidates.includes('/api/memory'));
  for (const [table, rows] of Object.entries(before.tables)) if (table !== 'children') assert.deepEqual(result.snapshot.tables[table], rows, table);
  const again = await updated.execute({ method: 'GET', path: '/api/state', snapshot: result.snapshot });
  assert.deepEqual(again.snapshot, result.snapshot);
  for (const fields of [{ age: 8 }, { name: '自建用户' }, { version: 1 }, { interests: '["足球"]' }]) {
    const personal = structuredClone(before);Object.assign(personal.tables.children[0], fields);
    const kept = await updated.execute({ method: 'GET', path: '/api/state', snapshot: personal });
    assert.deepEqual(kept.snapshot.tables.children, personal.tables.children);
  }
});

test('new workspaces never open configured disk DBs or import an existing person', async () => {
  const ignoredPath = join(tmpdir(), 'browser-workspace-must-not-exist-' + crypto.randomUUID(), 'legacy.sqlite');
  const f = fixture({ dbPath: ignoredPath, defaultChildren: [] });
  const result = await f.workspace.execute({ method: 'GET', path: '/api/state', snapshot: null });
  assert.equal(existsSync(ignoredPath), false);
  assert.deepEqual(result.value.children, []);
  assert.equal(result.value.agents.length, 2);
  assert.equal(result.value.dataResetAllowed, false);
  for (const table of ['messages', 'sessions', 'memories', 'jobs', 'usage_records']) assert.deepEqual(result.snapshot.tables[table], []);
  assert.equal(result.nextDeadline, null);
  assert.equal(f.calls.chat.length + f.calls.memory.length, 0);
});

test('independent browser snapshots isolate profiles, edited roles and chat history', async () => {
  const f = fixture(), a = await client(f), b = await client(f);
  assert.notEqual(a.scope.childId, b.scope.childId);
  const agent = a.state.agents[0];
  await a.send('PATCH', '/api/agents/' + agent.id, { name: '仅甲浏览器角色', definition: '这是甲浏览器的设置。', revision: agent.revision });
  await a.chat('甲浏览器的独有聊天。');
  const bReloaded = await client(f, b.snapshot);
  assert.equal(bReloaded.state.agents[0].name, agent.name);
  assert.equal(bReloaded.snapshot.tables.messages.length, 0);
  assert.doesNotMatch(JSON.stringify(bReloaded.snapshot), /甲浏览器/);
  assert.equal(a.snapshot.tables.messages.length, 2);
});

test('chat, idle extraction, detail, overview, usage and recall tools survive save/reload without duplicate extraction', async () => {
  const f = fixture(), a = await client(f);
  const sent = await a.chat('我每周末练习吉他，准备参加明年的社团演出。', 'persisted-request');
  assert.equal(sent.events.at(-1).type, 'workspace');
  assert(sent.events.some(event => event.type === 'done'));
  assert.equal(sent.nextDeadline, Date.parse('2026-11-15T03:15:00.000Z'));
  assert.equal(f.calls.memory.length, 0);
  const sessionId = sent.events.find(event => event.type === 'start').sessionId;
  const replay = await a.chat('我每周末练习吉他，准备参加明年的社团演出。', 'persisted-request');
  assert.equal(f.calls.chat.length, 1, 'existing request ID replays the saved answer');
  assert.equal(replay.snapshot.tables.messages.length, 2);
  f.advance(15 * 60_000);
  const caughtUp = await a.send('GET', '/api/state');
  assert.equal(f.calls.memory.length, 1);
  const memory = caughtUp.views['/api/memory' + query(a.scope)];
  assert.equal(memory.items.length, 1);
  assert.equal(memory.jobs[0].status, 'succeeded', memory.jobs[0].error);
  assert.match(memory.overview.summary, /吉他/);
  const itemId = memory.items[0].memoryId;
  const archivedSnapshot = structuredClone(a.snapshot);
  archivedSnapshot.tables.memories[0].state = 'archived';
  archivedSnapshot.tables.memories[0].archived_at = '2026-11-15T03:15:00.000Z';
  const b = await client(f, archivedSnapshot);
  const detail = await b.send('GET', '/api/memory/' + itemId + query(b.scope));
  assert.equal(detail.value.item.detail.notes, '准备参加明年的社团演出。');
  assert.equal(detail.value.item.state, 'archived');
  const session = await b.send('GET', '/api/sessions/' + sessionId + query(b.scope));
  assert.equal(session.value.messages.length, 2);
  assert.equal(session.value.usage.memoryCalls, 1);
  assert.equal(session.value.usage.chatCalls, 1);
  assert.equal(session.value.context.history[0].text, '我每周末练习吉他，准备参加明年的社团演出。');
  const recalled = await b.chat('回忆一下我周末练什么？');
  assert.equal(recalled.events.at(-1).type, 'workspace');
  assert.equal(f.calls.tools.length, 1);
  assert.equal(f.calls.tools[0].items[0].memoryId, itemId);
  assert.equal(f.calls.memory.length, 1, 'finished jobs do not run again after multiple restores');
});

test('scoped clear seals queued history, removes contexts and keeps another role’s memory', async () => {
  const f = fixture(), a = await client(f);
  await a.chat('我每周末练习吉他。');
  await a.newSession();
  const firstScope = { ...a.scope };
  a.select({ ...a.scope, agentId: seeds[1].id });
  await a.chat('我也每周末练习吉他。');
  await a.newSession();
  assert.equal(f.calls.memory.length, 2);
  const secondScope = { ...a.scope };
  a.select(firstScope);
  const noMemory = fixture({ ...f.config, memoryModel: { name: receipt.model, configured: false } });
  const pending = await client(noMemory, a.snapshot);
  pending.select(firstScope);
  await pending.chat('这是清空前尚未整理的旧消息。');
  await pending.newSession();
  assert(pending.snapshot.tables.jobs.some(job => job.agent_id === firstScope.agentId && job.status === 'queued'));
  const queued = structuredClone(pending.snapshot);
  const callsBeforeClear = f.calls.memory.length;
  const cleared = await f.workspace.execute({ method: 'POST', path: '/api/memory/clear', body: firstScope, scope: firstScope, snapshot: queued });
  const callsAfterClear = f.calls.memory.length;
  assert.equal(callsAfterClear, callsBeforeClear, 'queued old messages are cleared before any worker starts');
  assert.deepEqual(cleared.invalidates, ['/api/sessions', '/api/memory']);
  for (const table of ['memories', 'user_overviews', 'memory_scopes', 'context_briefs', 'soul_profiles'])
    assert(!cleared.snapshot.tables[table].some(row => row.agent_id === firstScope.agentId), table);
  for (const session of cleared.snapshot.tables.sessions.filter(row => row.agent_id === firstScope.agentId)) {
    assert.equal(session.status, 'closed'); assert.equal(session.context, null); assert.equal(session.recent_snapshot, null);
  }
  for (const job of cleared.snapshot.tables.jobs.filter(row => row.agent_id === firstScope.agentId)) {
    assert.equal(job.status, 'succeeded'); assert.equal(job.source_snapshot, null); assert.equal(job.input_context, null);
  }
  assert(cleared.snapshot.tables.messages.some(row => row.text === '这是清空前尚未整理的旧消息。'));
  assert.equal(cleared.snapshot.tables.memories.filter(row => row.agent_id === secondScope.agentId).length, 1);
  f.advance(60 * 60_000);
  const after = await f.workspace.execute({ method: 'GET', path: '/api/state', snapshot: cleared.snapshot, scope: firstScope });
  assert.equal(f.calls.memory.length, callsAfterClear);
  assert.equal(after.snapshot.tables.memories.filter(row => row.agent_id === firstScope.agentId).length, 0);
  const all = await f.workspace.execute({ method: 'POST', path: '/api/memory/clear', body: { all: true }, snapshot: after.snapshot, scope: secondScope });
  assert.equal(all.snapshot.tables.memories.length, 0);
  assert(all.snapshot.tables.messages.length > 0);
});

test('one request catches up one older scope when the selected scope has no work and schedules the remaining queue', async () => {
  const f = fixture({ memoryModel: { name: receipt.model, configured: false } }), a = await client(f);
  for (let index = 0; index < 3; index++) { await a.chat('我每周末练习吉他，练习编号' + index); await a.newSession(); }
  assert.equal(a.snapshot.tables.jobs.filter(job => job.status === 'queued').length, 3);
  const live = fixture({ ...f.config, memoryModel: { name: receipt.model, configured: true } });
  assert.equal((await a.send('GET', '/api/state')).nextDeadline, null, 'an unconfigured memory model does not poll queued work');
  const selected = { ...a.scope, agentId: seeds[1].id };
  const first = await live.workspace.execute({ method: 'GET', path: '/api/state', snapshot: a.snapshot, scope: selected });
  assert.equal(f.calls.memory.length, 1);
  assert.equal(first.snapshot.tables.jobs.filter(job => job.status === 'queued').length, 2);
  assert.equal(first.snapshot.tables.jobs.filter(job => job.status === 'succeeded').length, 1);
  assert(!first.snapshot.tables.jobs.some(job => job.status === 'running'));
  assert.equal(first.views['/api/memory' + query(selected)].items.length, 0, 'background work does not change the selected role');
  assert.equal(first.nextDeadline, Date.parse('2026-11-15T03:00:01.000Z'));
  assert.deepEqual(first.invalidates, ['/api/sessions', '/api/memory']);
});

test('snapshot schema, SQL-shaped fields, routes, references and versions fail before a provider request', async () => {
  const f = fixture(), a = await client(f);
  const mutations = [
    snapshot => { snapshot.tables["agents; DROP TABLE children"] = []; },
    snapshot => { snapshot.tables.agents[0].sql = 'SELECT * FROM secrets'; },
    snapshot => { snapshot.tables.children[0].name = { $sql: 'SELECT *' }; },
    snapshot => { snapshot.tables.agents[0].metadata = '{bad-json'; },
    snapshot => { snapshot.tables.soul_profiles.push({ child_id: 'missing-child', agent_id: seeds[0].id, profile: '{}', version: 0 }); },
    snapshot => { snapshot.tables.lab_meta.push({ key: 'arbitrary_sql', value: 'SELECT * FROM disk' }); },
  ];
  for (const mutate of mutations) {
    const snapshot = structuredClone(a.snapshot); mutate(snapshot);
    await assert.rejects(f.workspace.execute({ method: 'GET', path: '/api/state', snapshot }), error => error.status === 400);
  }
  await assert.rejects(f.workspace.execute({ method: 'POST', path: '/api/sql', body: { sql: 'SELECT * FROM agents' }, snapshot: a.snapshot }), error => error.status === 404);
  const otherVersion = structuredClone(a.snapshot);
  otherVersion.tables.lab_meta.find(row => row.key === 'data_version').value = 'unrelated-version';
  await assert.rejects(f.workspace.execute({ method: 'GET', path: '/api/state', snapshot: otherVersion }), error => error.status === 409);
  const tooLarge = structuredClone(a.snapshot);
  tooLarge.tables.agents[0].definition = 'x'.repeat(BROWSER_WORKSPACE_MAX_BYTES);
  await assert.rejects(f.workspace.execute({ method: 'GET', path: '/api/state', snapshot: tooLarge }), error => error.status === 413);
  assert.equal(f.calls.chat.length + f.calls.memory.length, 0);
  assert.equal(a.snapshot.tables.children[0].name, '访客');
  assert.equal(BROWSER_WORKSPACE_MAX_BYTES, 16 * 1024 * 1024);
});

test('failed streamed chats still end with a restorable workspace and retain user input', async () => {
  const f = fixture({ provider: { async chat() { throw new Error('合成模型故障'); } } }), a = await client(f);
  const result = await a.chat('这条输入需要保存。');
  assert(result.events.some(event => event.type === 'error'));
  assert.equal(result.events.at(-1).type, 'workspace');
  const restored = await client(f, result.snapshot);
  assert.equal(restored.snapshot.tables.messages.find(message => message.role === 'user').text, '这条输入需要保存。');
  assert.equal(restored.snapshot.tables.runs[0].status, 'failed');
});

test('a response waits for the existing background extractor before exporting its snapshot', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture();
  const base = f.config.memoryProvider;
  f.workspace = createBrowserWorkspace({ ...f.config, memoryProvider: { async chat(input) { started(); await gate; return base.chat(input); } } });
  const a = await client(f);
  await a.chat('我每周末练习吉他。');
  let completed = false;
  const pending = a.newSession().then(result => { completed = true; return result; });
  await ready;
  assert.equal(completed, false);
  release();
  const result = await pending;
  assert.equal(result.snapshot.tables.memories.length, 1);
  assert(result.snapshot.tables.jobs.every(job => job.status !== 'running'));
  assert.equal(f.calls.memory.length, 1);
});

test('optional context brief uses the same scoped runtime pipeline and restores its completed projection', async () => {
  const f = fixture();
  let briefCalls = 0;
  const base = f.config.memoryProvider;
  f.workspace = createBrowserWorkspace({ ...f.config, contextBriefEnabled: true, memoryProvider: { async chat(input) {
    if (input.responseFormat?.json_schema?.name !== 'context_brief_selection_v1') return base.chat(input);
    briefCalls++;
    const { records } = JSON.parse(input.messages[1].content);
    return { content: JSON.stringify({ groups: [{ category: 'preferences', representativeId: records[0].id,
      memberIds: records.map(row => row.id) }], deferredIds: [] }), receipt };
  } } });
  const a = await client(f);
  await a.chat('我每周末练习吉他。');
  const result = await a.newSession();
  assert.equal(result.snapshot.tables.context_briefs[0].status, 'succeeded');
  assert.equal(result.views['/api/memory' + query(a.scope)].chatOverview.mode, 'cached');
  await client(f, result.snapshot);
  assert.equal(briefCalls, 1);
});

test('aborting a chat settles it before saving and leaves no running work in the snapshot', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ provider: { async chat(input) {
    started();
    await new Promise((resolve, reject) => {
      if (input.signal.aborted) reject(new Error('aborted'));
      else input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } } });
  const a = await client(f), controller = new AbortController(), events = [];
  const pending = f.workspace.execute({ method: 'POST', path: '/api/chat', snapshot: a.snapshot, scope: a.scope,
    body: { ...a.scope, text: '中断前也要保留。', requestId: 'aborted-request' } }, { emit: event => events.push(event), signal: controller.signal });
  await ready;
  controller.abort();
  const result = await pending;
  assert.equal(result.snapshot.tables.runs[0].status, 'failed');
  assert.equal(result.snapshot.tables.messages[0].text, '中断前也要保留。');
  assert.equal(events.at(-1).type, 'workspace');
});

test('failed extraction and its one repair settle once without a paid retry deadline', async () => {
  let calls = 0;
  const f = fixture({ memoryProvider: { async chat() { calls++; return { content: '{invalid', receipt }; } } });
  const a = await client(f);
  await a.chat('我每周末练习吉他。');
  const result = await a.newSession();
  assert.equal(calls, 2, 'the original extractor permits one repair');
  assert.equal(result.snapshot.tables.jobs[0].status, 'failed');
  assert.equal(result.nextDeadline, null);
  await client(f, result.snapshot);
  assert.equal(calls, 2, 'restoring a failed job does not retry it');
});

test('business URL/body scopes cannot be redirected by a conflicting UI scope preference', async () => {
  const f = fixture({ defaultChildren: [{ name: '范围甲', age: 22, interests: [] }, { name: '范围乙', age: 22, interests: [] }] });
  const a = await client(f);
  const scopeA = { childId: a.state.children.find(child => child.name === '范围甲').id, agentId: seeds[0].id };
  const scopeB = { childId: a.state.children.find(child => child.name === '范围乙').id, agentId: seeds[0].id };
  a.select(scopeA); await a.chat('范围甲每周末练习吉他。'); await a.newSession();
  a.select(scopeB); await a.chat('范围乙每周末练习吉他。'); await a.newSession();
  const snapshot = a.snapshot, before = JSON.stringify(snapshot);
  const conflict = [
    { method: 'GET', path: '/api/memory' + query(scopeA), scope: scopeB },
    { method: 'GET', path: '/api/memory' + query(scopeB), scope: scopeA },
    { method: 'POST', path: '/api/memory/clear', body: scopeA, scope: scopeB },
    { method: 'POST', path: '/api/memory/clear', body: scopeB, scope: scopeA },
    { method: 'GET', path: '/api/memory', scope: scopeB },
    { method: 'POST', path: '/api/memory/clear', body: {}, scope: scopeB },
  ];
  for (const envelope of conflict) await assert.rejects(f.workspace.execute({ ...envelope, snapshot }), error => error.status === 400);
  assert.equal(JSON.stringify(snapshot), before, 'rejected mismatches do not change either local scope');
  const readA = await f.workspace.execute({ method: 'GET', path: '/api/memory' + query(scopeA), snapshot, scope: scopeA });
  const readB = await f.workspace.execute({ method: 'GET', path: '/api/memory' + query(scopeB), snapshot, scope: scopeB });
  assert.equal(readA.value.profile.childProfile.name, '范围甲');
  assert.equal(readB.value.profile.childProfile.name, '范围乙');
  assert.notEqual(readA.value.items[0].memoryId, readB.value.items[0].memoryId);
  assert.equal(readA.views['/api/memory' + query(scopeA)].profile.childProfile.name, '范围甲');
  assert.equal(readB.views['/api/memory' + query(scopeB)].profile.childProfile.name, '范围乙');
  const cleared = await f.workspace.execute({ method: 'POST', path: '/api/memory/clear', body: scopeA, snapshot });
  assert.equal(cleared.snapshot.tables.memories.filter(row => row.child_id === scopeA.childId).length, 0);
  assert.equal(cleared.snapshot.tables.memories.filter(row => row.child_id === scopeB.childId).length, 1);
  const created = await f.workspace.execute({ method: 'POST', path: '/api/agents', body: { name: '新角色', definition: '独立角色。' }, snapshot, scope: scopeB });
  assert.equal(created.status, 201, 'unscoped role creation accepts a UI cache preference');
});

const hashDefinition = definition => createHash('sha256').update(definition).digest('hex');
const catalogSeed = (seed, definition) => ({ ...seed, definition,
  metadata: { ...seed.metadata, catalogDefinitionSha256: hashDefinition(definition),
    catalogPreviousDefinitionSha256: [hashDefinition(seed.definition)] } });

test('an untouched stock catalog upgrades once while every conversation, memory and old context stays intact', async () => {
  const oldSeeds = [
    { ...seeds[0], metadata: { card: { theme: 'amber', portrait: '/assets/local-a.png' }, localNote: '保留本地展示资料' } },
    { ...seeds[1], metadata: { catalogDefinitionSha256: hashDefinition(seeds[1].definition), custom: { keep: true } } },
  ];
  const nextSeeds = oldSeeds.map(seed => catalogSeed(seed, seed.definition + '\n日常默认只接一到三句。'));
  const f = fixture({ defaultAgents: oldSeeds }), a = await client(f);
  await a.chat('我每周末练习吉他。');
  await a.newSession();
  const oldSnapshot = structuredClone(a.snapshot);
  const tracked = oldSnapshot.tables.agents.find(agent => agent.id === seeds[1].id);
  tracked.revision = 3; tracked.version = 'db-v3';
  const oldAgents = oldSnapshot.tables.agents;
  const retained = Object.fromEntries(Object.entries(oldSnapshot.tables).filter(([table]) => table !== 'agents'));
  const oldContext = oldSnapshot.tables.sessions.find(session => session.context)?.context;
  assert(oldContext.includes(oldSeeds[0].definition));
  const calls = f.calls.chat.length + f.calls.memory.length;
  f.advance(1000);
  const upgradedWorkspace = createBrowserWorkspace({ ...f.config, defaultAgents: nextSeeds });
  const upgraded = await upgradedWorkspace.execute({ method: 'GET', path: '/api/state', snapshot: oldSnapshot, scope: a.scope });
  for (const seed of nextSeeds) {
    const before = oldAgents.find(agent => agent.id === seed.id);
    const saved = upgraded.snapshot.tables.agents.find(agent => agent.id === seed.id);
    const metadata = JSON.parse(saved.metadata), priorMetadata = JSON.parse(before.metadata);
    assert.equal(saved.definition, seed.definition);
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(saved.version, 'db-v' + saved.revision);
    assert.equal(metadata.catalogDefinitionSha256, hashDefinition(seed.definition));
    assert(metadata.catalogPreviousDefinitionSha256.includes(hashDefinition(before.definition)));
    for (const [key, value] of Object.entries(priorMetadata).filter(([key]) => !key.startsWith('catalog'))) assert.deepEqual(metadata[key], value);
    assert.equal(upgraded.value.agents.find(agent => agent.id === seed.id).definition, seed.definition);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(upgraded.snapshot.tables).filter(([table]) => table !== 'agents')), retained);
  assert.equal(upgraded.snapshot.tables.sessions.find(session => session.context)?.context, oldContext);
  assert.equal(upgraded.views['/api/agents/' + a.scope.agentId + '/prompt'].definition, nextSeeds[0].definition);
  assert(upgraded.invalidates.includes('/api/agents'));
  assert.equal(f.calls.chat.length + f.calls.memory.length, calls, 'catalog maintenance never calls a model');
  const again = await upgradedWorkspace.execute({ method: 'GET', path: '/api/state', snapshot: upgraded.snapshot, scope: a.scope });
  assert.deepEqual(again.snapshot, upgraded.snapshot, 'repeat requests do not increment revision or change stored data');
  assert.equal(again.invalidates, undefined);
  const stale = await upgradedWorkspace.execute({ method: 'PATCH', path: '/api/agents/' + a.scope.agentId,
    body: { name: nextSeeds[0].name, definition: '旧编辑器提交。', revision: 1 }, snapshot: upgraded.snapshot, scope: a.scope });
  assert.equal(stale.status, 409);
  const edited = await upgradedWorkspace.execute({ method: 'PATCH', path: '/api/agents/' + a.scope.agentId,
    body: { name: nextSeeds[0].name, definition: '用户后来保存的私人定义。', revision: 2 }, snapshot: upgraded.snapshot, scope: a.scope });
  assert.equal(edited.status, 200);
  const afterEdit = await upgradedWorkspace.execute({ method: 'GET', path: '/api/state', snapshot: edited.snapshot, scope: a.scope });
  assert.equal(afterEdit.value.agents.find(agent => agent.id === a.scope.agentId).definition, '用户后来保存的私人定义。');
  assert.equal(afterEdit.value.agents.find(agent => agent.id === a.scope.agentId).revision, 3);
  const fresh = await upgradedWorkspace.execute({ method: 'GET', path: '/api/state' });
  assert(fresh.value.agents.every(agent => agent.revision === 1), 'new workspaces directly seed the latest definitions');
});

test('catalog upgrades preserve personal definition edits, renamed roles, edited legacy rows and user-created UUIDs', async () => {
  const oldSeeds = [
    { ...seeds[0], metadata: { catalogDefinitionSha256: hashDefinition(seeds[0].definition) } },
    seeds[1], { id: 'legacy-edited', name: '旧版已编辑角色', definition: '旧版原有定义。', metadata: {} },
  ];
  const nextSeeds = oldSeeds.map(seed => catalogSeed(seed, seed.definition + '\n日常一句就够。'));
  const f = fixture({ defaultAgents: oldSeeds }), a = await client(f);
  await a.send('PATCH', '/api/agents/' + oldSeeds[0].id, { name: oldSeeds[0].name, definition: '私人改写的接话习惯。', revision: 1 });
  await a.send('PATCH', '/api/agents/' + oldSeeds[1].id, { name: '私人角色名', definition: oldSeeds[1].definition, revision: 1 });
  await a.send('PATCH', '/api/agents/' + oldSeeds[2].id, { name: oldSeeds[2].name, definition: oldSeeds[2].definition, revision: 1 });
  const created = await a.send('POST', '/api/agents', { name: oldSeeds[0].name, definition: oldSeeds[0].definition });
  assert(!oldSeeds.some(seed => seed.id === created.value.agent.id));
  const before = structuredClone(a.snapshot);
  const next = await createBrowserWorkspace({ ...f.config, defaultAgents: nextSeeds }).execute({ method: 'GET', path: '/api/state', snapshot: before, scope: a.scope });
  assert.deepEqual(next.snapshot, before);
  assert.equal(next.invalidates, undefined);
});
