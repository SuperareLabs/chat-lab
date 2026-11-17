import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabServer } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';

const provider = { async chat() { throw new Error('This check must not call a model'); } };
const seed = { id: 'test-viewpoint', name: '试验视角', definition: '仅用于合成测试。', metadata: {} };

test('password-free browser workspace works only with a loopback listener and keeps origin protection', async t => {
  const options = { provider, storageMode: 'browser', localNoAuth: true, host: '127.0.0.1',
    defaultAgents: [seed], memoryModel: { name: 'disabled', configured: false } };
  assert.throws(() => createLabServer({ ...options, host: '0.0.0.0' }), /免登录模式仅限/);
  assert.throws(() => createLabServer({ ...options, publicOrigins: ['https://public.example'] }), /免登录模式仅限/);
  const lab = createLabServer(options);
  t.after(() => lab.close());
  const { port } = await lab.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const session = await (await fetch(origin + '/api/auth/session')).json();
  assert.deepEqual(session, { authenticated: true, passwordRequired: false, storageMode: 'browser' });
  const request = headers => fetch(origin + '/api/local', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method: 'GET', path: '/api/state' }) });
  const opened = await request();
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).value.agents[0].id, seed.id);
  assert.equal((await request({ Origin: 'https://other.example' })).status, 403);
});

test('low thinking reaches both chat and tool continuation while memory configuration stays separate', async () => {
  const config = readConfig({ ARK_API_KEY: 'test-only', ARK_THINKING: 'enabled', ARK_REASONING_EFFORT: 'low',
    ARK_MEMORY_MODEL: 'independent-memory-model' });
  assert.equal(config.model.name, 'deepseek-v4-1-flash-economy-261017');
  assert.equal(config.model.thinking, 'enabled');
  assert.equal(config.model.reasoningEffort, 'low');
  assert.deepEqual(config.memoryModel, { name: 'independent-memory-model', configured: true, mode: 'provider' });
  assert.throws(() => readConfig({ ARK_THINKING: 'maybe' }), /ARK_THINKING/);
  assert.throws(() => readConfig({ ARK_REASONING_EFFORT: 'typo' }), /ARK_REASONING_EFFORT/);
  const calls = [];
  const workspace = createBrowserWorkspace({ appVersion: 'thinking-test', defaultAgents: [seed],
    defaultChildren: [{ name: '合成访客', age: 22, interests: [] }], model: config.model,
    memoryModel: { name: 'disabled', configured: false }, provider: { async chat(input) {
      calls.push(input);
      return calls.length === 1
        ? { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }], receipt: { finish_reason: 'tool_calls' } }
        : { content: '4。', toolCalls: [], receipt: { finish_reason: 'stop' } };
    } } });
  const initial = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: initial.value.children[0].id, agentId: seed.id };
  const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: initial.snapshot, scope,
    body: { ...scope, text: '算一下2+2', requestId: 'low-tool-roundtrip' } });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.thinking === 'enabled' && call.reasoningEffort === 'low' && call.maxTokens === 8192));
});

test('disabled chat thinking applies to the first request and tool continuation without affecting the memory model', async () => {
  const config = readConfig({ ARK_API_KEY: 'test-only', ARK_THINKING: 'disabled', ARK_REASONING_EFFORT: 'low', ARK_MEMORY_MODEL: 'independent-memory-model' });
  assert.equal(config.model.thinking, 'disabled');
  assert.equal(config.model.reasoningEffort, undefined);
  assert.equal(config.memoryModel.name, 'independent-memory-model');
  const calls = [];
  const workspace = createBrowserWorkspace({ appVersion: 'thinking-off-test', defaultAgents: [seed],
    defaultChildren: [{ name: '合成访客', age: 22, interests: [] }], model: config.model,
    memoryModel: { configured: false, name: 'disabled' }, provider: { async chat(input) {
      calls.push(input);
      return calls.length === 1
        ? { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }], receipt: { finish_reason: 'tool_calls' } }
        : { content: '4。', toolCalls: [], receipt: { finish_reason: 'stop' } };
    } } });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId: seed.id };
  const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot: boot.snapshot, scope,
    body: { ...scope, text: '算一下2+2', requestId: 'thinking-off' } });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.thinking === 'disabled' && call.reasoningEffort === undefined && call.maxTokens === 1400));
});
