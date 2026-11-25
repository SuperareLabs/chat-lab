import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolTriggerRequest, createToolDecisionClient } from '../lib/tool-trigger.mjs';

const input = {
  latestUserMessages: ['查公开资料，再拍一张照片。'], previousTurns: [],
  currentMentor: { name: '测试导师', specialty: '自然观察' },
  availableTools: ['search_web', 'find_mentor', 'calculate', 'share_photo', 'share_video', 'recall_memory'],
};
const categoryAnswers = {
  find_mentor: { type: 'choice', choice: 'outside_specialty_research' },
  search_web: { type: 'choice', choice: 'explicit_no_search' },
  calculate: { type: 'choice', choice: 'skip' },
};

test('one Jev request returns independent routing choices and ranks only available media formats', async () => {
  const requests = [];
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      requests.push(body);
      const answers = { ...categoryAnswers, character_media: { type: 'choice', choice: 'call' },
        any_tool: { type: 'noul', noul: 0.97 }, share_photo: { type: 'noul', noul: 0.42 }, share_video: { type: 'noul', noul: 0.1 } };
      return Response.json({ model: 'jev-test', answers, usage: { input_tokens: 50 } });
    },
  });
  const result = await client.decide(buildToolTriggerRequest({ ...input, includeMediaDecision: true }));
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(requests[0].questions).map(([id, q]) => [id, q.type])), {
    find_mentor: 'choice', search_web: 'choice', calculate: 'choice', any_tool: 'noul',
    character_media: 'choice', share_photo: 'noul', share_video: 'noul',
  });
  assert.deepEqual(result.decisions, { find_mentor: { choice: 'call', reason: 'outside_specialty_research' },
    search_web: { choice: 'skip', reason: 'explicit_no_search' }, calculate: { choice: 'skip' }, character_media: { choice: 'call' } });
  assert.deepEqual(result.mediaDecision, { status: 'succeeded', anyToolProbability: 0.97,
    probabilities: [{ name: 'share_photo', probability: 0.42 }, { name: 'share_video', probability: 0.1 }] });
  assert.deepEqual(result.receipt, { model: 'jev-test', usage: { input_tokens: 50 } });
});

test('media questions follow enabled capabilities and legacy callers keep choice-only responses', async () => {
  const requestFor = availableTools => buildToolTriggerRequest({ ...input, availableTools, includeMediaDecision: true });
  assert.deepEqual(Object.keys(requestFor(['share_video']).questions), ['any_tool', 'character_media', 'share_video']);
  assert.deepEqual(Object.keys(requestFor(['recall_memory']).questions), ['any_tool']);
  const legacy = buildToolTriggerRequest(input);
  assert.deepEqual(Object.keys(legacy.questions), ['find_mentor', 'search_web', 'calculate']);
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async () => Response.json({ answers: categoryAnswers }),
  });
  const result = await client.decide(legacy);
  assert.equal(Object.hasOwn(result, 'mediaDecision'), false);
  assert.deepEqual(result.decisions.search_web, { choice: 'skip', reason: 'explicit_no_search' });
});

test('malformed probability cannot enable media or erase a search veto', async () => {
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async () => Response.json({ answers: { ...categoryAnswers, any_tool: { type: 'noul', noul: 1 },
      character_media: { type: 'choice', choice: 'call' }, share_photo: { type: 'noul', noul: 1.3 } } }),
  });
  const result = await client.decide(buildToolTriggerRequest({ ...input, includeMediaDecision: true,
    availableTools: ['find_mentor', 'search_web', 'share_photo'] }));
  assert.deepEqual(result.mediaDecision, { status: 'unavailable', reason: 'response' });
  assert.deepEqual(result.decisions.search_web, { choice: 'skip', reason: 'explicit_no_search' });
});
