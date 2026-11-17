import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../lib/provider.mjs';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';

const disconnected = () => Object.assign(new TypeError('fetch failed: private-request-text'), {
  cause: new AggregateError([Object.assign(new Error('private-network-details'), { code: 'ECONNRESET' })]),
});

test('network failures retain safe cause and timing without exposing transport text or retrying', async () => {
  let calls = 0;
  const provider = createProvider({ apiKey: 'synthetic-secret', fetchImpl: async () => { calls++; throw disconnected(); } });
  await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'synthetic-input' }] }), error => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.networkCode, 'ECONNRESET');
    assert.equal(error.outcome_unknown, true);
    assert.match(error.message, /模型服务连接失败/);
    assert(!JSON.stringify(error).includes('private-'));
    assert(!JSON.stringify(error).includes('synthetic-secret'));
    assert.equal(typeof error.metrics.total_ms, 'number');
    return true;
  });
  assert.equal(calls, 1);
});

test('a model disconnect saves the user turn, failed attempt and timing with no duplicate dispatch', async () => {
  let calls = 0;
  const provider = createProvider({ apiKey: 'synthetic-secret', fetchImpl: async () => { calls++; throw disconnected(); } });
  const workspace = createBrowserWorkspace({ provider, model: { name: 'mock', configured: true, thinking: 'disabled' },
    memoryModel: { name: 'disabled', configured: false }, defaultAgents: [{ id: 'role', name: '合成角色', definition: '自然聊天。' }],
    defaultChildren: [{ name: '合成访客', age: 30, interests: [] }] });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId: 'role' };
  const events = [];
  const body = { ...scope, text: '这是合成测试', requestId: 'connection-once' };
  const failed = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope, body },
    { emit: event => events.push(event) });
  assert.equal(calls, 1);
  assert.equal(failed.snapshot.tables.messages.filter(row => row.role === 'user').length, 1);
  assert.equal(failed.snapshot.tables.messages.filter(row => row.role === 'assistant').length, 0);
  assert.equal(failed.snapshot.tables.runs[0].status, 'failed');
  assert(events.some(event => event.type === 'workspace'));
  assert(events.some(event => event.type === 'error' && /模型服务连接失败/.test(event.message)));
  const context = JSON.parse(failed.snapshot.tables.sessions[0].context);
  assert.equal(context.modelRequests[0].error.networkCode, 'ECONNRESET');
  assert.equal(typeof context.modelRequests[0].usage.metrics.total_ms, 'number');
  const replay = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: failed.snapshot, scope, body });
  assert.equal(calls, 1, 'the same request id never resends a charged request');
  assert.equal(replay.snapshot.tables.messages.filter(row => row.role === 'user').length, 1);
});
