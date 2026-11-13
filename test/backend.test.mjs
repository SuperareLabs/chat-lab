import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createLabServer } from '../server.mjs';
import { MEMORY_REPAIR_PROMPT } from '../lib/memory-repair.mjs';
import { validateMemoryOutput } from '../lib/memory.mjs';
import { createProvider } from '../lib/provider.mjs';
import { COMMON_PROMPT, MEMORY_PROMPT, loadSouls, renderSoul } from '../lib/prompts.mjs';
import { ChatStore } from '../lib/store.mjs';

const turnId = (text, id) => ({ id, type: 'function', function: text });
const modelTool = (name, args, id = 'tool-' + name) => turnId({ name, arguments: JSON.stringify(args) }, id);

async function fixture(t, provider, options = {}) {
  const lab = createLabServer({ provider, ...options });
  const { port } = await lab.listen(0);
  t.after(() => lab.close());
  const url = 'http://127.0.0.1:' + port;
  const request = (path, body, headers = {}) => fetch(url + path, body === undefined ? { headers } : {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
  });
  const json = async (path, body, status = 200) => {
    const response = await request(path, body);
    assert.equal(response.status, status, path);
    return response.json();
  };
  const chat = async (scope, sessionId, input, requestId = crypto.randomUUID()) => {
    const content = Array.isArray(input) ? { messages: input } : { text: input };
    const response = await request('/api/chat', { ...scope, sessionId, ...content, requestId });
    if (response.status !== 200) assert.fail(JSON.stringify(await response.json()));
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    return (await response.text()).trim().split(/\n\n/).filter(Boolean).map(line => JSON.parse(line.slice(6)));
  };
  const child = async (name = '测试小禾') => (await json('/api/children', { name, age: 8, interests: ['积木'] }, 201)).child;
  const newSession = async scope => (await json('/api/sessions', scope, 201)).session;
  return { lab, request, json, chat, child, newSession };
}

const query = scope => '?' + new URLSearchParams(scope);
const reply = (options, text = '这架纸飞机真能飞。') => {
  const parts = [text.slice(0, 3), text.slice(3)];
  parts.forEach(part => options.onDelta?.(part));
  return { content: text, toolCalls: [], receipt: { finish_reason: 'stop' } };
};
const memoryPlan = items => ({
  creates: items.map(item => ({ kind: 'event', topics: [], ...item })),
  updates: [], mentions: [], retractions: [], overview: null,
});
const memoryResponse = items => ({ content: JSON.stringify(memoryPlan(items.map(({ anchorMessageId, ...item }) => item))), receipt: { finish_reason: 'stop' } });

async function until(read, predicate) {
  for (let i = 0; i < 80; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(10);
  }
  assert.fail('condition not reached');
}

test('version changes clear the local lab database and same-version restarts preserve it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'croco-lab-version-'));
  const dbPath = join(directory, 'chat.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = {
    async chat(options) {
      if (options.responseFormat) {
        const { userMessages: messages } = JSON.parse(options.messages[1].content);
        const source = messages[0];
        return memoryResponse([{ anchorMessageId: source.id, sourceMessageIds: [source.id], summary: '旧版会话摘要' }]);
      }
      return reply(options);
    },
  };
  const souls = loadSouls();
  const clock = () => new Date('2026-11-11T08:00:00Z');
  const tables = ['profile_writes', 'memories', 'jobs', 'runs', 'messages', 'sessions', 'soul_profiles', 'children'];
  let scope;
  let memoryId;
  let sessionId;
  let firstVersion;
  let firstChildren;

  const legacy = new ChatStore(dbPath);
  legacy.createChild({ name: '旧版测试孩子', age: 8, interests: [] }, clock().toISOString());
  legacy.close();

  await t.test('first activation replaces legacy data with one default child before accepting chats', async st => {
    const f = await fixture(st, provider, { dbPath, souls, clock });
    const state = await f.json('/api/state');
    assert.equal(state.children.length, 1);
    const [child] = state.children;
    assert.deepEqual(child, { id: child.id, name: '马超', age: 8, interests: [] });
    assert.equal(f.lab.store.sql('SELECT created_at FROM children WHERE id = ?').get(child.id).created_at, clock().toISOString());
    firstVersion = state.dataVersion;
    scope = { childId: child.id, agentId: state.agents[0].id };
    const session = await f.newSession(scope);
    sessionId = session.id;
    const events = await f.chat(scope, session.id, '以后叫我小禾。');
    assert.equal(events.at(-1).type, 'done');
    assert.equal((await f.chat(scope, session.id, '我今年9岁了。')).at(-1).type, 'done');
    // Legacy profile data remains part of persistence/reset coverage even though
    // chat tools can no longer create or change it.
    f.lab.store.sql('UPDATE children SET age = 9 WHERE id = ?').run(child.id);
    f.lab.store.sql('INSERT INTO soul_profiles(child_id,agent_id,profile) VALUES(?,?,?)')
      .run(child.id, scope.agentId, JSON.stringify({ preferred_name: '小禾', interest: [], conversation_preference: [] }));
    const oldRun = f.lab.store.sql('SELECT id,user_id FROM runs WHERE session_id = ? ORDER BY rowid LIMIT 1').get(session.id);
    f.lab.store.sql('INSERT INTO profile_writes(run_id,field,operation,value,source_id,result,written_at) VALUES(?,?,?,?,?,?,?)')
      .run(oldRun.id, 'preferred_name', 'set', JSON.stringify('小禾'), oldRun.user_id,
        JSON.stringify({ status: 'updated', field: 'preferred_name', value: '小禾' }), clock().toISOString());
    await f.child('手动创建孩子');
    firstChildren = (await f.json('/api/state')).children;
    assert.equal(firstChildren.find(item => item.id === child.id).age, 9);
    await f.newSession(scope);
    const data = await until(() => f.json('/api/memory' + query(scope)), value => value.items.length === 1);
    memoryId = data.items[0].memoryId;
    for (const table of tables) assert.ok(f.lab.store.sql(`SELECT count(*) AS n FROM ${table}`).get().n, table);
  });

  await t.test('restarting the same version keeps the exact child, session, and memory', async st => {
    const beforeBatchSupport = new ChatStore(dbPath);
    beforeBatchSupport.db.exec('ALTER TABLE runs DROP COLUMN user_count');
    beforeBatchSupport.close();
    const f = await fixture(st, provider, { dbPath, souls, clock });
    const state = await f.json('/api/state');
    assert.equal(state.dataVersion, firstVersion);
    assert.deepEqual(state.children, firstChildren, 'same version neither duplicates nor resets the default child');
    assert.equal(state.children.find(item => item.id === scope.childId).age, 9);
    assert.equal((await f.json('/api/memory' + query(scope))).items[0].memoryId, memoryId);
    assert.equal((await f.json('/api/sessions/' + sessionId + query(scope))).messages.length, 4);
    assert.equal(f.lab.store.sql('SELECT user_count FROM runs').get().user_count, 1);
  });

  await t.test('a changed SOUL prompt clears even old request, memory, and profile rows', async st => {
    const edited = new Map(souls);
    const original = edited.get(scope.agentId);
    edited.set(scope.agentId, original.schemaVersion === 2
      ? { ...original, definition: `${original.definition}新版。` }
      : { ...original, speakingStyle: `${original.speakingStyle}新版。` });
    const f = await fixture(st, provider, { dbPath, souls: edited, clock });
    const state = await f.json('/api/state');
    assert.notEqual(state.dataVersion, firstVersion);
    assert.equal(state.children.length, 1);
    const [child] = state.children;
    assert.notEqual(child.id, scope.childId);
    assert.deepEqual(child, { id: child.id, name: '马超', age: 8, interests: [] });
    for (const table of tables) assert.equal(f.lab.store.sql(`SELECT count(*) AS n FROM ${table}`).get().n, table === 'children' ? 1 : 0, table);
    await f.json('/api/memory/' + memoryId + query(scope), undefined, 404);
    await f.json('/api/sessions/' + sessionId + query(scope), undefined, 404);
  });
});

test('localhost navigation works; cross-site API, scope errors and disabled tools are protected', async t => {
  const calls = [];
  const f = await fixture(t, { async chat(options) { calls.push(options); return reply(options); } });
  const landing = await f.request('/', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type'), /text\/html/);
  const blocked = await f.request('/api/state', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(blocked.status, 403);
  const unsafe = await f.request('/api/children', { name: '恶意' }, { Origin: 'https://other.example' });
  assert.equal(unsafe.status, 403);

  const state = await f.json('/api/state');
  assert.equal(state.model.mode, 'test');
  assert.equal(state.agents.length, 3);
  assert.equal(state.children.length, 1);
  assert.deepEqual(state.children[0], { id: state.children[0].id, name: '马超', age: 8, interests: [] });
  const benny = state.agents.find(agent => agent.name === '鳄鱼爸爸');
  const pinecone = state.agents.find(agent => agent.id === 'pinecone-lab');
  const xiaoman = state.agents.find(agent => agent.id === 'lin-xiaoman');
  const bennySoul = loadSouls().get(benny.id);
  assert.deepEqual(benny.card.identity, bennySoul.identity);
  assert.deepEqual(benny.card.specialties, bennySoul.specialties);
  assert.equal(benny.card.personality, bennySoul.card.personality);
  assert.notEqual(benny.card.personality, bennySoul.personality);
  assert.equal(benny.card.dailyLife, undefined);
  assert.equal(pinecone.card.theme, 'amber');
  assert.equal(xiaoman.name, '林小满');
  assert.equal(xiaoman.card.voice, undefined, 'public defaults have no private reference audio');
  const xiaomanPrompt = await f.json('/api/agents/lin-xiaoman/prompt');
  assert.match(xiaomanPrompt.role, /林小满/);
  assert.match(xiaomanPrompt.role, /【背景】/);
  assert.match(xiaomanPrompt.role, /【日常】/);
  assert.doesNotMatch(xiaomanPrompt.system, /guhan-reference|实时语音尚未接入/);
  const child = await f.child();
  const scope = { childId: child.id, agentId: state.agents[0].id };
  const session = await f.newSession(scope);
  const events = await f.chat(scope, session.id, '我看到一架纸飞机。', 'same');
  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '这架纸飞机真能飞。');
  const repeated = await f.chat(scope, session.id, '我看到一架纸飞机。', 'same');
  assert.equal(repeated.at(-1).type, 'done');
  assert.equal(calls.length, 1, 'same request ID replays stored text');
  const detail = await f.json('/api/sessions/' + session.id + query(scope));
  assert.deepEqual(detail.messages.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(detail.context.tools.map(t => t.function.name), [
    'recall_memory', 'get_memory_detail', 'calculate',
  ]);
  assert.match(detail.context.system, /鳄鱼爸爸/);
  assert.doesNotMatch(detail.context.system, /【日常】|松果/);
  assert.equal(detail.context.requestMessages.at(-1).content, '我看到一架纸飞机。');
  assert.equal(detail.context.localTime.timezone, 'Asia/Shanghai');
  const aliasScope = { ...scope, agentId: 'croco-lab' };
  assert.equal((await f.json('/api/sessions' + query(aliasScope))).sessions[0].id, session.id);
  const otherScope = { ...scope, agentId: state.agents.find(item => item.id === 'pinecone-lab').id };
  await f.json('/api/sessions/' + session.id + query(otherScope), undefined, 404);
  const misuse = await f.request('/api/chat', { ...otherScope, sessionId: session.id, text: '越界', requestId: 'wrong' });
  assert.equal(misuse.status, 404);
});

test('LAN access serves the complete chat flow while rejecting other hosts and origins', async t => {
  const address = Object.values(networkInterfaces()).flat().find(item =>
    item.family === 'IPv4' && !item.internal &&
    /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address)
  )?.address;
  if (!address) {
    t.skip('No attached private IPv4 interface is available');
    return;
  }
  const calls = [];
  const f = await fixture(t, {
    async chat(options) {
      calls.push(structuredClone(options.messages));
      return reply(options, '在，局域网也能接住。');
    },
  }, { host: '0.0.0.0' });
  const { port } = f.lab.server.address();
  const origin = `http://${address}:${port}`;
  const request = (path, body, headers = {}) => fetch(origin + path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Origin: origin, ...headers },
    signal: AbortSignal.timeout(5000),
  });
  const stateResponse = await request('/api/state');
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.children[0].name, '马超');
  const landing = await request('/');
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /id="agent-select"/);
  const script = await request('/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const prompt = await request('/api/agents/' + state.agents[0].id + '/prompt');
  assert.equal(prompt.status, 200);
  assert.equal((await prompt.json()).version, f.lab.runtime.souls.get(state.agents[0].id).version);
  assert.equal((await f.request('/api/state')).status, 200, 'loopback still works');

  const scope = { childId: state.children[0].id, agentId: state.agents[0].id };
  const sessionResponse = await request('/api/sessions', scope);
  assert.equal(sessionResponse.status, 201);
  const { session } = await sessionResponse.json();
  const messages = [{ text: '在吗' }, { text: '我用局域网来找你。' }];
  const response = await request('/api/chat', { ...scope, sessionId: session.id, requestId: 'lan-chat', messages });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).trim().split(/\n\n/).filter(Boolean).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '在，局域网也能接住。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1).content, messages.map(message => message.text).join('\n'));
  const detailResponse = await request('/api/sessions/' + session.id + query(scope));
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.deepEqual(detail.messages.map(message => [message.role, message.text]), [
    ['user', '在吗'], ['user', '我用局域网来找你。'], ['assistant', '在，局域网也能接住。'],
  ]);

  const wrongPort = port === 65535 ? 65534 : port + 1;
  const statusWithHost = host => new Promise((resolve, reject) => {
    const raw = httpRequest(origin + '/api/state', { headers: { Host: host } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    raw.setTimeout(5000, () => raw.destroy(new Error('Host validation request timed out')));
    raw.once('error', reject);
    raw.end();
  });
  for (const host of [`other.example:${port}`, `${address}:${wrongPort}`, `192.0.2.1:${port}`]) {
    assert.equal(await statusWithHost(host), 403, host);
  }
  for (const headers of [
    { Origin: 'https://other.example' },
    { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await request('/api/state', undefined, headers)).status, 403, JSON.stringify(headers));
  assert.equal(calls.length, 1, 'invalid origins never invoke the provider');
});

test('prompt details expose the active system text without creating a child or invoking the provider', async t => {
  const calls = [];
  const f = await fixture(t, {
    async chat(options) {
      calls.push(structuredClone(options.messages));
      return reply(options);
    },
  });
  const state = await f.json('/api/state');
  assert.equal(state.children.length, 1);
  for (const agent of state.agents) {
    const path = '/api/agents/' + encodeURIComponent(agent.id) + '/prompt';
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const detail = await response.json();
    const soul = f.lab.runtime.souls.get(agent.id);
    assert.deepEqual(Object.keys(detail).sort(), [
      'agentId', 'common', 'contextBrief', 'dataVersion', 'memory', 'memoryModel', 'memoryRepair', 'memoryReview', 'model', 'name', 'role', 'system', 'version',
    ]);
    assert.equal(detail.agentId, agent.id);
    assert.equal(detail.name, agent.name);
    assert.equal(detail.version, soul.version);
    assert.equal(detail.model, state.model.name);
    assert.equal(detail.dataVersion, state.dataVersion);
    assert.equal(detail.system, f.lab.runtime.systems.get(agent.id));
    assert.equal(detail.system, renderSoul(soul));
    assert.equal(detail.common, COMMON_PROMPT);
    assert.equal(detail.memory, MEMORY_PROMPT);
    assert.equal(detail.memoryReview, '', 'the retired review prompt is not advertised as active');
    assert.equal(detail.memoryRepair, MEMORY_REPAIR_PROMPT);
    assert.equal(detail.system, detail.common + '\n\n' + detail.role);
    assert.equal(detail.role.startsWith(soul.schemaVersion === 2 ? '【名称】' : '【身份】'), true);
    assert.equal((await f.request(path, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await f.request(path, undefined, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await f.request(path, {})).status, 404);
  }
  const alias = await f.json('/api/agents/croco-lab/prompt');
  assert.equal(alias.agentId, state.agents[0].id);
  assert.equal(alias.version, f.lab.runtime.souls.get(alias.agentId).version);
  await f.json('/api/agents/missing/prompt', undefined, 404);
  await f.json('/api/agents/%ZZ/prompt', undefined, 404);
  assert.deepEqual((await f.json('/api/state')).children, state.children);
  assert.equal(calls.length, 0);

  const scope = { childId: (await f.child()).id, agentId: alias.agentId };
  await f.chat(scope, null, '在吗');
  assert.equal(calls[0][0].role, 'system');
  assert.equal(calls[0][0].content, alias.system, 'details are the same bytes sent to the model');
  const activeSoul = f.lab.runtime.souls.get(alias.agentId);
  const changed = activeSoul.schemaVersion === 2
    ? { ...activeSoul, definition: 'changed only in config memory' }
    : { ...activeSoul, speakingStyle: 'changed only in config memory' };
  f.lab.runtime.souls.set(alias.agentId, changed);
  assert.equal((await f.json('/api/agents/' + alias.agentId + '/prompt')).system, alias.system,
    'details use the active runtime system rather than rendering the config again');
});

test('a chat batch keeps each bubble and sends one combined turn to the provider', async t => {
  const calls = [];
  const f = await fixture(t, {
    async chat(options) {
      calls.push(structuredClone(options.messages));
      return reply(options, '那笔账记着。\n三遍，成交。');
    },
  }, { clock: () => new Date('2026-11-11T08:00:02Z') });
  const [agent] = (await f.json('/api/state')).agents;
  const scope = { childId: (await f.child()).id, agentId: agent.id };
  const messages = [
    { text: '你写三个就行。', createdAt: '2026-11-11T08:00:01.000Z' },
    { text: '剩下七个算你欠着。', createdAt: '2026-11-11T08:00:01.200Z' },
  ];
  const combined = messages.map(message => message.text).join('\n');
  const requestId = 'chat-batch';
  const events = await f.chat(scope, null, messages, requestId);
  const { sessionId } = events[0];
  assert.equal(events.at(-1).type, 'done');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(2), [{ role: 'user', content: combined }]);

  const detailPath = '/api/sessions/' + sessionId + query(scope);
  const detail = await f.json(detailPath);
  assert.deepEqual(detail.messages.slice(0, 2).map(({ id, role, ...message }) => message), messages);
  assert.deepEqual(detail.messages.map(message => message.role), ['user', 'user', 'assistant']);
  assert.equal(detail.messages[2].text, '那笔账记着。\n三遍，成交。');
  assert.equal(detail.context.requestMessages.at(-1).content, combined);

  assert.deepEqual((await f.chat(scope, sessionId, messages, requestId)).filter(event => !['usage', 'tool_usage'].includes(event.type)), [
    { type: 'start', sessionId }, { type: 'delta', text: '那笔账记着。\n三遍，成交。' }, { type: 'done', sessionId },
  ]);
  assert.equal(calls.length, 1);
  assert.equal((await f.request('/api/chat', { ...scope, sessionId, text: combined, requestId })).status, 409);
  assert.equal((await f.request('/api/chat', {
    ...scope, sessionId, text: combined, messages, requestId: 'invalid-mixed-format',
  })).status, 400);
  await f.chat(scope, sessionId, '好，成交。');
  assert.deepEqual(calls[1].slice(2), [
    { role: 'user', content: combined },
    { role: 'assistant', content: '那笔账记着。\n三遍，成交。' },
    { role: 'user', content: '好，成交。' },
  ]);
});

test('15-minute cutoff, unfinished extraction, cross-day deduplication, mention history and scoped recall', async t => {
  let instant = new Date('2026-11-10T15:55:00.000Z');
  let allowExtraction;
  const extractionGate = new Promise(resolve => { allowExtraction = resolve; });
  let extracted = 0;
  let firstMemoryId;
  const f = await fixture(t, {
    async chat(options) {
      if (options.responseFormat) {
        extracted++;
        const { userMessages: messages } = JSON.parse(options.messages[1].content);
        const sources = messages;
        if (!sources.some(source => source.text.includes('纸飞机比赛'))) return memoryResponse([]);
        await extractionGate;
        return memoryResponse(sources.map(source => ({
          anchorMessageId: source.id, sourceMessageIds: [source.id], summary: '聊到上个月的纸飞机比赛',
          detail: { occurredAt: '2026-10-18', event: '纸飞机比赛', place: '操场' },
        })));
      }
      const last = options.messages.at(-1);
      if (last.role === 'user' && last.content === '查一下纸飞机的细节。') {
        return { content: '', toolCalls: [
          modelTool('recall_memory', { query: '纸飞机', fromDate: '2026-11-10', toDate: '2026-11-10' }),
          modelTool('get_memory_detail', { memoryId: firstMemoryId }),
        ] };
      }
      return reply(options);
    },
  }, { clock: () => new Date(instant) });
  t.after(allowExtraction);
  const [benny, pine] = (await f.json('/api/state')).agents;
  const child = await f.child();
  const other = await f.child('另一孩子');
  const scope = { childId: child.id, agentId: benny.id };
  const session = await f.newSession(scope);
  await f.chat(scope, session.id, '上个月的纸飞机比赛在操场。');
  instant = new Date('2026-11-10T16:01:00.000Z');
  await f.chat(scope, session.id, '再聊上个月的纸飞机比赛。');
  instant = new Date('2026-11-10T16:15:59.999Z');
  assert.equal((await f.json('/api/sessions' + query(scope))).sessions[0].status, 'open');

  instant = new Date('2026-11-10T16:16:00.000Z');
  const auto = await f.chat(scope, session.id, '我又来了。');
  const fresh = auto[0].sessionId;
  assert.notEqual(fresh, session.id);
  assert.equal((await f.json('/api/sessions/' + fresh + query(scope))).context.userOverview.summary, '');
  assert.equal((await f.json('/api/memory' + query(scope))).jobs[0].status, 'running');
  allowExtraction();
  const archived = await until(() => f.json('/api/memory' + query(scope)), value => value.items.length === 1);
  assert.deepEqual(archived.items.map(item => item.mentionedOn), ['2026-11-11']);
  assert.equal(new Set(archived.items.map(item => item.memoryId)).size, 1);
  assert.ok(archived.items.every(item => !('detail' in item)));
  firstMemoryId = archived.items[0].memoryId;
  const detailPath = '/api/memory/' + firstMemoryId;
  assert.equal((await f.json(detailPath + query(scope))).item.detail.occurredAt, '2026-10-18');
  await f.json(detailPath + query({ ...scope, childId: other.id }), undefined, 404);
  await f.json(detailPath + query({ ...scope, agentId: pine.id }), undefined, 404);

  instant = new Date('2026-11-10T16:17:00.000Z');
  const next = await f.newSession(scope);
  await f.chat(scope, next.id, '查一下纸飞机的细节。');
  const { context } = await f.json('/api/sessions/' + next.id + query(scope));
  assert.equal(context.recentMemories, undefined);
  assert.equal(context.userOverview.summary, '');
  assert.equal(context.toolCalls[0].result.status, 'matched');
  assert.equal(context.toolCalls[0].result.items.length, 1);
  assert.equal(context.toolCalls[1].result.item.detail.place, '操场');
  assert.equal(context.requestMessages.at(-1).role, 'tool');
  assert.equal((await f.json('/api/memory' + query({ ...scope, agentId: pine.id }))).items.length, 0);
  assert.ok(extracted >= 1);
});

test('removed profile tools are not advertised and cannot mutate shared or role-specific profiles', async t => {
  const f = await fixture(t, {
    async chat(options) {
      if (options.responseFormat) return memoryResponse([]);
      const last = options.messages.at(-1);
      if (last.role === 'user' && last.content.includes('九岁')) return {
        content: '', toolCalls: [
          modelTool('update_child_profile', { field: 'age', operation: 'set', value: 9 }, 'age'),
          modelTool('update_child_profile', { field: 'interest', operation: 'add', value: '画画' }, 'interest'),
          modelTool('update_child_profile', { field: 'name', operation: 'set', value: '捏造的名字' }, 'fake'),
          modelTool('forget_memory', { id: 'pretend' }, 'legacy'),
        ],
      };
      return reply(options, '我听到了。');
    },
  });
  const [benny, pine] = (await f.json('/api/state')).agents;
  const child = await f.child();
  const bennyScope = { childId: child.id, agentId: benny.id };
  const pineScope = { childId: child.id, agentId: pine.id };
  const session = await f.newSession(bennyScope);
  const result = await f.chat(bennyScope, session.id, '我已经九岁了。帮我记住，我喜欢画画。');
  assert.equal(result.at(-1).type, 'done');
  const inspector = await f.json('/api/sessions/' + session.id + query(bennyScope));
  assert.ok(inspector.context.tools.every(tool => tool.function.name !== 'update_child_profile'));
  assert.deepEqual(inspector.context.toolCalls.map(call => call.result.status), ['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  const first = (await f.json('/api/memory' + query(bennyScope))).profile;
  const second = (await f.json('/api/memory' + query(pineScope))).profile;
  assert.equal(first.childProfile.age, 8);
  assert.equal(second.childProfile.age, 8);
  assert.equal(first.childProfile.name, child.name);
  assert.deepEqual(first.soulProfile.interest, []);
  assert.deepEqual(second.soulProfile.interest, []);
  assert.equal(f.lab.store.sql('SELECT COUNT(*) n FROM profile_writes').get().n, 0);
});

test('archive validation rejects spoofed or invalid source and date; SOUL optional fields are ordered', () => {
  const source = [{ id: 'good', role: 'user', text: '在聊旧事', createdAt: '2026-11-11T00:00:00.000Z' }];
  const invalid = data => () => validateMemoryOutput(JSON.stringify(memoryPlan([data])), source, 'Asia/Shanghai');
  assert.throws(invalid({ anchorMessageId: 'elsewhere', sourceMessageIds: ['elsewhere'], summary: '伪造' }), /来源|消息|会话/);
  assert.throws(invalid({ anchorMessageId: 'good', sourceMessageIds: ['good'], summary: '旧事', detail: { occurredAt: '2026-02-30' } }), /日期/);
  assert.equal(validateMemoryOutput(JSON.stringify(memoryPlan([])), source, 'Asia/Shanghai').creates.length, 0);
  assert.throws(() => validateMemoryOutput('{"items":[]}', source, 'Asia/Shanghai'), /V2/);
  const legacySoul = loadSouls().get('pinecone-lab');
  const text = renderSoul({ ...legacySoul, background: '学院里的伙伴。', dailyLife: '固定日常。' });
  assert.ok(text.indexOf('【世界观】') < text.indexOf('【背景】'));
  assert.ok(text.indexOf('【背景】') < text.indexOf('【日常】'));
});

test('actual adapter handles SSE tool fragments and structured non-streaming memory transport', async () => {
  const requests = [];
  const adapter = createProvider({
    apiKey: 'synthetic-test-key', endpoint: 'mock-model', baseUrl: 'http://127.0.0.1:1/v1', ark: false,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (!body.stream) return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: '{"items":[]}' } }],
      });
      const chunks = [
        { choices: [{ index: 0, delta: { content: '接住' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'calculate', arguments: '{"expression":' } }] } }] },
        { choices: [{ index: 0, finish_reason: 'tool_calls', delta: { tool_calls: [{ index: 0, function: { arguments: '"2+2"}' } }] } }] },
      ];
      return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
    },
  });
  const messages = [{ role: 'user', content: '测试' }];
  const deltas = [];
  const streamed = await adapter.chat({ messages, onDelta: delta => deltas.push(delta) });
  assert.deepEqual(deltas, ['接住']);
  assert.equal(streamed.toolCalls[0].function.arguments, '{"expression":"2+2"}');
  assert.equal((await adapter.chat({ messages, responseFormat: { type: 'json_schema' } })).content, '{"items":[]}');
  assert.ok(requests.every(request => request.url.endsWith('/chat/completions') && !('thinking' in request.body)));
});

test('new sessions keep event collections out of default context even with many recent memories', async t => {
  const count = 121;
  const f = await fixture(t, {
    async chat(options) {
      if (options.responseFormat) {
        const { userMessages: messages } = JSON.parse(options.messages[1].content);
        const anchor = messages[0];
        return memoryResponse(Array.from({ length: count }, (_, index) => ({
          anchorMessageId: anchor.id, sourceMessageIds: [anchor.id],
          summary: `第${index}条已归档摘要` + '资料'.repeat(220),
          detail: { notes: '此详情不随默认上下文注入' },
        })));
      }
      return reply(options);
    },
  }, { clock: () => new Date('2026-11-11T10:00:00.000Z') });
  const [benny] = (await f.json('/api/state')).agents;
  const child = await f.child();
  const scope = { childId: child.id, agentId: benny.id };
  const first = await f.newSession(scope);
  await f.chat(scope, first.id, '测试摘要容量。');
  const next = await f.newSession(scope);
  await until(() => f.json('/api/memory' + query(scope)), result => result.items.length === count);
  assert.equal((await f.chat(scope, next.id, '我又来了。')).at(-1).type, 'done');
  const { context } = await f.json('/api/sessions/' + next.id + query(scope));
  assert.equal(context.recentMemories, undefined);
  assert.ok(context.modelRequests[0].inputChars < 45_000);
  const material = JSON.parse(context.requestMessages[1].content.split('\n')[1]);
  assert.equal(material.recentMemories, undefined);
  assert.equal((await f.json('/api/memory' + query(scope))).counts.active, count);
  assert.doesNotMatch(context.requestMessages[1].content, /第0条已归档摘要/);
  assert.doesNotMatch(context.requestMessages[1].content, /此详情不随默认上下文注入/);
});
