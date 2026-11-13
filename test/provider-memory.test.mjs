import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../lib/provider.mjs';

test('memory reasoning is explicit, keeps usage and never exposes provider reasoning text', async () => {
  const requests = [];
  const provider = createProvider({ apiKey: 'test-not-a-real-key', model: 'test-model', endpoint: 'test-model',
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return Response.json({ model: 'test-model', usage: { prompt_tokens: 5, completion_tokens: 7,
        total_tokens: 12, completion_tokens_details: { reasoning_tokens: 4 } },
      choices: [{ message: { content: '{"creates":[]}', reasoning_content: 'private-provider-reasoning' }, finish_reason: 'stop' }] });
    } });
  const options = { messages: [{ role: 'user', content: 'test' }], responseFormat: { type: 'json_object' } };
  await provider.chat(options);
  const response = await provider.chat({ ...options, thinking: 'enabled', reasoningEffort: 'low' });
  assert.equal(requests[0].thinking.type, 'disabled');
  assert.equal(requests[1].thinking.type, 'enabled');
  assert.equal(requests[1].reasoning_effort, 'low');
  assert.equal(requests[0].reasoning_effort, undefined);
  assert.equal(response.receipt.usage.completion_tokens_details.reasoning_tokens, 4);
  assert(!JSON.stringify(response).includes('private-provider-reasoning'));
  await assert.rejects(provider.chat({ ...options, thinking: 'invalid' }), /thinking 参数无效/);
  assert.equal(requests.length, 2, 'invalid options do not dispatch or retry');
});
