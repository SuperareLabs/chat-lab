import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSharedPrompts } from '../lib/shared-prompts.mjs';
import { renderSoul, soulFromAgent } from '../lib/prompts.mjs';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';

const defaults = JSON.parse(readFileSync(new URL('../config/default-agents.json', import.meta.url)));
const croco = '9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65';
const sharedPrompts = loadSharedPrompts();
const world = sharedPrompts[0].content;

test('the shared world applies only to Croco and leaves every role definition unchanged', () => {
  assert.equal(sharedPrompts.length, 1);
  assert.deepEqual(sharedPrompts[0].agentIds, [croco]);
  for (const id of [croco, 'lin-xiaoman', 'lin-wanqing', '4fbfe444-659b-4915-ac3f-1842b6617b54']) {
    const soul = soulFromAgent({ ...defaults.agents.find(agent => agent.id === id), revision: 1 });
    const system = renderSoul(soul, { sharedPrompts });
    if (id === croco) {
      assert(system.includes(world));
      assert(system.indexOf(world) < system.indexOf('【角色设定】'));
      assert(system.endsWith('【角色设定】' + soul.definition));
      assert(!system.includes('## 对话节奏与回答长度'));
    } else assert.equal(system, renderSoul(soul));
  }
});

test('world rollout invalidates stale prompt views once without changing history, memory or framework version', async () => {
  const config = { defaultAgents: defaults.agents, retiredAgentIds: defaults.retiredAgentIds,
    defaultChildren: [{ name: '合成访客', age: 30, interests: [] }], model: { name: 'mock', configured: true, thinking: 'disabled' },
    memoryModel: { configured: false }, provider: { async chat() {
      return { content: '在呢。', toolCalls: [], receipt: { finish_reason: 'stop' } };
    } } };
  const original = createBrowserWorkspace(config);
  const boot = await original.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId: croco };
  const talked = await original.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope,
    body: { ...scope, text: '布爸', requestId: 'shared-rollout-history' } });
  const updated = createBrowserWorkspace({ ...config, sharedPrompts });
  const result = await updated.execute({ method: 'GET', path: '/api/state', snapshot: talked.snapshot, scope });
  assert.equal(result.value.dataVersion, boot.value.dataVersion);
  for (const [table, rows] of Object.entries(talked.snapshot.tables)) {
    if (table !== 'lab_meta') assert.deepEqual(result.snapshot.tables[table], rows, table);
  }
  assert.deepEqual(result.snapshot.tables.lab_meta.filter(row => row.key !== 'shared_prompts_hash'), talked.snapshot.tables.lab_meta);
  assert(result.invalidates.includes('/api/agents'));
  assert(result.views[`/api/agents/${croco}/prompt`].system.includes(world));
  const invalid = structuredClone(result.snapshot);
  invalid.tables.lab_meta.find(row => row.key === 'shared_prompts_hash').value = 'not-a-hash';
  await assert.rejects(updated.execute({ method: 'GET', path: '/api/state', snapshot: invalid, scope }), /格式无效/);
  const again = await updated.execute({ method: 'GET', path: '/api/state', snapshot: result.snapshot, scope });
  assert.deepEqual(again.snapshot, result.snapshot);
  assert.equal(again.invalidates, undefined);
  const removed = await original.execute({ method: 'GET', path: '/api/state', snapshot: again.snapshot, scope });
  assert(removed.invalidates.includes('/api/agents'));
  assert(!removed.views[`/api/agents/${croco}/prompt`].system.includes(world));
});

test('actual initial and tool-continuation requests include the world only for the scoped role', async () => {
  const calls = [];
  const workspace = createBrowserWorkspace({ defaultAgents: defaults.agents, retiredAgentIds: defaults.retiredAgentIds, sharedPrompts,
    defaultChildren: [{ name: '合成访客', age: 30, interests: [] }], model: { name: 'mock', configured: true, thinking: 'disabled' },
    memoryModel: { configured: false }, provider: { async chat(input) {
      calls.push(input);
      return input.messages.some(message => message.role === 'tool')
        ? { content: '4。', toolCalls: [], receipt: { finish_reason: 'stop' } }
        : { content: '', toolCalls: [{ id: 'calc', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }],
          receipt: { finish_reason: 'tool_calls' } };
    } } });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  let snapshot = boot.snapshot;
  for (const id of [croco, 'lin-wanqing']) {
    const scope = { childId: boot.value.children[0].id, agentId: id };
    const start = calls.length;
    const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot, scope,
      body: { ...scope, text: '算一下2+2', requestId: 'shared-tool-' + id } });
    assert.equal(result.status, 200);
    snapshot = result.snapshot;
    const round = calls.slice(start);
    assert.equal(round.length, 2);
    for (const input of round) {
      assert.equal(input.messages[0].content.includes(world), id === croco);
      assert(input.messages[0].content.includes(defaults.agents.find(agent => agent.id === id).definition));
      assert.equal(input.thinking, 'disabled');
      assert.equal(input.reasoningEffort, undefined);
    }
  }
});
