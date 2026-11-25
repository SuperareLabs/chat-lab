import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolTriggerRequest, createToolDecisionClient } from '../lib/tool-trigger.mjs';

const input = {
  latestUserMessages: ['查查我之前跟你说过的观察计划，再查公开资料，拍一张照片。'], previousTurns: [],
  currentMentor: { name: '测试导师', specialty: '自然观察' },
  availableTools: ['search_web', 'find_mentor', 'calculate', 'share_photo', 'share_video', 'recall_memory'],
};
const categoryAnswers = {
  find_mentor: { type: 'choice', choice: 'outside_specialty_research' },
  search_web: { type: 'choice', choice: 'explicit_no_search' },
  calculate: { type: 'choice', choice: 'skip' },
};

test('one Jev request shares tool rules for the total score and returns choices for dispatch', async () => {
  const requests = [];
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      requests.push(body);
      const answers = { ...categoryAnswers, recall_memory: { type: 'choice', choice: 'call', probabilities: { call: 0.86 } },
        character_media: { type: 'choice', choice: 'call' },
        any_tool: { type: 'noul', noul: 0.97 }, share_photo: { type: 'noul', noul: 0.42 }, share_video: { type: 'noul', noul: 0.1 } };
      return Response.json({ model: 'jev-test', answers, usage: { input_tokens: 50 } });
    },
  });
  const result = await client.decide(buildToolTriggerRequest({ ...input, includeToolDecision: true }));
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(requests[0].questions).map(([id, q]) => [id, q.type])), {
    find_mentor: 'choice', search_web: 'choice', calculate: 'choice',
    recall_memory: 'choice', character_media: 'choice', any_tool: 'noul', share_photo: 'noul', share_video: 'noul',
  });
  const questions = requests[0].questions;
  for (const name of ['find_mentor', 'search_web', 'calculate', 'recall_memory', 'character_media']) {
    assert.ok(questions.any_tool.instructions.includes(questions[name].instructions));
    for (const text of Object.values(questions[name].criteria)) assert.ok(questions.any_tool.instructions.includes(text));
  }
  for (const name of ['share_photo', 'share_video']) assert.ok(questions.any_tool.instructions.includes(questions[name].instructions));
  assert.deepEqual(result.decisions, { find_mentor: { choice: 'call', reason: 'outside_specialty_research' },
    search_web: { choice: 'skip', reason: 'explicit_no_search' }, calculate: { choice: 'skip' },
    recall_memory: { choice: 'call', probability: 0.86, callProbability: 0.86 }, character_media: { choice: 'call' } });
  assert.deepEqual(result.toolDecision, { status: 'succeeded', anyToolProbability: 0.97,
    probabilities: [{ name: 'share_photo', probability: 0.42 }, { name: 'share_video', probability: 0.1 }] });
  assert.deepEqual(result.receipt, { model: 'jev-test', usage: { input_tokens: 50 } });
});

test('media and memory questions follow enabled capabilities and legacy callers keep choice-only responses', async () => {
  const requestFor = availableTools => buildToolTriggerRequest({ ...input, availableTools, includeToolDecision: true });
  assert.deepEqual(Object.keys(requestFor(['share_video']).questions), ['character_media', 'any_tool', 'share_video']);
  const memoryOnly = requestFor(['recall_memory']).questions;
  assert.deepEqual(Object.keys(memoryOnly), ['recall_memory', 'any_tool']);
  assert.deepEqual(Object.keys(memoryOnly.recall_memory.criteria), ['call', 'skip', 'uncertain']);
  assert.deepEqual(Object.keys(requestFor(['get_memory_detail']).questions), ['any_tool']);
  const referenceOnly = requestFor(['read_character_reference']).questions;
  assert.deepEqual(Object.keys(referenceOnly), ['read_character_reference', 'any_tool']);
  assert.ok(referenceOnly.any_tool.instructions.includes(referenceOnly.read_character_reference.criteria.call));
  assert.ok(!memoryOnly.any_tool.instructions.includes('发一段你做热身'));
  const legacy = buildToolTriggerRequest(input);
  assert.deepEqual(Object.keys(legacy.questions), ['find_mentor', 'search_web', 'calculate']);
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async () => Response.json({ answers: categoryAnswers }),
  });
  const result = await client.decide(legacy);
  assert.equal(Object.hasOwn(result, 'toolDecision'), false);
  assert.deepEqual(result.decisions.search_web, { choice: 'skip', reason: 'explicit_no_search' });
});

test('malformed media fit cannot invalidate the total score or erase a search veto', async () => {
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async () => Response.json({ answers: { ...categoryAnswers, any_tool: { type: 'noul', noul: 1 },
      character_media: { type: 'choice', choice: 'call' }, share_photo: { type: 'noul', noul: 1.3 } } }),
  });
  const result = await client.decide(buildToolTriggerRequest({ ...input, includeToolDecision: true,
    availableTools: ['find_mentor', 'search_web', 'share_photo'] }));
  assert.deepEqual(result.toolDecision, { status: 'succeeded', anyToolProbability: 1, probabilities: [] });
  assert.deepEqual(result.decisions.search_web, { choice: 'skip', reason: 'explicit_no_search' });
});

test('one malformed choice in a unified turn preserves the total, valid routes and explicit search veto', async () => {
  const answers = { ...categoryAnswers, any_tool: { type: 'noul', noul: 0.91 },
    calculate: { type: 'choice', choice: 'call' }, recall_memory: { type: 'choice', choice: 'unknown' },
    share_photo: { type: 'noul', noul: 1 }, share_video: { type: 'noul', noul: 0 } };
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async () => Response.json({ answers, usage: { input_tokens: 13 } }),
  });
  const request = buildToolTriggerRequest({ ...input, includeToolDecision: true });
  const result = await client.decide(request);
  assert.deepEqual(result.decisions, { find_mentor: { choice: 'call', reason: 'outside_specialty_research' },
    search_web: { choice: 'skip', reason: 'explicit_no_search' }, calculate: { choice: 'call' } });
  assert.equal(result.toolDecision.anyToolProbability, 0.91);
  assert.equal(result.receipt.usage.input_tokens, 13);

  // Without a reliable search choice, a mentor's request for research cannot clear a possible veto.
  answers.search_web = { type: 'choice', choice: ['call'] };
  const damagedSearch = await client.decide(request);
  assert.equal(damagedSearch.decisions.search_web, undefined);
  assert.equal(damagedSearch.decisions.calculate.choice, 'call');
  assert.equal(damagedSearch.toolDecision.status, 'succeeded');
  delete answers.any_tool;
  const noTotal = await client.decide(request);
  assert.deepEqual(noTotal.toolDecision, { status: 'unavailable', reason: 'response' });
  assert.equal(noTotal.decisions.calculate.choice, 'call');
  await assert.rejects(client.decide(buildToolTriggerRequest(input)), /缺少有效的工具选择/);
});

test('a missing or invalid total cannot be supplied by a high format score', async () => {
  for (const score of [undefined, 1.3]) {
    const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
      fetchImpl: async () => Response.json({ answers: { character_media: { type: 'choice', choice: 'call' },
        any_tool: { type: 'noul', noul: score }, share_photo: { type: 'noul', noul: 1 } } }),
    });
    const result = await client.decide(buildToolTriggerRequest({ ...input, includeToolDecision: true, availableTools: ['share_photo'] }));
    assert.deepEqual(result.toolDecision, { status: 'unavailable', reason: 'response' });
    assert.equal(result.decisions.character_media.choice, 'call');
  }
});

test('tool call scores aggregate all calling outcomes and keep the search score after a research override', async () => {
  const client = createToolDecisionClient({ model: 'jev-test', url: 'https://example.test/decisions' }, 'test', {
    fetchImpl: async () => Response.json({ answers: {
      find_mentor: { type: 'choice', choice: 'outside_specialty_research', probabilities: {
        mentor_intent: 0.15, outside_specialty_research: 0.5, outside_specialty: 0.1, question_or_help: 0.03 } },
      search_web: { type: 'choice', choice: 'skip', probabilities: { skip: 0.8, call: 0.12 } },
      calculate: { type: 'choice', choice: 'skip', probabilities: { skip: 0.91, call: 0.04 } },
    } }),
  });
  const { decisions } = await client.decide(buildToolTriggerRequest(input));
  assert.deepEqual(decisions.find_mentor, { choice: 'call', reason: 'outside_specialty_research', probability: 0.5, callProbability: 0.78 });
  assert.deepEqual(decisions.search_web, { choice: 'call', reason: 'outside_specialty_research', callProbability: 0.12 });
  assert.deepEqual(decisions.calculate, { choice: 'skip', probability: 0.91, callProbability: 0.04 });
});
