import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../lib/config.mjs';

// Capture the real provider request before dispatch, then abort. No network calls.
async function requestBody(provider) {
  const controller = new AbortController();
  let body;
  await assert.rejects(provider.chat({
    messages: [{ role: 'user', content: 'test' }],
    signal: controller.signal,
    onRequest(value) {
      body = value;
      controller.abort();
    },
  }), error => error.code === 'ABORTED' && error.outcome_unknown === false);
  return body;
}

test('memory defaults to the same chat provider instance and model', async () => {
  const config = readConfig({ ARK_API_KEY: 'test-key', ARK_MODEL: 'chat-model', ARK_ENDPOINT: 'ep-chat' });
  assert.equal(config.memoryProvider, config.provider);
  assert.deepEqual(config.memoryModel, { name: 'chat-model', configured: true, mode: 'provider' });
  assert.equal((await requestBody(config.memoryProvider)).model, 'ep-chat');
  assert.equal(config.model.name, 'chat-model');
});

test('independent context-brief model work is disabled by default and requires an explicit legacy opt-in', () => {
  assert.equal(readConfig({}).contextBriefEnabled, false);
  assert.equal(readConfig({ CHAT_CONTEXT_BRIEF: '0' }).contextBriefEnabled, false);
  assert.equal(readConfig({ CHAT_CONTEXT_BRIEF: 'true' }).contextBriefEnabled, false);
  assert.equal(readConfig({ CHAT_CONTEXT_BRIEF: '1' }).contextBriefEnabled, true);
});

test('an explicit memory model uses its own endpoint instead of the chat endpoint', async () => {
  const config = readConfig({
    ARK_API_KEY: 'test-key',
    ARK_MODEL: 'chat-model',
    ARK_ENDPOINT: 'ep-chat',
    ARK_MEMORY_MODEL: ' memory-model ',
  });
  assert.notEqual(config.memoryProvider, config.provider);
  assert.deepEqual(config.memoryModel, { name: 'memory-model', configured: true, mode: 'provider' });
  assert.equal((await requestBody(config.memoryProvider)).model, 'memory-model');
  assert.equal((await requestBody(config.provider)).model, 'ep-chat');
});

test('an explicit memory endpoint overrides only the memory request target', async () => {
  const config = readConfig({
    ARK_API_KEY: 'test-key', ARK_MODEL: 'chat-model', ARK_ENDPOINT: 'ep-chat',
    ARK_MEMORY_MODEL: 'memory-model', ARK_MEMORY_ENDPOINT: ' ep-memory ',
  });
  assert.equal((await requestBody(config.memoryProvider)).model, 'ep-memory');
  assert.equal(config.memoryModel.name, 'memory-model');
  assert.equal(config.model.name, 'chat-model');
  const endpointOnly = readConfig({
    ARK_API_KEY: 'test-key', ARK_MODEL: 'chat-model', ARK_ENDPOINT: 'ep-chat', ARK_MEMORY_ENDPOINT: 'ep-memory',
  });
  assert.notEqual(endpointOnly.memoryProvider, endpointOnly.provider);
  assert.equal(endpointOnly.memoryModel.name, 'chat-model');
  assert.equal((await requestBody(endpointOnly.memoryProvider)).model, 'ep-memory');
});

test('empty memory settings preserve defaults and unconfigured status', async () => {
  const config = readConfig({ ARK_MODEL: 'chat-model', ARK_MEMORY_MODEL: ' ', ARK_MEMORY_ENDPOINT: '\t' });
  assert.equal(config.memoryProvider, config.provider);
  assert.deepEqual(config.memoryModel, { name: 'chat-model', configured: false, mode: 'unconfigured' });
  await assert.rejects(config.memoryProvider.chat({ messages: [{ role: 'user', content: 'test' }] }), { code: 'NOT_CONFIGURED' });
  const independent = readConfig({ ARK_MEMORY_MODEL: 'memory-model' });
  assert.notEqual(independent.memoryProvider, independent.provider);
  assert.deepEqual(independent.memoryModel, { name: 'memory-model', configured: false, mode: 'unconfigured' });
});

test('independent memory providers retain the configured provider API mode', async () => {
  const config = readConfig({
    ARK_API_KEY: 'test-key', ARK_BASE_URL: 'http://127.0.0.1:9876/v1', ARK_MEMORY_MODEL: 'local-memory',
  });
  assert.equal((await requestBody(config.memoryProvider)).model, 'local-memory');
  assert.equal('thinking' in (await requestBody(config.memoryProvider)), false);
});
