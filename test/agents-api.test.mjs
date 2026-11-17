import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabServer } from '../server.mjs';
import { loadSouls, renderSoul } from '../lib/prompts.mjs';

const answer = text => ({ content: text, toolCalls: [], receipt: { finish_reason: 'stop' } });
async function fixture(t, options = {}) {
  const lab = createLabServer({ dbPath: ':memory:', provider: { async chat() { return answer('在。'); } },
    memoryModel: { name: 'disabled', configured: false }, contextBriefEnabled: false, allowDataReset: false, ...options });
  const { port } = await lab.listen(0); let closed = false;
  const close = async () => { if (!closed) { closed = true; await lab.close(); } };
  t.after(close);
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  return { lab, request, close };
}
test('fresh agent API creates, reads and edits exact definitions immediately using one uniform view', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/state')).value.agents, []);
  const definition = '\n你是灯灯。\n\n  内部换行与缩进保持。\n';
  const created = await f.request('/api/agents', 'POST', { name: '灯灯', definition });
  assert.equal(created.status, 201); const a = created.value.agent;
  assert(a.id); assert.equal(a.revision, 1); assert.equal(a.definition, definition);
  assert.deepEqual((await f.request('/api/agents/' + a.id)).value.agent, a);
  assert.deepEqual((await f.request('/api/state')).value.agents, [a]);
  const updated = await f.request('/api/agents/' + a.id, 'PATCH', { name: '灯灯二', definition: '新设定。\n第二行。', revision: 1 });
  assert.equal(updated.status, 200); assert.equal(updated.value.agent.id, a.id); assert.equal(updated.value.agent.revision, 2);
  const prompt = await f.request('/api/agents/' + a.id + '/prompt');
  assert.equal(prompt.value.definition, updated.value.agent.definition);
  assert(prompt.value.system.endsWith('【名称】灯灯二\n【角色设定】新设定。\n第二行。'));
  assert.deepEqual((await f.request('/api/state')).value.agents, [updated.value.agent]);
  const child = f.lab.store.children()[0];
  const run = f.lab.runtime.beginChat({ childId: child.id, agentId: a.id, text: '你好', requestId: crypto.randomUUID() });
  const events = []; await f.lab.runtime.chat(run, e => events.push(e), new AbortController().signal);
  assert(events.some(e => e.type === 'done'));
});
test('agent API rejects blank text, additional metadata, oversize bodies and stale concurrent revisions', async t => {
  const f = await fixture(t);
  for (const body of [{ name: '', definition: 'x' }, { name: 'x', definition: '\n ' }, { name: 'x' },
    { name: 'x', definition: 'x', audience: { minimumAge: 1 } }, { name: 'x', definition: 'x', id: 'chosen' }]) {
    assert.equal((await f.request('/api/agents', 'POST', body)).status, 400);
  }
  assert.equal((await f.request('/api/agents', 'POST', { name: 'x', definition: 'x'.repeat(64000) })).status, 413);
  const { value: { agent } } = await f.request('/api/agents', 'POST', { name: '角色', definition: '设定' });
  const results = await Promise.all(['甲', '乙'].map(definition => f.request('/api/agents/' + agent.id, 'PATCH',
    { name: '角色', definition, revision: 1 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.request('/api/agents/' + agent.id, 'PATCH', { name: '角色', definition: 'x', revision: 2, card: {} })).status, 400);
  assert.equal((await f.request('/api/agents/missing')).status, 404);
});
test('imported adult metadata survives editing and scope IDs remain unchanged', async t => {
  const f = await fixture(t, { souls: loadSouls() });
  const before = f.lab.runtime.agent('lin-xiaoman');
  const metadata = f.lab.store.agentRecord(before.id).metadata;
  const edited = await f.request('/api/agents/' + before.id, 'PATCH',
    { name: '小满新名', definition: '新设定。', revision: before.revision });
  assert.equal(edited.status, 200); assert.equal(edited.value.agent.minimumAge, 18);
  assert.deepEqual(f.lab.store.agentRecord(before.id).metadata, metadata);
  const child = f.lab.store.children()[0];
  assert.equal((await f.request('/api/sessions', 'POST', { childId: child.id, agentId: before.id })).status, 403);
  assert.equal((await f.request('/api/sessions', 'POST', { childId: child.id, agentId: 'missing' })).status, 404);
  assert.equal(f.lab.runtime.agentId('croco-lab'), '9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65');
});
test('an inflight tool turn keeps its accepted system snapshot; the next turn uses the edit', async t => {
  let enter, release; const entered = new Promise(r => { enter = r; }); const gate = new Promise(r => { release = r; });
  let phase = 0, oldSystem; const newDefinition = '修改后的第二版设定。';
  const f = await fixture(t, { provider: { async chat({ messages }) {
    phase++;
    if (phase === 1) { oldSystem = messages[0].content; enter(); await gate;
      return { content: '我算一下。', toolCalls: [{ id: 'calc', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+3"}' } }], receipt: { finish_reason: 'tool_calls' } }; }
    if (phase === 2) assert.equal(messages[0].content, oldSystem);
    else assert(messages[0].content.includes('【角色设定】' + newDefinition));
    return answer('完成了。');
  } } });
  const agent = f.lab.runtime.createAgent({ name: '快照角色', definition: '修改前的第一版设定。' });
  const scope = { childId: f.lab.store.children()[0].id, agentId: agent.id };
  const events = []; const run = f.lab.runtime.beginChat({ ...scope, text: '二加三', requestId: 'inflight' });
  const running = f.lab.runtime.chat(run, e => events.push(e), new AbortController().signal);
  await entered;
  f.lab.runtime.updateAgent(agent.id, { name: agent.name, definition: newDefinition, revision: 1 });
  release(); await running;
  assert(events.some(e => e.type === 'done'));
  const next = f.lab.runtime.beginChat({ ...scope, text: '继续', requestId: 'next' });
  await f.lab.runtime.chat(next, () => {}, new AbortController().signal);
  assert.equal(phase, 3);
});
test('restart does not reload config seeds or reset edited agent, session and memory IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-api-restart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'isolated.sqlite'), souls = loadSouls();
  let f = await fixture(t, { dbPath, souls });
  const benny = f.lab.runtime.agent('croco-lab'), pine = f.lab.runtime.agent('pinecone-lab');
  assert.equal(f.lab.runtime.promptDetail(pine.id).system, renderSoul(souls.get(pine.id)), 'unmodified legacy system stays byte-identical');
  const saved = f.lab.runtime.updateAgent(benny.id, { name: '编辑后的布爸', definition: '\n数据库保存的文字。\n', revision: benny.revision });
  const before = f.lab.runtime.dataVersion;
  await f.close();
  f = await fixture(t, { dbPath, souls: new Map() });
  assert.equal(f.lab.runtime.dataVersion, before);
  assert.deepEqual(f.lab.runtime.agent(saved.id), saved);
  assert.equal(f.lab.runtime.state().agents.length, souls.size);
});
