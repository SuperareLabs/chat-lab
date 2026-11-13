import { loadSouls } from '../lib/prompts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLabServer } from '../server.mjs';

const at = '2026-11-13T04:00:00.000Z';
const answer = content => ({ content, toolCalls: [], receipt: { finish_reason: 'stop' } });
const searchCall = query => ({ content: '我看看。', receipt: { finish_reason: 'tool_calls' }, toolCalls: [
  { id: crypto.randomUUID(), type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query }) } },
] });
const material = messages => JSON.parse(messages[1].content.slice(messages[1].content.indexOf('\n') + 1));
const result = (topic = '成都') => ({
  results: [{ title: topic + '天气预报', url: 'https://example.com/weather', snippet: topic + '今日多云，东风1—2级。' }],
  metadata: { retrieved_at: at },
});

async function openLab(provider, search, dbPath = ':memory:') {
  const lab = createLabServer({ souls: loadSouls(), dbPath, provider, search, clock: () => new Date(at),
    contextBriefEnabled: false, allowDataReset: false, memoryModel: { name: 'disabled', configured: false } });
  const { port } = await lab.listen(0);
  const state = lab.runtime.state();
  const scope = { childId: state.children[0].id, agentId: state.agents[0].id };
  const chat = async (text, selected = scope) => {
    const response = await fetch('http://127.0.0.1:' + port + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selected, text, requestId: crypto.randomUUID() }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split('\n\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
    assert(events.some(event => event.type === 'done'), JSON.stringify(events));
    return events[0].sessionId;
  };
  return { lab, scope, chat };
}

test('unspoken search evidence survives ordinary turns and restart without replaying tools or billing search again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-search-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let searches = 0, followups = 0;
  const search = { configured: true, async search() { searches++; return result(); } };
  const provider = { async chat({ messages }) {
    if (messages.at(-1).role === 'tool') return answer('今天预报多云。');
    if (messages.at(-1).content === '成都现在天气怎么样') return searchCall('成都天气');
    followups++;
    const saved = material(messages).previousWebSearch;
    assert.equal(saved.query, '成都天气');
    assert.equal(saved.retrieved_at, at);
    assert.equal(saved.untrusted, true);
    assert.match(saved.results[0].snippet, /东风1—2级/);
    assert(!messages.some(message => message.role === 'tool' || message.tool_calls), 'old tools are data, not replayed calls');
    return answer('风不大。');
  } };
  const path = join(directory, 'isolated.sqlite');
  let f = await openLab(provider, search, path);
  t.after(async () => { if (f) await f.lab.close(); });
  const sessionId = await f.chat('成都现在天气怎么样');
  assert(!f.lab.store.messages(sessionId).at(-1).text.includes('东风'), 'wind evidence was not in the visible answer');
  await f.chat('风大吗');
  await f.chat('能再说一下吗');
  await f.lab.close();
  f = await openLab(provider, search, path);
  assert.equal(await f.chat('刚才风大吗'), sessionId);
  assert.equal(searches, 1);
  assert.equal(followups, 3);
  assert.equal(f.lab.store.usage(sessionId).calls.filter(call => call.kind === 'search').length, 1);
});

test('previous search stays scoped to the same user, Soul and session, including legacy context adoption', async t => {
  let expectSaved = false;
  const f = await openLab({ async chat({ messages }) {
    if (messages.at(-1).role === 'tool') return answer('今天预报多云。');
    if (messages.at(-1).content === '天气') return searchCall('成都天气');
    assert.equal(!!material(messages).previousWebSearch, expectSaved);
    return answer('在。');
  } }, { configured: true, async search() { return result(); } });
  t.after(() => f.lab.close());
  const sessionId = await f.chat('天气');
  const original = f.lab.store.session(sessionId, f.scope.childId, f.scope.agentId).context;
  delete original.previousWebSearch;
  f.lab.store.recordContext(sessionId, original);
  expectSaved = true;
  await f.chat('沿用旧版工具记录');
  expectSaved = false;
  const otherUser = f.lab.store.createChild({ name: '独立用户', age: 20, interests: [] }, at);
  await f.chat('在吗', { ...f.scope, childId: otherUser.id });
  const otherSoul = f.lab.runtime.state().agents.find(agent => agent.id !== f.scope.agentId && !agent.minimumAge);
  await f.chat('在吗', { ...f.scope, agentId: otherSoul.id });
  f.lab.store.manuallyOpen(f.scope.childId, f.scope.agentId, at);
  const freshId = await f.chat('在吗');
  assert.notEqual(freshId, sessionId);
});

test('failed search preserves last successful evidence and a new success replaces it', async t => {
  let expectedCity = null, searches = 0;
  const f = await openLab({ async chat({ messages }) {
    if (messages.at(-1).role === 'tool') return answer('这一轮处理完了。');
    const text = messages.at(-1).content;
    if (text.startsWith('搜索')) return searchCall(text.slice(2));
    const saved = material(messages).previousWebSearch;
    assert.equal(saved.query, expectedCity);
    assert.match(saved.results[0].snippet, new RegExp(expectedCity));
    return answer('沿用刚才的资料。');
  } }, { configured: true, async search({ query }) {
    searches++;
    if (query === '失败') throw new Error('simulated failure');
    return result(query);
  } });
  t.after(() => f.lab.close());
  await f.chat('搜索成都');
  expectedCity = '成都';
  await f.chat('搜索失败');
  await f.chat('继续聊');
  await f.chat('搜索北京');
  expectedCity = '北京';
  await f.chat('再继续');
  assert.equal(searches, 3, 'follow-ups never execute old searches');
});
