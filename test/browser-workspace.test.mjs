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

function eventFixture() {
  return fixture({ memoryProvider: { async chat({ messages }) {
    const { userMessages, memoryIndex } = JSON.parse(messages[1].content);
    const plan = { creates: [], updates: [], mentions: [], retractions: [], overview: null };
    for (const message of userMessages) {
      const [operation, subject] = message.text.split('|');
      const sourceMessageIds = [message.id];
      if (operation === '经历' || operation === '偏好') {
        plan.creates.push({ sourceMessageIds, kind: operation === '经历' ? 'event' : 'understanding',
          topics: [subject], summary: subject, detail: { notes: '仅保存详情，不直接带入模型' } });
      } else if (operation === '再提' || operation === '撤回') {
        const memoryId = memoryIndex.find(memory => memory.summary === subject)?.id;
        assert.ok(memoryId);
        if (operation === '再提') plan.mentions.push({ memoryId, sourceMessageIds });
        else plan.retractions.push({ memoryId, sourceMessageIds, reason: '用户要求撤回该条' });
      }
    }
    return { content: JSON.stringify(plan), receipt };
  } } });
}

function background(input) {
  assert.match(input.messages[1].content, /^【背景资料/);
  return JSON.parse(input.messages[1].content.split('\n')[1]);
}

test('browser chat adds only three event summaries ordered by actual mention while keeping the user overview', async () => {
  const f = eventFixture(), a = await client(f);
  for (const subject of ['鲸鱼海报', '野餐安排', '温室计划', '陶艺进展', '周末远足']) {
    await a.chat(`经历|${subject}|这段会话的原话`);
    f.advance(60_000);
  }
  await a.chat('偏好|喜欢先听结论');
  await a.newSession();
  f.advance(3 * 24 * 60 * 60_000);
  await a.chat('再提|鲸鱼海报');
  f.advance(60_000);
  await a.chat('撤回|温室计划');
  await a.newSession();
  const resumed = await a.chat('hello');
  const input = f.calls.chat.at(-1);
  const data = background(input);
  assert.deepEqual(data.recentEvents, [
    { summary: '鲸鱼海报', lastMentionedAt: '2026-11-18T03:05:00.000Z' },
    { summary: '周末远足', lastMentionedAt: '2026-11-15T03:04:00.000Z' },
    { summary: '陶艺进展', lastMentionedAt: '2026-11-15T03:03:00.000Z' },
  ]);
  assert.equal(data.userOverview, '喜欢先听结论');
  assert.equal(input.messages.length, 3);
  assert.equal(input.messages.at(-1).content, 'hello');
  assert.match(input.messages[0].content, /对方正在聊同一件事，或这句话需要旧事才能理解时/);
  assert.doesNotMatch(input.messages[1].content, /这段会话的原话|仅保存详情|温室计划|野餐安排/);
  const context = JSON.parse(resumed.snapshot.tables.sessions.find(row => row.status === 'open').context);
  assert.deepEqual(context.recentEvents, data.recentEvents);
  assert.deepEqual(background({ messages: context.requestMessages }), data);
});

test('event summaries are isolated by browser user and role and disappear when the scope is cleared', async () => {
  const f = eventFixture(), a = await client(f);
  const original = { ...a.scope };
  await a.chat('经历|第一位用户的计划');
  await a.newSession();
  a.select({ ...original, agentId: seeds[1].id });
  await a.chat('你好');
  assert.equal(background(f.calls.chat.at(-1)).recentEvents, undefined);
  const other = await a.send('POST', '/api/children', { name: '另一人', age: 26 });
  a.select({ ...original, childId: other.value.child.id });
  await a.chat('你好');
  assert.equal(background(f.calls.chat.at(-1)).recentEvents, undefined);
  a.select(original);
  await a.chat('你好');
  assert.deepEqual(background(f.calls.chat.at(-1)).recentEvents.map(item => item.summary), ['第一位用户的计划']);
  await a.send('POST', '/api/memory/clear', original);
  await a.chat('又见面了');
  assert.equal(background(f.calls.chat.at(-1)).recentEvents, undefined);
});

test('a new browser session starts with available memories and never backfills unprocessed conversation text', async () => {
  const f = fixture({ memoryModel: { configured: false } }), a = await client(f);
  await a.chat('蓝鲸海报的旧会话原话');
  f.advance(20 * 60_000);
  await a.chat('hello');
  const input = f.calls.chat.at(-1);
  assert.equal(background(input).recentEvents, undefined);
  assert.doesNotMatch(JSON.stringify(input.messages), /蓝鲸海报的旧会话原话/);
  assert.ok(a.snapshot.tables.jobs.some(job => job.status === 'queued'));
});

function sharedCatalog() {
  const data = { revision: 1, agents: [{ id: 'shared-chat-role', name: '大家的搭子', definition: '短句自然接话。',
    revision: 1, version: 'public-v1', createdAt: '2026-11-15T02:00:00.000Z', updatedAt: '2026-11-15T02:00:00.000Z',
    metadata: { publicCatalog: true, publicRevision: 1 } }], deletedIds: [] };
  return { data, list() { return structuredClone(data); } };
}

test('public roles synchronize across browsers while their conversations and memories remain independent', async () => {
  const catalog = sharedCatalog(), f = fixture({ catalog }), a = await client(f), b = await client(f);
  const id = catalog.data.agents[0].id;
  assert.equal(a.state.agents.find(agent => agent.id === id).publicCatalog, true);
  assert.equal(b.state.agents.find(agent => agent.id === id).definition, catalog.data.agents[0].definition);
  a.select({ ...a.scope, agentId: id }); b.select({ ...b.scope, agentId: id });
  await a.chat('我每周末独自练习吉他。'); await a.newSession();
  assert.equal(a.snapshot.tables.memories.length, 1);
  const other = await b.send('GET', '/api/state');
  assert.equal(other.snapshot.tables.memories.length, 0);
  assert.equal(other.snapshot.tables.messages.length, 0);
  const before = structuredClone(a.snapshot);
  const publicRole = catalog.data.agents[0];
  Object.assign(publicRole, { name: '改名后的公共搭子', definition: '新的公共角色设定。', revision: 2, version: 'public-v2', updatedAt: '2026-11-15T02:30:00.000Z' });
  publicRole.metadata.publicRevision = 2; catalog.data.revision++;
  const incoming = structuredClone(before);
  const forged = incoming.tables.agents.find(agent => agent.id === id);
  forged.definition = '这段客户端文本不能替换公共角色。';
  const metadata = JSON.parse(forged.metadata); metadata.legacySoul = { schemaVersion: 1 }; forged.metadata = JSON.stringify(metadata);
  const result = await f.workspace.execute({ method: 'GET', path: '/api/state', snapshot: incoming });
  const shown = result.value.agents.find(agent => agent.id === id);
  assert.equal(shown.definition, publicRole.definition); assert.equal(shown.name, publicRole.name); assert.equal(shown.revision, 2);
  assert.equal(JSON.parse(result.snapshot.tables.agents.find(agent => agent.id === id).metadata).legacySoul, undefined);
  for (const [table, rows] of Object.entries(before.tables)) if (table !== 'agents') assert.deepEqual(result.snapshot.tables[table], rows, table);
  assert(result.invalidates.includes('/api/agents'));
  const rejected = await a.send('PATCH', '/api/agents/' + id, { name: '错误编辑入口', definition: '不可更改公共库。', revision: 2 });
  assert.equal(rejected.status, 403);
  const created = await a.send('POST', '/api/agents', { name: '错误创建入口', definition: '刷新后才可创建公开角色。' });
  assert.equal(created.status, 409);
});

test('public deletion retires stale snapshots without deleting history and blocks further chats and sessions', async () => {
  const catalog = sharedCatalog(), f = fixture({ catalog }), a = await client(f), id = catalog.data.agents[0].id;
  a.select({ ...a.scope, agentId: id });
  await a.chat('我每周末练习吉他。'); const sessionId = a.snapshot.tables.sessions.find(row => row.agent_id === id).id;
  await a.newSession(); const before = structuredClone(a.snapshot), chatCalls = f.calls.chat.length;
  catalog.data.agents = []; catalog.data.deletedIds = [id]; catalog.data.revision++;
  const result = await a.send('GET', '/api/state');
  assert(!result.value.agents.some(agent => agent.id === id));
  assert.equal(JSON.parse(result.snapshot.tables.agents.find(agent => agent.id === id).metadata).hidden, true);
  assert.deepEqual(result.snapshot.tables.messages, before.tables.messages);
  assert.deepEqual(result.snapshot.tables.memories, before.tables.memories);
  assert.equal((await a.chat('此角色已下架，不应该调用模型。')).status, 410);
  assert.equal((await a.newSession()).status, 410);
  assert.equal(f.calls.chat.length, chatCalls);
  assert.equal((await a.memory()).value.items.length, 1);
  const history = await a.send('GET', '/api/sessions/' + sessionId + query(a.scope));
  assert.equal(history.value.messages[0].text, '我每周末练习吉他。');
  const forged = structuredClone(before), row = forged.tables.agents.find(agent => agent.id === id);
  row.metadata = JSON.stringify({ publicCatalog: true, hidden: false, publicDeleted: false });
  const retry = await f.workspace.execute({ method: 'POST', path: '/api/chat', snapshot: forged,
    body: { ...a.scope, text: '伪造标记不能复活已下架角色。', requestId: 'retired-role-attempt' } });
  assert.equal(retry.status, 410); assert.equal(f.calls.chat.length, chatCalls);
  assert.equal(JSON.parse(retry.snapshot.tables.agents.find(agent => agent.id === id).metadata).hidden, true);
  assert(!(await client(f)).state.agents.some(agent => agent.id === id));
});

test('local deletion is limited to legacy private roles and preserves their stored data', async () => {
  const old = fixture(), a = await client(old);
  const local = (await a.send('POST', '/api/agents', { name: '旧版私人角色', definition: '仅本机使用。' })).value.agent;
  a.select({ ...a.scope, agentId: local.id });
  await a.chat('我周末会练习吉他。'); await a.newSession();
  const before = structuredClone(a.snapshot);
  const catalog = sharedCatalog(), f = fixture({ catalog }), current = await client(f, before);
  current.select(a.scope);
  assert(!catalog.list().agents.some(agent => agent.id === local.id));
  assert.equal(current.state.agents.find(agent => agent.id === local.id).publicCatalog, undefined);
  assert.equal((await current.send('DELETE', '/api/agents/' + seeds[0].id, { revision: 1 })).status, 403);
  assert.equal((await current.send('DELETE', '/api/agents/' + catalog.data.agents[0].id, { revision: 1 })).status, 403);
  const result = await current.send('DELETE', '/api/agents/' + local.id, { revision: local.revision });
  assert.equal(result.status, 200); assert.equal(result.value.deleted, true);
  assert(!result.views['/api/state'].agents.some(agent => agent.id === local.id));
  assert.deepEqual(result.snapshot.tables.messages, before.tables.messages);
  assert.deepEqual(result.snapshot.tables.memories, before.tables.memories);
  assert.equal((await current.send('DELETE', '/api/agents/' + local.id, { revision: local.revision })).status, 200);
  assert.equal((await current.chat('删除后不再开始新的聊天。')).status, 410);
});

test('a public role ID collision rejects the request without taking over a private role', async () => {
  const f = fixture(), a = await client(f);
  const local = (await a.send('POST', '/api/agents', { name: '私人角色', definition: '保留这个定义。' })).value.agent;
  const before = structuredClone(a.snapshot), catalog = sharedCatalog();catalog.data.agents[0].id = local.id;
  const shared = createBrowserWorkspace({ ...f.config, catalog });
  await assert.rejects(shared.execute({ method: 'GET', path: '/api/state', snapshot: before }), error => error.status === 409);
  assert.deepEqual(a.snapshot, before);
});

test('a role retired during a model response is hidden in the final saved workspace', async () => {
  const catalog = sharedCatalog(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ catalog, provider: { async chat() {
    entered(); await blocked; return { content: '已经完成的本轮回复。', toolCalls: [], receipt };
  } } }), a = await client(f), id = catalog.data.agents[0].id;
  a.select({ ...a.scope, agentId: id });
  const pending = a.chat('开始之后才下架。'); await started;
  catalog.data.agents = []; catalog.data.deletedIds = [id]; catalog.data.revision++;
  release(); const result = await pending;
  assert(result.events.some(event => event.type === 'done'));
  assert(!result.views['/api/state'].agents.some(agent => agent.id === id));
  assert.equal(result.snapshot.tables.messages.at(-1).text, '已经完成的本轮回复。');
  assert.equal(JSON.parse(result.snapshot.tables.agents.find(agent => agent.id === id).metadata).hidden, true);
});

test('retired roles remain available to their already queued memory extraction', async () => {
  const catalog = sharedCatalog(), f = fixture({ catalog }), a = await client(f), id = catalog.data.agents[0].id;
  a.select({ ...a.scope, agentId: id }); await a.chat('每周末练习吉他。');
  catalog.data.agents = []; catalog.data.deletedIds = [id]; catalog.data.revision++;
  f.advance(15 * 60_000 + 1);
  const result = await a.send('GET', '/api/state');
  assert(!result.value.agents.some(agent => agent.id === id));
  assert.equal(result.snapshot.tables.jobs.find(job => job.agent_id === id).status, 'succeeded');
  assert.equal(result.snapshot.tables.memories.find(memory => memory.agent_id === id).summary, '用户每周末练习吉他。');
  assert.equal(f.calls.memory.length, 1);
});

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

test('old browser snapshots migrate delivered mentor context to the target session once', async () => {
  const f = fixture(), a = await client(f);
  const source = a.scope;
  const turn = await a.chat('请帮我找一个角色。');
  const cardId = turn.snapshot.tables.runs.at(-1).id;
  const target = { ...source, agentId: f.config.defaultAgents[1].id };
  a.select(target);
  const destination = (await a.newSession()).value.session.id;
  const legacy = structuredClone(a.snapshot);
  for (const session of legacy.tables.sessions) delete session.mentor_handoff;
  const original = legacy.tables.runs.find(row => row.id === cardId);
  original.mentor_recommendation = JSON.stringify({
    mentorId: target.agentId,
    card: { mentor: { id: target.agentId, name: '公开角色乙' }, copy: '公开卡片', state: 'visited', brief: { goal: '这次转介的目标' } },
    handoff: { targetSessionId: destination, arrivedAt: '2026-11-15T03:00:00.000Z', lastUserSeq: 0,
      brief: { goal: '这次转介的目标', progress: '转介时准备的私有摘要' } },
  });
  const path = `/api/sessions/${destination}${query(target)}`;
  const migrated = await f.workspace.execute({ method: 'GET', path, scope: target, snapshot: legacy });
  const received = migrated.snapshot.tables.sessions.find(row => row.id === destination);
  assert.deepEqual(JSON.parse(received.mentor_handoff), {
    cardId, sourceAgentId: source.agentId,
    brief: { goal: '这次转介的目标', progress: '转介时准备的私有摘要', sourceAgentName: '公开角色甲' },
    lastUserSeq: 0, arrivedAt: '2026-11-15T03:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(migrated.value), /转介时准备的私有摘要|mentor_handoff/);

  const next = migrated.snapshot;
  next.tables.runs.find(row => row.id === cardId).mentor_recommendation = null;
  const restored = await f.workspace.execute({ method: 'GET', path, scope: target, snapshot: next });
  assert.equal(restored.snapshot.tables.sessions.find(row => row.id === destination).mentor_handoff, received.mentor_handoff);
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

test('adding managed stock viewpoints imports missing roles once without changing existing data or private edits', async () => {
  const f = fixture(), a = await client(f);
  await a.chat('我每周末练习吉他。');
  const before = structuredClone(a.snapshot);
  const extra = catalogSeed({ id: 'new-viewpoint', name: '新增视角', definition: '原始试验设定。', metadata: {} }, '新人物视角。');
  const workspace = createBrowserWorkspace({ ...f.config, defaultAgents: [...seeds, extra] });
  const updated = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: before });
  assert.equal(updated.value.agents.find(agent => agent.id === extra.id).definition, extra.definition);
  for (const [table, rows] of Object.entries(before.tables)) {
    if (table !== 'agents') assert.deepEqual(updated.snapshot.tables[table], rows, table);
  }
  for (const row of before.tables.agents) assert.deepEqual(updated.snapshot.tables.agents.find(a => a.id === row.id), row);
  const repeated = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: updated.snapshot });
  assert.deepEqual(repeated.snapshot.tables.agents, updated.snapshot.tables.agents);
  const edited = structuredClone(repeated.snapshot);
  const row = edited.tables.agents.find(agent => agent.id === extra.id);
  row.definition = '用户编辑过的新视角。'; row.revision = 2; row.version = 'db-v2';
  const retained = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: edited });
  assert.equal(retained.value.agents.find(agent => agent.id === extra.id).definition, row.definition);
});

test('retired defaults disappear and reject new chat while their edits, history and memories stay intact', async () => {
  const f = fixture(), a = await client(f);
  await a.chat('我每周末练习吉他。');
  await a.newSession();
  const before = structuredClone(a.snapshot);
  const role = before.tables.agents.find(row => row.id === seeds[0].id);
  role.name = '我私改过的名字';
  role.definition = '我私改过的人设。';
  const preserved = Object.fromEntries(Object.entries(before.tables).filter(([table]) => table !== 'agents'));
  const calls = f.calls.chat.length + f.calls.memory.length;
  const workspace = createBrowserWorkspace({ ...f.config, retiredAgentIds: [seeds[0].id] });
  const result = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: before });
  assert.deepEqual(result.value.agents.map(row => row.id), [seeds[1].id]);
  assert.deepEqual(Object.fromEntries(Object.entries(result.snapshot.tables).filter(([table]) => table !== 'agents')), preserved);
  const saved = result.snapshot.tables.agents.find(row => row.id === role.id);
  assert.deepEqual({ ...saved, metadata: role.metadata }, role, 'role edits and revision stay intact');
  assert.deepEqual(JSON.parse(saved.metadata), { ...JSON.parse(role.metadata), hidden: true });
  assert(result.invalidates.includes('/api/agents'));
  const blocked = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: result.snapshot, scope: a.scope,
    body: { ...a.scope, text: '再聊一句', requestId: 'retired-default' } });
  assert.equal(blocked.status, 410);
  assert.equal(f.calls.chat.length + f.calls.memory.length, calls);
  assert.deepEqual(blocked.snapshot.tables.messages, before.tables.messages);
  const again = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: result.snapshot });
  assert.deepEqual(again.snapshot, result.snapshot, 'retirement is idempotent');
  const fresh = await workspace.execute({ method: 'GET', path: '/api/state' });
  assert.deepEqual(fresh.value.agents.map(row => row.id), [seeds[1].id]);
});

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

test('managed viewpoint names migrate in place while manual names and definitions remain untouched', async () => {
  const original = { ...catalogSeed(seeds[0], '旧视角正文。'), name: '旧人物 · 思考视角' };
  const next = { ...catalogSeed(original, '完整人物正文。'), name: '完整人物',
    metadata: { ...catalogSeed(original, '完整人物正文。').metadata, catalogPreviousNames: [original.name],
      description: 'AI人物演绎', nuwaSource: { adaptationVersion: 'whole-person-v2' },
      card: { role: '完整人物 · AI人物演绎', personality: '完整性格' } } };
  const f = fixture({ defaultAgents: [original] }), a = await client(f);
  await a.chat('我最近在读书。');
  const before = structuredClone(a.snapshot);
  const workspace = createBrowserWorkspace({ ...f.config, defaultAgents: [next] });
  const updated = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: before });
  const agent = updated.value.agents[0];
  assert.equal(agent.id, original.id);
  assert.equal(agent.name, next.name);
  assert.equal(agent.definition, next.definition);
  assert.equal(agent.card.identity.role, next.metadata.card.role);
  for (const [table, rows] of Object.entries(before.tables)) {
    if (table !== 'agents') assert.deepEqual(updated.snapshot.tables[table], rows, table);
  }
  const repeated = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: updated.snapshot });
  assert.deepEqual(repeated.snapshot, updated.snapshot);
  for (const field of ['name', 'definition']) {
    const edited = structuredClone(before);
    edited.tables.agents[0][field] = '用户的私人修改';
    const preserved = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: edited });
    assert.equal(preserved.value.agents[0][field], '用户的私人修改');
  }
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


test('a repeated memory mention may anchor in a later session of the same scope, but never another role', async () => {
  const f = fixture(), a = await client(f);
  await a.chat('我每周末练习吉他。');
  await a.newSession();
  const first = structuredClone(a.snapshot.tables.memories[0]);
  await a.chat('我还是每周末练习吉他。');
  await a.newSession();
  const touched = a.snapshot.tables.memories[0];
  assert.equal(touched.id, first.id);
  assert.equal(touched.session_id, first.session_id, 'creation session remains unchanged');
  assert.notEqual(touched.anchor_id, first.anchor_id, 'latest mention uses a new user message');
  const before = structuredClone(a.snapshot);
  const restored = await a.send('GET', '/api/state');
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.snapshot.tables.memories, before.tables.memories);
  assert.deepEqual(restored.snapshot.tables.messages, before.tables.messages);
  a.select({ ...a.scope, agentId: seeds[1].id });
  await a.chat('这是另一个角色的消息。');
  const forged = structuredClone(a.snapshot);
  const otherSession = forged.tables.sessions.find(row => row.agent_id === seeds[1].id);
  forged.tables.memories[0].anchor_id = forged.tables.messages.find(row => row.session_id === otherSession.id && row.role === 'user').id;
  const unchanged = structuredClone(forged);
  await assert.rejects(f.workspace.execute({ method: 'GET', path: '/api/state', snapshot: forged }), /浏览器工作区格式无效/);
  assert.deepEqual(forged, unchanged, 'invalid input is not modified');
});
