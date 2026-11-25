import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { demoAgents, demoChildren } from '../config/mentor-demo.mjs';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';
import { MENTOR_DECISION_PROMPT } from '../lib/mentor-recommendation.mjs';
import { loadSharedPrompts } from '../lib/shared-prompts.mjs';
import { buildToolTriggerRequest, createToolDecisionClient } from '../lib/tool-trigger.mjs';

const currentMentor = demoAgents[0];
const xiaolin = demoAgents.find(agent => agent.id === 'demo-xiaolin');
const mofei = demoAgents.find(agent => agent.id === 'demo-mofei');
const shangang = demoAgents.find(agent => agent.id === 'demo-shangang');
const duoluo = demoAgents.find(agent => agent.name === '鹦鹉多罗');
const lili = demoAgents.find(agent => agent.name === '松鼠利利');
const pisili = demoAgents.find(agent => agent.name === '狐狸皮斯理');
const project = '我做蚂蚁观察报告，分不清是不是同一条觅食路线。';
const projectAnswer = '每隔一分钟记一次蚂蚁经过的位置。';
const naturalAnswer = '蜜蜂把花蜜带回蜂巢，做成能储存的食物。';

const response = (content, toolCalls = [], finishReason = 'stop') => ({
  content, toolCalls, receipt: { finish_reason: finishReason },
});
const decision = (status, { mentorIds = [], evidence = '', basis = 'other', reason = '根据当前需求判断', replyHint = '',
  categoryId, declinedCardId, cardCopy, handoffBrief } = {}) =>
  ({ status, mentorIds, evidence, basis, reason, replyHint,
    ...(categoryId ? { categoryId } : {}),
    ...(declinedCardId ? { declinedCardId } : {}),
    ...(cardCopy ? { cardCopy } : {}),
    ...(handoffBrief ? { handoffBrief } : {}),
  });
const invitation = () => decision('invite', {
  mentorIds: [xiaolin.id], evidence: '分不清是不是同一条觅食路线', replyHint: '区分不同路线，做一份对照记录。',
});
const accepted = (id = xiaolin.id) => decision('offer', { mentorIds: [id], evidence: '好呀', basis: 'accepted_invitation' });
const offers = turn => turn.events.filter(event => event.type === 'mentor_recommendation');
const parts = turn => turn.events.filter(event => event.type === 'reply_part').map(event => event.text);
const proactive = (mentor, evidence, categoryId, options = {}) => decision('offer', {
  mentorIds: [mentor.id], evidence, basis: 'proactive_specialty', categoryId, ...options,
});
const recorded = turn => {
  assert.equal(Object.hasOwn(turn.run, 'mentor_recommendation'), true);
  return JSON.parse(turn.run.mentor_recommendation);
};
const historyFor = turn => turn.classifications[0].input.recommendationHistory;
const historyEntry = (turn, turnsSince, state) => {
  const { card, ...record } = recorded(turn);
  return { id: turn.run.id, turnsSince, ...record,
    ...(card ? { state: state ?? card.state, goal: card.brief.goal } : {}) };
};
const triggerUsageFor = turn => turn.snapshot.tables.usage_records
  .filter(row => row.run_id === turn.run.id && row.kind === 'mentor_trigger')
  .map(row => JSON.parse(row.entry));

async function demo({ agents = demoAgents, search, clock, failWelcome = false, characterMedia, toolDecision, mediaPlan, memoryProvider } = {}) {
  let turn;
  const welcomeRequests = [];
  const briefRequests = [];
  const workspace = createBrowserWorkspace({
    defaultAgents: agents, defaultChildren: demoChildren, sharedPrompts: loadSharedPrompts(),
    model: { name: 'test', configured: true }, memoryModel: { name: 'test', configured: Boolean(memoryProvider) },
    memoryProvider, search, clock, characterMedia, toolDecision,
    mentorTrigger: { model: 'test-trigger', async decide(input, { signal }) {
      assert.equal(signal.aborted, false);
      turn.triggerRequests.push(input);
      if (turn.trigger instanceof Error) throw turn.trigger;
      const choice = typeof turn.trigger === 'function' ? turn.trigger(input) : turn.trigger;
      const decisions = { find_mentor: { choice, reason: turn.triggerReason } };
      if (input.questions.search_web) decisions.search_web = { choice: turn.searchChoice, reason: turn.searchReason };
      if (input.questions.calculate) decisions.calculate = { choice: turn.calculateChoice };
      if (input.questions.recall_memory) decisions.recall_memory = { choice: turn.recallChoice };
      if (input.questions.character_media) decisions.character_media = { choice: turn.mediaChoice };
      return { decisions, ...(turn.mediaDecision ? { mediaDecision: turn.mediaDecision } : {}),
        receipt: { model: 'test-trigger', usage: { input_tokens: 100, output_tokens: 0 } } };
    } },
    provider: { async chat({ messages, tools, toolChoice }) {
      if (mediaPlan && /【Share (?:Photo|Video)】/u.test(messages[0].content)) return response(JSON.stringify(await mediaPlan(messages)));
      if (messages[0].content.includes('【主动欢迎】')) {
        welcomeRequests.push({ messages, tools });
        if (failWelcome) throw new Error('synthetic welcome failure');
        return response(JSON.stringify({ greeting: '嗨，你来啦！', connection: '布爸说你想练英文点餐，我可以陪你练。' }));
      }
      if (messages[0].content.startsWith('给目标角色整理这次转介的进度。')) {
        briefRequests.push({ messages, tools });
        return response(JSON.stringify({ progress: '孩子已经能说出一整句英文点餐。' }));
      }
      if (messages[0].content.startsWith('【导师工具内部判定】')) {
        const input = JSON.parse(messages.at(-1).content);
        turn.classifications.push({ system: messages[0].content, input, tools });
        if (turn.decision instanceof Error) throw turn.decision;
        const result = typeof turn.decision === 'function' ? await turn.decision(input) : turn.decision;
        return response(typeof result === 'string' ? result : JSON.stringify(result));
      }
      if (messages[0].content.startsWith('【导师推荐记录判断】')) {
        const input = JSON.parse(messages.at(-1).content);
        turn.historyReviews.push({ input, tools });
        if (turn.historyReview instanceof Error) throw turn.historyReview;
        const result = typeof turn.historyReview === 'function' ? turn.historyReview(input) : turn.historyReview;
        return response(typeof result === 'string' ? result : JSON.stringify(result));
      }
      const last = messages.at(-1);
      turn.outerRequests.push({ system: messages[0].content, tools: structuredClone(tools), toolChoice,
        background: messages[1], previous: messages.at(-2), last });
      if (last.role === 'tool') {
        turn.receipts = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        turn.offersBeforeContinuation ??= offers(turn).length;
      }
      const nativeTool = typeof turn.nativeTool === 'function' ? await turn.nativeTool(toolChoice, messages, tools) : turn.nativeTool;
      if (nativeTool && !messages.some(message => message.role === 'tool' && message.tool_call_id === nativeTool.id)) {
        return response('', [nativeTool], 'tool_calls');
      }
      const reply = typeof turn.reply === 'function' ? turn.reply(messages) : turn.reply;
      const replyParts = Array.isArray(reply) ? reply : [reply];
      return response(JSON.stringify({ messages: replyParts }), [], turn.failContinuation ? 'length' : 'stop');
    } },
  });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const defaultChildId = boot.value.children[0].id;
  let snapshot = boot.snapshot;
  const sessions = new Map();

  return {
    welcomeRequests, briefRequests,
    editSnapshot(edit) { snapshot = structuredClone(snapshot); edit(snapshot); },
    async request(method, path, agentId, payload) {
      const scope = { childId: defaultChildId, agentId };
      const result = await workspace.execute({
        method, path: method === 'GET' ? path + '?' + new URLSearchParams(scope) : path, scope, snapshot,
        ...(method === 'POST' ? { body: { ...scope, ...payload } } : {}),
      });
      snapshot = result.snapshot;
      return result;
    },
    async send(text, options = {}) {
      const { childId = defaultChildId, agentId = currentMentor.id, reply = naturalAnswer, nativeTool, failContinuation = false,
        trigger = 'call', triggerReason = 'mentor_intent', searchChoice = 'skip', searchReason,
        calculateChoice = 'skip', requestId = crypto.randomUUID(), sessionId = sessions.get(`${childId}:${agentId}`) } = options;
      const scope = { childId, agentId };
      turn = { reply, nativeTool, failContinuation, trigger, triggerReason, searchChoice, searchReason, calculateChoice,
        mediaChoice: options.mediaChoice, mediaDecision: options.mediaDecision, recallChoice: options.recallChoice ?? 'skip',
        decision: options.decision ?? decision('stay'),
        historyReview: options.historyReview ?? { decision: 'proceed', reason: '可以继续推荐。' },
        events: [], triggerRequests: [], outerRequests: [], classifications: [], historyReviews: [], receipts: [] };
      const result = await workspace.execute({
        method: 'POST', path: '/api/chat', scope, snapshot,
        body: { ...scope, text, sessionId, requestId },
      }, { emit(event) { turn.events.push(event); options.onEvent?.(event); } });
      const start = turn.events.find(event => event.type === 'start');
      assert.ok(start, result.value?.error);
      const terminal = turn.events.find(event => event.type === 'done' || event.type === 'error');
      assert.equal(terminal?.type, failContinuation ? 'error' : 'done', terminal?.message);
      snapshot = result.snapshot;
      sessions.set(`${childId}:${agentId}`, start.sessionId);
      const saved = result.views[`/api/sessions/${start.sessionId}?${new URLSearchParams(scope)}`];
      const run = snapshot.tables.runs.find(row => row.request_id === requestId);
      assert.ok(run);
      return { ...turn, sessionId: start.sessionId, context: saved.context, messages: saved.messages, snapshot, run };
    },
    async newSession(agentId = currentMentor.id) {
      const scope = { childId: defaultChildId, agentId };
      const result = await workspace.execute({ method: 'POST', path: '/api/sessions', scope, snapshot, body: scope });
      assert.equal(result.status, 201, result.value?.error);
      snapshot = result.snapshot;
      sessions.set(`${defaultChildId}:${agentId}`, result.value.session.id);
      return result.value.session.id;
    },
  };
}

test('replaying a turn does not repeat the mentor check or mark the main reply as a tool acknowledgement', async () => {
  const app = await demo();
  const requestId = crypto.randomUUID();
  const text = '蜜蜂为什么要采蜜？';
  const original = await app.send(text, { requestId });
  const replay = await app.send(text, { requestId });
  assert.equal(replay.run.id, original.run.id);
  assert.equal(original.triggerRequests.length, 1);
  assert.deepEqual(replay.triggerRequests, []);
  assert.deepEqual(replay.classifications, []);
  assert.deepEqual(replay.outerRequests, []);
  assert.deepEqual(replay.events.filter(event => event.type === 'reply_part'),
    original.events.filter(event => event.type === 'reply_part'));
});

for (const kind of ['photo', 'video']) {
  const succeeds = kind === 'photo';
  const scenario = succeeds ? 'one routing request searches before preparing a calculation, a mentor card and a photo'
    : 'a failed video still lets the final reply use the search and calculation';
  test(scenario, async () => {
    const listing = { title: 'Museum café menu', url: 'https://example.com/menu', snippet: 'The cobalt dessert costs 37 credits.' };
    const attachment = { kind, id: 'a'.repeat(48) };
    const generated = [], earlyOutput = [];
    let searched = 0, separateDecisions = 0, finalReplies = 0;
    const app = await demo({
      toolDecision: { async evaluate() { separateDecisions++; throw new Error('unexpected separate routing request'); } },
      search: { configured: true, async search() { searched++; return { results: [listing] }; } },
      mediaPlan(messages) {
        assert.equal(searched, 1);
        assert.ok(JSON.stringify(messages).includes(listing.snippet), 'the media plan must receive the retrieved fact');
        const subject = { asset_id: null, action_or_state: 'a cobalt dessert displayed on the counter' };
        return succeeds ? { type: 'json_object', should_send_image: true, template_id: 'SHOT_POV_SUBJECT',
          environment_context: 'daylight at the museum café', primary_subject: subject }
          : { type: 'json_object', should_send_video: true, template_id: 'VID_POV_INTERACT',
            environment_and_sound: 'sunlit counter with quiet chatter', primary_subject: subject, spoken_line: null };
      },
      characterMedia: { available: () => true, async generate(selected) {
        generated.push(selected);
        return succeeds ? { ok: true, attachment } : { ok: false, error: 'synthetic media failure' };
      } },
    });
    const text = '我想练英文点餐。查下博物馆咖啡厅今日甜品，算三份多少钱，再给我看看你那里的样子。';
    const requestId = crypto.randomUUID();
    const reply = '菜单上每份 37，三份一共 111。';
    const turn = await app.send(text, {
      requestId, triggerReason: 'outside_specialty_research', searchChoice: 'call', calculateChoice: 'call', mediaChoice: 'call',
      mediaDecision: { status: 'succeeded', anyToolProbability: 0.95, probabilities: [
        { name: 'share_photo', probability: succeeds ? 0.9 : 0.5 }, { name: 'share_video', probability: succeeds ? 0.7 : 0.6 },
      ] },
      decision: proactive(duoluo, '我想练英文点餐', 'english-speaking'),
      nativeTool(choice, messages) {
        const name = choice?.function.name;
        if (name === 'search_web') return { id: 'lookup', type: 'function', function: { name, arguments: '{"query":"museum café menu"}' } };
        if (name === 'calculate') {
          const price = /costs (\d+) credits/u.exec(JSON.stringify(messages))?.[1];
          assert.equal(price, '37', 'construct the expression from the latest search');
          return { id: 'total', type: 'function', function: { name, arguments: JSON.stringify({ expression: price + '*3' }) } };
        }
      },
      reply(messages) {
        const input = JSON.stringify(messages);
        assert.ok(input.includes(listing.snippet));
        assert.ok(input.includes('111'));
        const delivery = messages[1].content.split('【本轮角色影像结果】\n')[1];
        assert.ok(delivery, 'the final reply must see the media outcome');
        const { media, sent } = JSON.parse(delivery.split('\n')[0]);
        assert.deepEqual({ media, sent }, { media: kind, sent: succeeds });
        finalReplies++;
        return reply;
      },
      onEvent(event) {
        if (!finalReplies && ['delta', 'reply_part', 'character_media', 'mentor_recommendation'].includes(event.type)) earlyOutput.push(event.type);
      },
    });
    assert.equal(turn.triggerRequests.length, 1);
    assert.ok(turn.triggerRequests[0].questions.character_media);
    assert.equal(separateDecisions, 0);
    assert.deepEqual(generated, [kind]);
    assert.deepEqual(earlyOutput, []);
    assert.equal(finalReplies, 1);
    assert.deepEqual(parts(turn), [reply]);
    assert.deepEqual(turn.outerRequests[0].tools.map(tool => tool.function.name), ['search_web']);
    assert.deepEqual(turn.classifications[0].input.currentSearchEvidence, [{ title: listing.title, snippet: listing.snippet }]);
    const calls = turn.context.toolCalls.map(call => call.name);
    assert.equal(calls[0], 'search_web');
    assert.deepEqual(calls.slice(1).sort(), ['calculate', 'find_mentor', 'share_' + kind]);
    const received = turn.events.filter(event => event.type === 'character_media');
    assert.deepEqual(received, succeeds ? [{ type: 'character_media', attachment }] : []);
    const card = offers(turn)[0]?.card;
    assert.equal(card?.mentor.id, duoluo.id);
    assert.equal(card.messageId, turn.messages.at(-1).id);
    if (succeeds) {
      const replay = await app.send(text, { requestId });
      assert.equal(searched, 1);
      assert.deepEqual(generated, ['photo']);
      assert.deepEqual(replay.triggerRequests, []);
      assert.deepEqual(replay.outerRequests, []);
      assert.deepEqual(replay.events.filter(event => event.type === 'character_media'), received);
      assert.deepEqual(replay.snapshot.tables.runs, turn.snapshot.tables.runs);
      const reopened = await app.request('GET', '/api/sessions/' + turn.sessionId, currentMentor.id);
      assert.deepEqual(reopened.value.mentorCards, [card]);
      assert.deepEqual(reopened.value.messages.at(-1).attachment, attachment);
    }
  });
}

test('after search, mentor, media, calculation and memory can all enter before any of them returns', async t => {
  for (const mediaFails of [false, true]) await t.test(mediaFails ? 'media planning fails' : 'all branches succeed', async () => {
    const listing = { title: '班级节目单', url: 'https://example.com/show', snippet: '当天曲目是《春日序曲》，门票 37 元。' };
    const detail = '用拨片交替拨弦';
    const attachment = { kind: 'photo', id: 'e'.repeat(48) };
    const arrivals = new Set(), earlyOutput = [], memorySteps = [];
    const ready = Promise.withResolvers(), release = Promise.withResolvers();
    let searched = 0, finalReplies = 0;

    async function enter(branch, evidence) {
      assert.equal(searched, 1);
      assert.ok(JSON.stringify(evidence).includes(listing.snippet), branch + ' did not receive the search result');
      arrivals.add(branch);
      if (arrivals.size === 4) ready.resolve();
      await release.promise;
    }
    const app = await demo({
      toolDecision: {},
      search: { configured: true, async search() { searched++; return { results: [listing] }; } },
      memoryProvider: { async chat({ messages }) {
        const { userMessages } = JSON.parse(messages[1].content);
        return response(JSON.stringify({ creates: [{ sourceMessageIds: [userMessages[0].id], kind: 'event', topics: ['吉他'],
          summary: '周末练习吉他。', detail: { notes: detail } }], updates: [], mentions: [], retractions: [], overview: null }));
      } },
      async mediaPlan(messages) {
        await enter('media', messages);
        if (mediaFails) throw new Error('synthetic media plan failure');
        return { should_send_image: true, template_id: 'SHOT_POV_SUBJECT', environment_context: 'a sunlit rehearsal room',
          primary_subject: { asset_id: null, action_or_state: 'a concert program on a chair' } };
      },
      characterMedia: { available: kind => kind === 'photo', async generate() { return { ok: true, attachment }; } },
    });
    const off = { status: 'succeeded', anyToolProbability: 0, probabilities: [] };
    await app.send('我周末练吉他。', { trigger: 'skip', mediaChoice: 'skip', mediaDecision: off, reply: '记住啦。' });
    await app.newSession();
    const memory = (await app.request('GET', '/api/memory', currentMentor.id)).value.items.find(item => item.summary === '周末练习吉他。');
    assert.ok(memory, 'the original chat must create the memory we will recall');
    const text = '我想练英文点餐。查今天的曲目和票价，算三张多少钱，找位老师，看看活动照片，再帮我回忆吉他具体练什么。';
    const answer = '今天演《春日序曲》，三张票共 111 元。你上次练的是用拨片交替拨弦。';
    const pending = app.send(text, {
      searchChoice: 'call', calculateChoice: 'call', recallChoice: 'call', mediaChoice: 'call', mediaDecision: { status: 'succeeded', anyToolProbability: 0.95,
        probabilities: [{ name: 'share_photo', probability: 0.9 }] },
      async decision(input) {
        await enter('mentor', input.currentSearchEvidence);
        return proactive(duoluo, '我想练英文点餐', 'english-speaking');
      },
      async nativeTool(choice, messages, tools) {
        if (choice?.function.name === 'search_web') return { id: 'search-show', type: 'function',
          function: { name: 'search_web', arguments: '{"query":"班级节目单 曲目"}' } };
        if (choice?.function.name === 'calculate') {
          await enter('calculate', messages);
          return { id: 'ticket-total', type: 'function', function: { name: 'calculate', arguments: '{"expression":"37*3"}' } };
        }
        if (choice?.function.name === 'recall_memory') {
          await enter('memory', messages);
          memorySteps.push('recall');
          return { id: 'recall-guitar', type: 'function', function: { name: 'recall_memory', arguments: '{"query":"吉他"}' } };
        }
        if (tools.length !== 1 || tools[0].function.name !== 'get_memory_detail') return;
        assert.deepEqual(memorySteps, ['recall']);
        const afterRecall = messages.map(message => message.content ?? '').join('\n');
        assert.ok(afterRecall.includes(memory.memoryId), 'the detail request must contain the ID of the recalled summary');
        assert.ok(!afterRecall.includes(detail), 'the details must come from the detail tool');
        memorySteps.push('detail');
        return { id: 'guitar-detail', type: 'function', function: { name: 'get_memory_detail',
          arguments: JSON.stringify({ memoryId: memory.memoryId }) } };
      },
      reply(messages) {
        const outstanding = new Set();
        for (const message of messages) {
          if (message.role === 'tool') assert.ok(outstanding.delete(message.tool_call_id), 'unexpected or duplicate tool receipt');
          else {
            assert.equal(outstanding.size, 0, 'each assistant tool batch needs all its receipts before the next message');
            for (const call of message.tool_calls ?? []) outstanding.add(call.id);
          }
        }
        assert.equal(outstanding.size, 0);
        const facts = JSON.stringify(messages);
        assert.ok(facts.includes(detail));
        assert.ok(facts.includes('111'));
        assert.ok(facts.includes(listing.snippet));
        assert.ok(messages.some(message => message.content?.includes('"sent":' + !mediaFails)));
        assert.ok(facts.includes(duoluo.id));
        finalReplies++;
        return answer;
      },
      onEvent(event) {
        if (!finalReplies && ['delta', 'reply_part', 'character_media', 'mentor_recommendation'].includes(event.type)) earlyOutput.push(event.type);
      },
    });
    // A serial implementation cannot release the first branch. Always release on failure so the test leaves no pending chat.
    const timer = setTimeout(() => ready.reject(new Error('waiting branches: ' + [...arrivals].join(', '))), 3000);
    try {
      await Promise.race([ready.promise, pending.then(() => assert.fail('chat completed before all branches entered'))]);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await Promise.allSettled([pending]);
    }
    const turn = await pending;
    assert.deepEqual([...arrivals].sort(), ['calculate', 'media', 'memory', 'mentor']);
    assert.deepEqual(memorySteps, ['recall', 'detail']);
    const audit = turn.context.toolCalls.map(call => call.name);
    assert.equal(audit[0], 'search_web');
    assert.deepEqual([...audit].sort(), ['calculate', 'find_mentor', 'get_memory_detail', 'recall_memory', 'search_web', 'share_photo']);
    assert.ok(audit.indexOf('recall_memory') < audit.indexOf('get_memory_detail'));
    const billed = turn.snapshot.tables.usage_records.filter(row => row.run_id === turn.run.id && row.tool_name && row.kind !== 'mentor_history_review');
    assert.deepEqual(billed.map(row => row.tool_name).sort(), [...audit].sort(), 'concurrent calls must retain separate usage records');
    assert.equal(finalReplies, 1);
    assert.deepEqual(earlyOutput, []);
    assert.deepEqual(parts(turn), [answer]);
    assert.deepEqual(offers(turn).map(event => event.mentor.id), [duoluo.id]);
    assert.deepEqual(turn.events.filter(event => event.type === 'character_media').map(event => event.attachment), mediaFails ? [] : [attachment]);
  });
});

test('a delivered video stays attached when the chat model incorrectly denies sending it', async () => {
  const attachment = { kind: 'video', id: 'a'.repeat(48) };
  let generations = 0;
  const app = await demo({
    toolDecision: {},
    characterMedia: { available: kind => kind === 'video', async generate() {
      generations++;
      return { ok: true, attachment };
    } },
    mediaPlan: () => ({ should_send_video: true, template_id: 'VID_POV_INTERACT',
      primary_subject: { asset_id: null, action_or_state: 'a wooden spoon stirring pudding' },
      environment_and_sound: 'warm kitchen light, a quiet spoon clink', spoken_line: null }),
  });
  const turn = await app.send('给我发段搅拌奶冻的视频。', {
    trigger: 'skip', mediaChoice: 'call',
    mediaDecision: { status: 'succeeded', anyToolProbability: 0.95, probabilities: [{ name: 'share_video', probability: 0.99 }] },
    reply: '这个视频我发不了。不过小勺碰到碗边时会叮一声。',
  });
  assert.equal(generations, 1);
  assert.equal(turn.outerRequests.length, 1);
  assert.deepEqual(parts(turn), ['这段视频给你。', '不过小勺碰到碗边时会叮一声。']);
  assert.deepEqual(turn.events.find(event => event.type === 'character_media')?.attachment, attachment);
});

test('the global probability must exceed 65% before any selected tool runs', async () => {
  let separateDecisions = 0;
  const app = await demo({
    search: { configured: true, async search() { assert.fail('unexpected search'); } },
    characterMedia: { available: () => true, async generate() { assert.fail('unexpected attachment'); } },
    toolDecision: { async evaluate() { separateDecisions++; throw new Error('unexpected separate routing request'); } },
  });
  for (const probability of [0.65, 0.3]) {
    const turn = await app.send('继续聊吧。', {
      trigger: 'call', searchChoice: 'call', calculateChoice: 'call', mediaChoice: 'call',
      mediaDecision: { status: 'succeeded', anyToolProbability: probability, probabilities: [{ name: 'share_photo', probability: 1 }] },
      reply: '好呀。',
    });
    assert.equal(turn.triggerRequests.length, 1);
    assert.deepEqual(turn.context.toolCalls, []);
    assert.deepEqual(turn.classifications, []);
    assert.deepEqual(turn.outerRequests.map(request => request.tools), [[]]);
    assert.deepEqual(parts(turn), ['好呀。']);
  }
  assert.equal(separateDecisions, 0);
});

test('the trigger can route the same topic share differently for two specialties', async () => {
  const app = await demo();
  const text = '我们课上聊到，存进银行的钱也会产生利息。';
  const reply = '利息是银行按约定付给存款人的一小笔报酬。';
  const reason = '孩子想弄懂银行利息，利利能讲清银行给利息的原因。';
  const trigger = ({ state }) => state.currentMentor.specialty === lili.metadata.mentor.specialty ? 'skip' : 'call';
  const inner = proactive(lili, text, 'money-decisions', { reason, replyHint: reply });
  const first = await app.send(text, { trigger, reply, decision: inner });
  const specialist = await app.send(text, { agentId: lili.id, trigger, reply, decision: inner });

  assert.equal(first.triggerRequests.length, 1);
  assert.equal(specialist.triggerRequests.length, 1);
  assert.deepEqual(first.triggerRequests[0].state.latestUserMessages, [text]);
  assert.deepEqual(specialist.triggerRequests[0].state.latestUserMessages, [text]);
  assert.equal(first.triggerRequests[0].state.currentMentor.specialty, currentMentor.metadata.mentor.specialty);
  assert.equal(specialist.triggerRequests[0].state.currentMentor.specialty, lili.metadata.mentor.specialty);
  assert.equal(first.context.mentorTrigger.choice, 'call');
  assert.equal(specialist.context.mentorTrigger.choice, 'skip');
  assert.deepEqual(first.classifications.map(entry => entry.input.currentMentor.id), [currentMentor.id]);
  assert.deepEqual(specialist.classifications, []);
  assert.deepEqual(specialist.receipts, []);
  assert.deepEqual(specialist.context.toolCalls, []);
  assert.deepEqual(parts(specialist), [reply]);
  assert.deepEqual(offers(specialist), []);
  assert.deepEqual(offers(first).map(event => event.mentor.id), [lili.id]);

  const repeat = await app.send(text, { trigger, reply, decision: decision('stay', { reason: '已经推荐过利利来讲银行利息。' }) });
  const [{ state, questions }] = repeat.triggerRequests;
  assert.deepEqual(Object.keys(questions), ['find_mentor', 'calculate']);
  assert.equal(Object.hasOwn(state, 'mentors'), false);
  assert.equal(Object.hasOwn(state, 'recommendationHistory'), false);
  assert.equal(JSON.stringify(questions).includes(MENTOR_DECISION_PROMPT), false);
  assert.equal(historyFor(repeat)[0].reason, reason);
  assert.equal(repeat.receipts[0].status, 'stay');
  assert.deepEqual(offers(repeat), []);
});

test('uncertain or failed mentor routing still lets chat answer and persists the trigger result', async t => {
  for (const { label, trigger, status } of [
    { label: 'uncertain', trigger: 'uncertain', status: 'succeeded' },
    { label: 'failed request', trigger: new Error('synthetic provider failure'), status: 'failed' },
  ]) {
    await t.test(label, async () => {
      const app = await demo();
      const turn = await app.send('为什么有的鱼会发光？', { trigger, reply: '有些鱼靠身体里的特殊化学反应发光。' });
      const trace = turn.context.mentorTrigger;
      assert.equal(trace.model, 'test-trigger');
      assert.ok(Number.isFinite(trace.latencyMs));
      if (status === 'failed') assert.equal(trace.error, 'request_failed');
      else assert.equal(trace.choice, 'uncertain');
      assert.deepEqual(triggerUsageFor(turn).map(entry => [entry.model, entry.status]), [['test-trigger', status]]);
      assert.deepEqual(turn.classifications, []);
      assert.deepEqual(turn.receipts, []);
      assert.deepEqual(offers(turn), []);
      assert.deepEqual(parts(turn), ['有些鱼靠身体里的特殊化学反应发光。']);
    });
  }
});

test('a routed knowledge question can still get a stay receipt and a normal answer', async () => {
  const app = await demo();
  const text = '蜜蜂为什么要采蜜？';
  const turn = await app.send(text);
  assert.equal(turn.outerRequests.length, 1);
  assert.equal(turn.classifications.length, 1);
  assert.equal(turn.classifications[0].input.query, text);
  assert.equal(turn.receipts[0].status, 'stay');
  assert.deepEqual(parts(turn), [naturalAnswer]);
  assert.deepEqual(offers(turn), []);
  assert.equal(recorded(turn), null);
});

test('a specialist receives a routed question without marking it as outside the specialty', async () => {
  const text = '英语里的 th 怎么练发音？';
  const client = createToolDecisionClient({ model: 'test', url: 'https://example.com/decisions' }, 'test', {
    fetchImpl: async () => Response.json({ answers: {
      find_mentor: { type: 'choice', choice: 'question_or_help' },
      search_web: { type: 'choice', choice: 'skip' },
    } }),
  });
  const { decisions } = await client.decide(buildToolTriggerRequest({
    latestUserMessages: [text], previousTurns: [],
    currentMentor: { name: duoluo.name, specialty: duoluo.metadata.mentor.specialty },
    availableTools: ['find_mentor', 'search_web'],
  }));
  assert.deepEqual(decisions, { find_mentor: { choice: 'call', reason: 'question_or_help' }, search_web: { choice: 'skip' } });

  const app = await demo();
  const turn = await app.send(text, {
    agentId: duoluo.id, trigger: decisions.find_mentor.choice, triggerReason: decisions.find_mentor.reason,
    reply: '让舌尖轻轻碰上牙，再送一点气。',
  });
  assert.deepEqual(turn.context.toolCalls.map(call => call.name), ['find_mentor']);
  assert.equal(Object.hasOwn(turn.classifications[0].input, 'outsideSpecialty'), false);
  assert.equal(turn.receipts[0].status, 'stay');
  assert.deepEqual(offers(turn), []);
});

test('a stay receipt removes an unsupported referral while keeping the helpful reply', async () => {
  const app = await demo();
  const useful = '先把桌上的书放成一摞。';
  const turn = await app.send('我怎么整理这张桌子？', { reply: `${useful}可以去找康迪学收纳。` });
  assert.equal(turn.classifications.length, 1);
  assert.equal(turn.receipts[0].status, 'stay');
  assert.deepEqual(parts(turn), [useful]);
  assert.equal(turn.messages.at(-1).text, useful);
  assert.deepEqual(offers(turn), []);
  assert.equal(recorded(turn), null);
});

test('a main-model calculation keeps its own tool turn without repeating the mentor check', async () => {
  const app = await demo();
  const text = '23 加 54 等于几？';
  const nativeTool = { id: 'calc-1', type: 'function',
    function: { name: 'calculate', arguments: JSON.stringify({ expression: '23+54' }) } };
  const turn = await app.send(text, { nativeTool, reply: '等于 77。' });
  assert.equal(turn.classifications.length, 1);
  assert.equal(turn.outerRequests.length, 2);
  assert.deepEqual(turn.context.toolCalls.map(({ name, source }) => [name, source]),
    [['find_mentor', 'turn_check'], ['calculate', undefined]]);
  assert.equal(turn.receipts[0].status, 'stay');
  assert.equal(turn.receipts[1].ok, true);
  assert.equal(parts(turn).at(-1), '等于 77。');
  assert.deepEqual(offers(turn), []);
});

test('the same semantic check routes a mentor and forces the independently requested web search once', async () => {
  const query = '自然博物馆 蝴蝶 如何观察 翅膀';
  const result = { title: '蝴蝶观察入门', url: 'https://example.com/butterflies', snippet: '从一臂之外观察翅膀。' };
  const queries = [];
  const app = await demo({ search: { configured: true, async search({ query }) {
    queries.push(query);
    return { results: [result], metadata: { retrieved_at: '2026-11-24T04:00:00.000Z' } };
  } } });
  const text = '我想学怎么观察蝴蝶的翅膀，能给我找点自然博物馆的公开资料吗？';
  const reply = '博物馆资料建议，从一臂之外观察蝴蝶的翅膀。';
  const toolChoice = { type: 'function', function: { name: 'search_web' } };
  const nativeTool = { id: 'search-1', type: 'function',
    function: { name: 'search_web', arguments: JSON.stringify({ query }) } };
  const turn = await app.send(text, { triggerReason: 'outside_specialty', searchChoice: 'call', nativeTool, reply,
    decision: proactive(xiaolin, '观察蝴蝶的翅膀', 'nature-observation') });

  assert.equal(turn.triggerRequests.length, 1);
  assert.deepEqual(Object.keys(turn.triggerRequests[0].questions).sort(), ['calculate', 'find_mentor', 'search_web']);
  assert.deepEqual(turn.outerRequests.map(request => request.toolChoice), [toolChoice, undefined]);
  assert.deepEqual(turn.outerRequests.map(request => request.tools.some(tool => tool.function.name === 'search_web')), [true, false]);
  assert.deepEqual(turn.context.modelRequests.map(request => request.toolChoice), [toolChoice, undefined]);
  assert.equal(turn.context.mentorTrigger.searchChoice, 'call');
  assert.deepEqual(turn.context.toolCalls.map(call => call.name), ['search_web', 'find_mentor']);
  assert.deepEqual(queries, [query]);
  assert.equal(turn.receipts[0].ok, true);
  assert.deepEqual(turn.receipts[0].results, [result]);
  assert.deepEqual(turn.classifications[0].input.currentSearchEvidence, [{ title: result.title, snippet: result.snippet }]);
  assert.equal(turn.classifications[0].input.outsideSpecialty, true);
  assert.equal(parts(turn).at(-1), reply);
  assert.deepEqual(offers(turn).map(event => event.mentor.id), [xiaolin.id]);
});

test('a numerical request with a public lookup uses search before the planned calculation', async () => {
  const query = '公开资料 素数个数';
  const app = await demo({ search: { configured: true, async search() {
    return { results: [{ title: '数学公开数据', url: 'https://example.com/primes', snippet: '这里列有精确的计数数据。' }] };
  } } });
  const nativeTools = {
    search_web: { id: 'search-primes', type: 'function',
      function: { name: 'search_web', arguments: JSON.stringify({ query }) } },
    calculate: { id: 'estimate-primes', type: 'function',
      function: { name: 'calculate', arguments: JSON.stringify({ expression: '1000 / ln(1000)' }) } },
  };
  const turn = await app.send('先查实际数据，再用公式算 1000 附近的估值。', {
    trigger: 'skip', triggerReason: 'in_specialty', searchChoice: 'call', calculateChoice: 'call',
    nativeTool: choice => nativeTools[choice?.function.name], reply: '实际数据和公式估值各有一个结果。',
    agentId: pisili.id,
  });
  assert.deepEqual(turn.outerRequests.map(request => request.toolChoice?.function.name), ['search_web', 'calculate', undefined]);
  assert.equal(turn.context.mentorTrigger.calculateChoice, 'call');
  assert.deepEqual(turn.context.toolCalls.map(call => call.name), ['search_web', 'calculate']);
  assert.ok(turn.receipts[0].ok);
  assert.ok(turn.receipts[1].ok);
  assert.equal(turn.receipts[1].approximate, true);
  assert.ok(Math.abs(Number(turn.receipts[1].result) - (1000 / Math.log(1000))) < 1e-10);
  assert.equal(offers(turn).length, 0);
});

test('a planned calculation is retried once when the first model response omits the call', async () => {
  const app = await demo();
  let attempts = 0;
  const turn = await app.send('把 81 代进去，直接算一下平方根。', {
    trigger: 'skip', triggerReason: 'in_specialty', calculateChoice: 'call', agentId: pisili.id, reply: '算出来约等于 9。',
    nativeTool(choice) {
      if (choice?.function.name !== 'calculate' || ++attempts === 1) return undefined;
      return { id: 'after-missing-call', type: 'function',
        function: { name: 'calculate', arguments: JSON.stringify({ expression: 'sqrt(81)' }) } };
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(turn.outerRequests.map(request => request.toolChoice?.function.name), ['calculate', 'calculate', undefined]);
  assert.deepEqual(turn.context.toolCalls.map(call => call.name), ['calculate']);
  assert.equal(Number(turn.receipts[0].result), 9);
  assert.equal(parts(turn).filter(text => text === '算出来约等于 9。').length, 1);
});

test('a specialty research decision schedules its public lookup dependency when available', async () => {
  let searchAnswer = 'skip';
  const client = createToolDecisionClient({ model: 'test', url: 'https://example.com/decisions' }, 'test', {
    fetchImpl: async () => Response.json({
      answers: {
        find_mentor: { type: 'choice', choice: 'outside_specialty_research' },
        search_web: { type: 'choice', choice: searchAnswer },
      },
    }),
  });
  const input = { latestUserMessages: ['听说最近有篇论文解决了一个数学难题，知道是哪篇吗？'],
    previousTurns: [], currentMentor: { name: currentMentor.name, specialty: 'AI 原理与使用' } };
  const decide = async availableTools => (await client.decide(buildToolTriggerRequest({ ...input, availableTools }))).decisions;
  assert.deepEqual(await decide(['find_mentor', 'search_web']), {
    find_mentor: { choice: 'call', reason: 'outside_specialty_research' },
    search_web: { choice: 'call', reason: 'outside_specialty_research' },
  });
  assert.deepEqual(await decide(['find_mentor']), {
    find_mentor: { choice: 'call', reason: 'outside_specialty_research' },
  });
  for (const reason of ['explicit_no_search', 'missing_reference']) {
    searchAnswer = reason;
    assert.deepEqual(await decide(['find_mentor', 'search_web']), {
      find_mentor: { choice: 'call', reason: 'outside_specialty_research' },
      search_web: { choice: 'skip', reason },
    });
  }
});

test('a blocked search stays unavailable to main-model tool calls', async t => {
  for (const [searchReason, text, reply] of [
    ['explicit_no_search', '先不用联网，跟我解释一下这个数学概念。', '先从能确定的概念讲起。'],
    ['missing_reference', '水槽下面有个东西在响，那是什么？', '你听到的是滴答声，还是连续的嗡嗡声？'],
  ]) {
    await t.test(searchReason, async () => {
      let searches = 0;
      const app = await demo({ search: { configured: true, async search() {
        searches++;
        return { results: [] };
      } } });
      const turn = await app.send(text, {
        triggerReason: 'outside_specialty', searchReason,
        nativeTool: { id: 'unexpected-search', type: 'function',
          function: { name: 'search_web', arguments: JSON.stringify({ query: '找相似的例子' }) } },
        reply,
      });
      assert.equal(searches, 0);
      assert.ok(turn.outerRequests.every(request => request.tools.every(tool => tool.function.name !== 'search_web')));
      assert.equal(turn.context.mentorTrigger.searchReason, searchReason);
      assert.equal(turn.receipts.at(-1).ok, false);
      assert.deepEqual(parts(turn), [reply]);
    });
  }
});

test('a routed request reaches the inner decision with prior conversation before the main reply', async () => {
  const app = await demo();
  const greeting = await app.send('hello', { trigger: 'skip', reply: '嗨，我在。' });
  const translation = await app.send('苹果用英语怎么说', { reply: '苹果用英语说 apple。' });
  assert.deepEqual(greeting.classifications, []);
  assert.deepEqual(greeting.receipts, []);
  assert.equal(translation.classifications.length, 1);
  assert.equal(translation.receipts[0].status, 'stay');

  const text = '我想学英语口语了';
  const reply = '好啊，先试一句：Hi, how are you?';
  const turn = await app.send(text, { reply,
    decision: proactive(duoluo, text, 'english-speaking') });

  assert.equal(turn.outerRequests.length, 1);
  assert.equal(turn.classifications.length, 1);
  assert.equal(turn.classifications[0].input.query, text);
  assert.deepEqual(turn.classifications[0].input.latestUserMessages, [text]);
  assert.deepEqual(turn.classifications[0].input.previousTurns.filter(message => message.role === 'user').map(message => message.text),
    ['hello', '苹果用英语怎么说']);
  assert.deepEqual(turn.context.modelRequests.map(request => request.toolNames), [[]]);
  assert.deepEqual(turn.context.toolCalls.map(({ name, source, arguments: args }) => ({ name, source, args })),
    [{ name: 'find_mentor', source: 'turn_check', args: { query: text } }]);
  assert.equal(turn.receipts[0].status, 'offer');
  assert.deepEqual(parts(turn), [reply]);
  assert.equal(turn.messages.at(-1).text, reply);
  assert.deepEqual(offers(turn).map(event => event.mentor.id), [duoluo.id]);
  assert.ok(turn.events.findIndex(event => event.type === 'reply_part') <
    turn.events.findIndex(event => event.type === 'mentor_recommendation'));
  assert.equal(recorded(turn).categoryId, 'english-speaking');
});

test('main chat receives the completed mentor check before drafting and can still use other tools', async () => {
  const app = await demo();
  const text = '帮我找小林，我想聊聊观察蚂蚁。';
  const turn = await app.send(text, {
    decision: decision('offer', { mentorIds: [xiaolin.id], evidence: '帮我找小林', basis: 'explicit_request' }),
  });

  assert.equal(turn.outerRequests.length, 1);
  const [outer] = turn.outerRequests;
  assert.ok(!outer.system.includes('【导师工具内部判定】'));
  assert.ok(!outer.system.includes(mofei.id));
  assert.ok(!outer.system.includes(mofei.metadata.description));
  assert.ok(!outer.tools.some(item => item.function.name === 'find_mentor'));
  assert.ok(outer.tools.some(item => item.function.name === 'calculate'));
  assert.equal(outer.toolChoice, undefined);
  assert.equal(outer.previous.role, 'assistant');
  assert.equal(outer.previous.tool_calls.length, 1);
  const [lookup] = outer.previous.tool_calls;
  assert.equal(lookup.function.name, 'find_mentor');
  assert.deepEqual(JSON.parse(lookup.function.arguments), { query: text });
  assert.equal(outer.last.role, 'tool');
  assert.equal(outer.last.tool_call_id, lookup.id);

  assert.equal(turn.classifications.length, 1);
  const [inner] = turn.classifications;
  assert.equal(inner.system, MENTOR_DECISION_PROMPT);
  assert.deepEqual(inner.tools, []);
  assert.equal(inner.input.query, text);
  assert.deepEqual(inner.input.latestUserMessages, [text]);
  assert.equal(inner.input.previousInvitation, null);
  assert.ok(inner.input.mentors.some(mentor => mentor.id === mofei.id));
  assert.equal(turn.receipts[0].status, 'offer');
  assert.ok(turn.receipts[0].replyInstruction?.trim());
  assert.equal(Object.hasOwn(turn.receipts[0], 'nextAction'), false);
  assert.equal(turn.offersBeforeContinuation, 0);
  assert.deepEqual(offers(turn).map(event => [event.sessionId, event.mentor.id]), [[turn.sessionId, xiaolin.id]]);
  assert.deepEqual(parts(turn), [naturalAnswer]);
});

test('a short natural opening is part of the main answer', async () => {
  const app = await demo();
  const reply = ['好啊，你想追踪蚂蚁的路线。', '小林擅长观察昆虫，能陪你找蚂蚁的路线。'];
  const turn = await app.send('帮我找小林继续观察蚂蚁。', { reply,
    decision: decision('offer', { mentorIds: [xiaolin.id], evidence: '帮我找小林', basis: 'explicit_request' }) });
  assert.deepEqual(turn.events.filter(event => event.type === 'reply_part').map(({ kind, text }) => [kind, text]),
    reply.map(text => ['answer', text]));
  assert.equal(turn.outerRequests.length, 1);
  assert.equal(offers(turn).length, 1);
});

const englishPractice = '我想练习用英语在咖啡店点餐，老是开不了口。';
const sportsPractice = '我想练短跑起跑的动作，怎么把第一步蹬稳？';

const englishOffer = () => decision('offer', {
  mentorIds: [duoluo.id], evidence: '帮我找多罗', basis: 'explicit_request',
  categoryId: 'english-speaking',
  cardCopy: '多罗可以当店员，陪你练英文点餐。',
  handoffBrief: { goal: '练英文点餐', topic: '在咖啡店点餐', progress: '练过一句英文点餐', wantedHelp: '让多罗当店员' },
});

test('a persisted card survives unrelated chat and an explicit refusal updates it before the reply', async () => {
  const app = await demo();
  const source = currentMentor.id;
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  const card = offers(first)[0].card;
  assert.equal(card.copy, '多罗可以当店员，陪你练英文点餐。');
  const next = await app.send('你先教我怎么说。');
  assert.equal(next.events.some(event => event.type === 'mentor_card_updated'), false);
  const detailPath = `/api/sessions/${first.sessionId}`;
  assert.deepEqual((await app.request('GET', detailPath, source)).value.mentorCards, [card]);

  const declined = await app.send('我不想找多罗练了。', {
    decision: ({ activeMentorCard }) => {
      assert.equal(activeMentorCard.id, card.id);
      return decision('stay', { declinedCardId: activeMentorCard.id });
    },
  });
  assert.deepEqual(declined.triggerRequests[0].state.activeMentorCard, { mentorName: duoluo.name, goal: '练英文点餐' });
  const update = declined.events.findIndex(event => event.type === 'mentor_card_updated' && event.state === 'declined');
  assert.ok(update >= 0 && update < declined.events.findIndex(event => event.type === 'reply_part'));
  assert.deepEqual((await app.request('GET', detailPath, source)).value.mentorCards, [{ ...card, state: 'declined' }]);
  assert.equal((await app.request('POST', '/api/mentor-handoffs', source, { cardId: card.id })).status, 409);
});

test('the status route keeps the card live at fourteen minutes and the history grey exactly at fifteen', async () => {
  let now = Date.parse('2026-11-24T02:00:00.000Z');
  const app = await demo({ clock: () => new Date(now) });
  const source = currentMentor.id;
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  const card = offers(first)[0].card;
  const path = `/api/sessions/${first.sessionId}`;
  now += 14 * 60_000;
  assert.deepEqual((await app.request('GET', path + '/status', source)).value, {
    sessionId: first.sessionId, status: 'open', serverNow: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  assert.equal((await app.request('GET', path, source)).value.mentorCards[0].state, 'available');
  now += 60_000;
  assert.equal((await app.request('GET', path + '/status', source)).value.status, 'closed');
  assert.equal((await app.request('POST', '/api/mentor-handoffs', source, { cardId: card.id })).status, 409);
  assert.deepEqual((await app.request('GET', path, source)).value.mentorCards, [{ ...card, state: 'expired' }]);
});

test('an unconfirmed handoff cannot arrive once the source session expires', async () => {
  let now = Date.parse('2026-11-24T02:00:00.000Z');
  const app = await demo({ clock: () => new Date(now) });
  const source = currentMentor.id;
  const target = duoluo.id;
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  const card = offers(first)[0].card;
  now += 15 * 60_000 - 1;
  const prepared = await app.request('POST', '/api/mentor-handoffs', source, { cardId: card.id });
  assert.equal(prepared.status, 200);
  const targetSessionId = prepared.value.session.id;
  const arrivePath = `/api/mentor-handoffs/${card.id}/arrive`;

  now += 1;
  const atDeadline = await app.request('POST', arrivePath, target, { sessionId: targetSessionId });
  assert.equal(atDeadline.status, 409);
  now += 36 * 60 * 60_000;
  const lateRetry = await app.request('POST', arrivePath, target, { sessionId: targetSessionId });
  assert.equal(lateRetry.status, 409);
  assert.equal(app.welcomeRequests.length, 0);
  const sourceHistory = (await app.request('GET', `/api/sessions/${first.sessionId}`, source)).value;
  assert.deepEqual(sourceHistory.mentorCards, [{ ...card, state: 'expired' }]);
  const targetHistory = await app.request('GET', `/api/sessions/${targetSessionId}`, target);
  assert.deepEqual(targetHistory.value.messages, []);
  assert.equal(targetHistory.snapshot.tables.sessions.find(session => session.id === targetSessionId).mentor_handoff, null);
});

test('first handoff arrival starts the empty target deadline and the first user message renews it', async () => {
  const minute = 60_000;
  let now = Date.parse('2026-11-24T02:00:00.000Z');
  const app = await demo({ clock: () => new Date(now) });
  const source = currentMentor.id;
  const target = duoluo.id;
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  const cardId = offers(first)[0].card.id;
  now += minute;
  const prepared = await app.request('POST', '/api/mentor-handoffs', source, { cardId });
  assert.equal(prepared.status, 200);
  const sessionId = prepared.value.session.id;
  const statusPath = `/api/sessions/${sessionId}/status`;
  const arrivePath = `/api/mentor-handoffs/${cardId}/arrive`;
  assert.equal((await app.request('GET', statusPath, target)).value.expiresAt, null);

  now += minute;
  const deadline = now + 15 * minute;
  const arrival = await app.request('POST', arrivePath, target, { sessionId });
  assert.equal(arrival.status, 200, arrival.value.error);
  assert.ok(arrival.value.welcomeMessageId);
  assert.equal((await app.request('GET', statusPath, target)).value.expiresAt, new Date(deadline).toISOString());

  now += 7 * minute;
  const retry = await app.request('POST', arrivePath, target, { sessionId });
  assert.equal(retry.value.welcomeMessageId, arrival.value.welcomeMessageId);
  assert.equal(app.welcomeRequests.length, 1);
  assert.equal((await app.request('GET', statusPath, target)).value.expiresAt, new Date(deadline).toISOString());

  const nextOffer = await app.send('帮我找多罗，我还想练英文点餐。', { decision: englishOffer() });
  const nextCardId = offers(nextOffer)[0].card.id;
  const nextTransfer = await app.request('POST', '/api/mentor-handoffs', source, { cardId: nextCardId });
  assert.equal(nextTransfer.value.session.id, sessionId);
  const nextArrival = await app.request('POST', `/api/mentor-handoffs/${nextCardId}/arrive`, target, { sessionId });
  assert.equal(nextArrival.status, 200);
  assert.equal((await app.request('GET', statusPath, target)).value.expiresAt, new Date(deadline).toISOString());

  now = deadline - 1;
  assert.equal((await app.request('GET', statusPath, target)).value.status, 'open');
  const reply = await app.send('你好，我想学怎么说我要一杯果汁。', { agentId: target, sessionId, trigger: 'skip' });
  assert.equal(reply.sessionId, sessionId);
  const renewedDeadline = now + 15 * minute;
  now = deadline;
  const renewed = (await app.request('GET', statusPath, target)).value;
  assert.equal(renewed.status, 'open');
  assert.equal(renewed.expiresAt, new Date(renewedDeadline).toISOString());
  now = renewedDeadline;
  const expired = (await app.request('GET', statusPath, target)).value;
  assert.equal(expired.status, 'closed');
  assert.equal(expired.expiresAt, new Date(renewedDeadline).toISOString());
});

test('a target without a welcome reply still expires and carries the handoff into the first user turn', async () => {
  const minute = 60_000;
  let now = Date.parse('2026-11-24T02:00:00.000Z');
  const app = await demo({ clock: () => new Date(now), failWelcome: true });
  const source = currentMentor.id;
  const target = duoluo.id;
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  const cardId = offers(first)[0].card.id;
  const prepared = await app.request('POST', '/api/mentor-handoffs', source, { cardId });
  assert.equal(prepared.status, 200);
  const sessionId = prepared.value.session.id;
  const statusPath = `/api/sessions/${sessionId}/status`;
  const arrivePath = `/api/mentor-handoffs/${cardId}/arrive`;
  now += minute;
  const deadline = now + 15 * minute;
  const arrival = await app.request('POST', arrivePath, target, { sessionId });
  assert.equal(arrival.status, 200);
  assert.equal(arrival.value.welcomePending, true);
  assert.equal((await app.request('GET', statusPath, target)).value.expiresAt, new Date(deadline).toISOString());

  now = deadline - 1;
  assert.equal((await app.request('GET', statusPath, target)).value.status, 'open');
  now = deadline;
  const retry = await app.request('POST', arrivePath, target, { sessionId });
  assert.equal(retry.status, 200);
  assert.equal(retry.value.session.id, sessionId);
  assert.equal(retry.value.session.status, 'closed');
  assert.equal(retry.value.welcomeMessageId, null);
  assert.equal(retry.value.welcomePending, undefined);
  assert.equal(app.welcomeRequests.length, 1);
  assert.equal(retry.snapshot.tables.jobs.some(job => job.session_id === sessionId), false);

  const reply = await app.send('布爸说我可以和你练点餐，怎么开始？', { agentId: target, sessionId, trigger: 'skip' });
  assert.notEqual(reply.sessionId, sessionId);
  assert.match(reply.outerRequests[0].background.content, /练英文点餐/);
  const replacement = (await app.request('GET', `/api/sessions/${reply.sessionId}/status`, target)).value;
  assert.equal(replacement.expiresAt, new Date(now + 15 * minute).toISOString());
});

test('a successful arrival welcomes once, carries only relevant progress, and supplies private source history across sessions', async () => {
  let now = Date.parse('2026-11-24T02:00:00.000Z');
  const deadline = new Date(now + 15 * 60_000).toISOString();
  const app = await demo({ clock: () => new Date(now) });
  const source = currentMentor.id;
  const target = duoluo.id;
  const existing = await app.send('cat 怎么读？', { agentId: target, trigger: 'skip' });
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  const card = offers(first)[0].card;
  const followup = await app.send('我会说 I’d like a sandwich 了。');
  now += 60_000;
  const prepared = await app.request('POST', '/api/mentor-handoffs', source, { cardId: card.id });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.value.agentId, target);
  assert.equal(prepared.value.session.id, existing.sessionId);
  const arrivePath = `/api/mentor-handoffs/${card.id}/arrive`;
  const before = await app.request('GET', `/api/sessions/${first.sessionId}`, source);
  assert.equal(before.value.mentorCards[0].state, 'available');
  const arrival = await app.request('POST', arrivePath, target, { sessionId: existing.sessionId });
  assert.equal(arrival.status, 200, arrival.value.error);
  assert.ok(arrival.value.welcomeMessageId);
  const repeated = await app.request('POST', arrivePath, target, { sessionId: existing.sessionId });
  assert.equal(repeated.value.welcomeMessageId, arrival.value.welcomeMessageId);
  const targetStatus = await app.request('GET', `/api/sessions/${existing.sessionId}/status`, target);
  assert.equal(targetStatus.value.expiresAt, deadline);
  assert.equal(app.welcomeRequests.length, 1);
  assert.equal(app.briefRequests.length, 1);
  const welcomeInput = app.welcomeRequests[0].messages.at(-1).content;
  assert.match(welcomeInput, /鳄鱼爸爸/);
  assert.match(welcomeInput, /孩子已经能说出一整句英文点餐/);
  const { targetRecentTurns, ...handoffBrief } = JSON.parse(welcomeInput.split('\n').at(-1));
  assert.equal(targetRecentTurns[0].text, 'cat 怎么读？');
  assert.doesNotMatch(JSON.stringify(handoffBrief), /cat 怎么读/);
  assert.match(JSON.stringify(app.briefRequests[0].messages), /我会说 I’d like a sandwich/);
  const targetHistory = (await app.request('GET', `/api/sessions/${existing.sessionId}`, target)).value;
  assert.deepEqual(targetHistory.messages.map(message => message.role), ['user', 'assistant', 'assistant']);
  assert.equal(targetHistory.messages.at(-1).id, arrival.value.welcomeMessageId);
  assert.deepEqual(targetHistory.messages.at(-1).parts, ['嗨，你来啦！', '布爸说你想练英文点餐，我可以陪你练。']);
  const sourceHistory = (await app.request('GET', `/api/sessions/${first.sessionId}`, source)).value;
  assert.equal(sourceHistory.messages.length, followup.messages.length);
  assert.equal(sourceHistory.mentorCards[0].state, 'visited');
  assert.equal(Object.hasOwn(sourceHistory.mentorCards[0], 'brief'), false);

  now += 15 * 60_000;
  const retryAfterExpiry = await app.request('POST', arrivePath, target, { sessionId: existing.sessionId });
  assert.equal(retryAfterExpiry.status, 200);
  assert.equal(retryAfterExpiry.value.welcomeMessageId, arrival.value.welcomeMessageId);
  assert.equal(app.welcomeRequests.length, 1);
  const returned = await app.send('那句我还是不会。', { trigger: 'skip', reply: '和多罗练到哪一步啦？' });
  assert.notEqual(returned.sessionId, first.sessionId);
  assert.match(returned.outerRequests[0].background.content, /历史转介资料/);
  assert.match(returned.outerRequests[0].background.content, /练英文点餐/);
  assert.match(returned.outerRequests[0].system, /之前的转介/);
  assert.doesNotMatch(JSON.stringify(returned.context), /历史转介资料|之前的转介/);
  assert.deepEqual(parts(returned), ['和多罗练到哪一步啦？']);
  const targetChat = await app.send('继续吧。', { agentId: target, trigger: 'skip' });
  assert.notEqual(targetChat.sessionId, existing.sessionId);
  assert.match(targetChat.outerRequests[0].system, /接续转介/);
  assert.match(targetChat.outerRequests[0].background.content, /练英文点餐/);
  const continuation = await app.send('你知道我和鳄鱼爸爸聊啥了吗？', { agentId: target, trigger: 'skip' });
  assert.equal(continuation.sessionId, targetChat.sessionId);
  assert.match(continuation.outerRequests[0].background.content, /孩子已经能说出一整句英文点餐/);
});

test('the target keeps handoff context in ordinary replies even when welcome fails and a later retry stays silent', async () => {
  const app = await demo({ failWelcome: true });
  const source = currentMentor.id;
  const target = duoluo.id;
  const existing = await app.send('cat 怎么读？', { agentId: target, trigger: 'skip' });
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  const cardId = offers(first)[0].card.id;
  const prepared = await app.request('POST', '/api/mentor-handoffs', source, { cardId });
  assert.equal(prepared.value.session.id, existing.sessionId);
  const path = `/api/mentor-handoffs/${cardId}/arrive`;
  const arrival = await app.request('POST', path, target, { sessionId: existing.sessionId });
  assert.equal(arrival.value.welcomePending, true);
  const destination = arrival.snapshot.tables.sessions.find(session => session.id === existing.sessionId);
  assert.equal(JSON.parse(destination.mentor_handoff).brief.goal, '练英文点餐');
  app.editSnapshot(snapshot => {
    const sourceRun = snapshot.tables.runs.find(run => run.id === cardId);
    const record = JSON.parse(sourceRun.mentor_recommendation);
    record.card.brief.goal = '原卡片后来写了不同话题';
    sourceRun.mentor_recommendation = JSON.stringify(record);
  });

  const asked = await app.send('你知道我和鳄鱼爸爸聊啥了吗？', {
    agentId: target, trigger: 'skip', reply: '你和鳄鱼爸爸聊了怎么用英语点餐。',
  });
  assert.equal(asked.sessionId, existing.sessionId);
  assert.match(asked.outerRequests[0].background.content, /鳄鱼爸爸/);
  assert.match(asked.outerRequests[0].background.content, /练英文点餐/);
  assert.doesNotMatch(asked.outerRequests[0].background.content, /原卡片后来/);
  assert.match(asked.outerRequests[0].system, /接续转介/);
  assert.doesNotMatch(JSON.stringify(asked.context.requestMessages), /历史转介资料|接续转介/);
  assert.deepEqual(parts(asked), ['你和鳄鱼爸爸聊了怎么用英语点餐。']);
  assert.equal(app.welcomeRequests.length, 1);

  const retried = await app.request('POST', path, target, { sessionId: existing.sessionId });
  assert.equal(retried.status, 200, retried.value.error);
  assert.equal(retried.value.welcomeMessageId, null);
  assert.equal(retried.value.welcomePending, undefined);
  assert.equal(app.welcomeRequests.length, 1);
  const latest = (await app.request('GET', `/api/sessions/${existing.sessionId}`, target)).value;
  assert.deepEqual(latest.messages, asked.messages);
});

test('a completed proactive card is recorded after helpful text and its history is provided to the model', async () => {
  const app = await demo();
  const reply = '先试着说一句：Can I have some juice?';
  const reason = '孩子想用英语练点餐，多罗能做口语情景对话。';
  const first = await app.send(englishPractice, { reply,
    decision: proactive(duoluo, '练习用英语在咖啡店点餐', 'english-speaking', { reason }) });
  assert.deepEqual(historyFor(first), []);
  assert.equal(first.receipts[0].status, 'offer');
  assert.equal(first.offersBeforeContinuation, 0);
  assert.deepEqual(offers(first).map(event => event.mentor.id), [duoluo.id]);
  const answerIndex = first.events.findIndex(event => event.type === 'reply_part' && event.text === reply);
  const cardIndex = first.events.findIndex(event => event.type === 'mentor_recommendation');
  assert.ok(answerIndex >= 0 && cardIndex > answerIndex);
  const entry = recorded(first);
  assert.ok(entry.at);
  const { card, ...record } = entry;
  assert.equal(card.state, 'available');
  assert.equal(card.mentor.id, duoluo.id);
  assert.equal(offers(first)[0].card.messageId, first.messages.at(-1).id);
  assert.deepEqual(record, { action: 'offer', basis: 'proactive_specialty', mentorId: duoluo.id,
    categoryId: 'english-speaking', at: entry.at, reason });

  await app.send('蜜蜂把花蜜带去哪里？');
  await app.send('那为什么要存起来？');
  const repeatedReply = '可以开口说：Excuse me, where is the library?';
  const stayReason = '虽然换了场景，孩子还是在练英语口语，多罗已经推荐过。';
  const repeated = await app.send('再换个场景，我想练用英语问去图书馆的路。', { reply: repeatedReply,
    decision: ({ recommendationHistory }) => recommendationHistory.some(record => record.categoryId === 'english-speaking')
      ? decision('stay', { reason: stayReason }) : proactive(duoluo, repeatedReply, 'english-speaking') });
  assert.deepEqual(historyFor(repeated), [historyEntry(first, 2)]);
  assert.equal(repeated.receipts[0].status, 'stay');
  assert.equal(repeated.receipts[0].reason, stayReason);
  assert.deepEqual(parts(repeated), [repeatedReply]);
  assert.deepEqual(offers(repeated), []);
  assert.equal(repeated.context.mentorInvitation, undefined);
  assert.equal(recorded(repeated), null);

  const newSession = await app.newSession();
  const fresh = await app.send(englishPractice, { reply,
    decision: proactive(duoluo, '练习用英语在咖啡店点餐', 'english-speaking'),
    historyReview: { decision: 'stay', reason: '孩子在新会话继续原来的英语点餐练习。' } });
  assert.equal(fresh.sessionId, newSession);
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.equal(fresh.classifications[0].input.activeMentorCard, undefined);
  assert.deepEqual(historyFor(fresh), [historyEntry(first, 3, 'expired')]);
  assert.deepEqual(fresh.historyReviews[0].input.recommendationHistory, historyFor(fresh));
  assert.equal(fresh.receipts[0].status, 'stay');
  assert.deepEqual(offers(fresh), []);

  const requested = await app.send('这次帮我找多罗，我想跟他接着练点餐。', { decision: englishOffer() });
  assert.deepEqual(historyFor(requested), [historyEntry(first, 4, 'expired')]);
  assert.deepEqual(requested.historyReviews, []);
  assert.deepEqual(offers(requested).map(event => event.mentor.id), [duoluo.id]);
  const oldSession = await app.request('GET', `/api/sessions/${first.sessionId}`, currentMentor.id);
  assert.equal(oldSession.value.mentorCards[0].state, 'expired');
});

test('recommendation history is isolated by both child and source agent', async () => {
  const app = await demo();
  const first = await app.send('帮我找多罗，我想练英文点餐。', { decision: englishOffer() });
  await app.newSession();
  const otherSource = await app.send(englishPractice, { agentId: mofei.id });
  assert.deepEqual(historyFor(otherSource), []);

  const created = await app.request('POST', '/api/children', currentMentor.id, { name: '另一个孩子', age: 9 });
  assert.equal(created.status, 201, created.value.error);
  const otherChild = await app.send(englishPractice, { childId: created.value.child.id });
  assert.deepEqual(historyFor(otherChild), []);

  const sameScope = await app.send('刚才那个点餐句子怎么说来着？');
  assert.deepEqual(historyFor(sameScope), [historyEntry(first, 0, 'expired')]);
});

test('the history reviewer can approve an independent new goal before two completed rounds', async () => {
  const app = await demo();
  const first = await app.send(englishPractice, { reply: '开口先说：May I have a juice?',
    decision: proactive(duoluo, '练习用英语在咖啡店点餐', 'english-speaking') });
  await app.send('下雨前为什么闻得到泥土味？', { reply: '雨滴会把泥土里的气味带进空气中。' });
  const failed = await app.send('土干了以后还能闻到吗？', { failContinuation: true,
    decision: decision('stay'), reply: '土干了以后气味通常会减弱。' });
  assert.equal(failed.run.status, 'failed');
  assert.equal(recorded(failed), null);

  const sports = proactive(shangang, '练短跑起跑的动作', 'sports-technique');
  const sportsReply = '先轻轻蹬地试一次，看看身体有没有跟上。';
  const ready = await app.send(sportsPractice, {
    decision: sports, historyReview: { decision: 'proceed', reason: '这是独立的短跑起跑练习。' }, reply: sportsReply,
  });
  assert.equal(historyFor(ready)[0].id, first.run.id);
  assert.equal(historyFor(ready)[0].turnsSince, 1);
  assert.deepEqual(ready.historyReviews[0].input.recommendationHistory, historyFor(ready));
  assert.equal(ready.receipts[0].status, 'offer');
  assert.equal(ready.context.toolCalls[0].result.historyReview.decision, 'proceed');
  assert.deepEqual(offers(ready).map(event => event.mentor.id), [shangang.id]);
  assert.deepEqual(ready.events.find(event => event.type === 'mentor_card_updated'), {
    type: 'mentor_card_updated', sessionId: ready.sessionId, cardId: first.run.id, state: 'superseded',
  });

  const requested = await app.send('那就帮我找山冈继续练起跑。', { decision: decision('offer', {
    mentorIds: [shangang.id], evidence: '帮我找山冈', basis: 'explicit_request', categoryId: 'sports-technique',
  }), reply: '山冈能陪你把预备姿势和第一步分开练。' });
  assert.deepEqual(historyFor(requested).map(({ id, turnsSince }) => [id, turnsSince]), [[ready.run.id, 0], [first.run.id, 2]]);
  assert.deepEqual(requested.historyReviews, []);
  assert.equal(requested.receipts[0].status, 'offer');
  assert.equal(requested.offersBeforeContinuation, 0);
  assert.deepEqual(offers(requested).map(event => event.mentor.id), [shangang.id]);
  assert.equal(recorded(requested).basis, 'explicit_request');

  const another = await app.send('我想做一周零花钱预算，先该怎么分？', {
    decision: decision('stay'), reply: '先列出这一周肯定要花的和可以等一等的。',
  });
  assert.equal(historyFor(another)[0].id, requested.run.id);
  assert.equal(historyFor(another)[0].turnsSince, 0);
  assert.equal(another.receipts[0].status, 'stay');
  assert.deepEqual(offers(another), []);
  assert.equal(recorded(another), null);
});

test('the model can recognize the same project from the new question and an earlier recommendation reason', async () => {
  const app = await demo();
  const goal = '英语体育解说';
  const first = await app.send('我想排练一段英语体育解说，讲讲运动员怎么起跑。', {
    decision: proactive(duoluo, '排练一段英语体育解说', 'english-speaking', {
      reason: '孩子在排练英语体育解说，多罗可以帮他练口语。',
    }), reply: '可以从 The runners are ready 开始。',
  });
  await app.send('蜜蜂把花蜜带去哪里？');
  await app.send('那为什么要存起来？');
  const sameTask = await app.send('回到那段英语体育解说，我还要把短跑起跑讲清楚。', {
    decision: ({ latestUserMessages, recommendationHistory }) => {
      assert.ok(latestUserMessages[0].includes(goal));
      assert.ok(recommendationHistory[0].reason.includes(goal));
      return decision('stay', { reason: '还在做同一段解说，先陪孩子把起跑动作讲清楚。' });
    },
    reply: '先说他们弯下身准备，然后蹬地跑出去。',
  });
  assert.equal(historyFor(sameTask)[0].id, first.run.id);
  assert.equal(historyFor(sameTask)[0].turnsSince, 2);
  assert.equal(sameTask.receipts[0].status, 'stay');
  assert.deepEqual(parts(sameTask), ['先说他们弯下身准备，然后蹬地跑出去。']);
  assert.deepEqual(offers(sameTask), []);
  assert.equal(sameTask.context.mentorInvitation, undefined);
  assert.equal(recorded(sameTask), null);
});

test('the backend preserves an offer the reviewer approves even with the same category and a recent card', async () => {
  const app = await demo();
  const first = await app.send(englishPractice, { decision: proactive(duoluo, englishPractice, 'english-speaking') });
  const reply = '可以先说：Excuse me, where is the station?';
  const turn = await app.send('我想换个场景练口语，模拟问路。', {
    reply, triggerReason: 'outside_specialty',
    decision: proactive(duoluo, '模拟问路', 'english-speaking'),
  });
  assert.deepEqual(historyFor(turn), [historyEntry(first, 0)]);
  assert.equal(turn.historyReviews.length, 1);
  assert.equal(turn.context.toolCalls[0].result.historyReview.decision, 'proceed');
  assert.equal(turn.receipts[0].status, 'offer');
  assert.equal(turn.offersBeforeContinuation, 0);
  assert.deepEqual(offers(turn).map(event => event.mentor.id), [duoluo.id]);
  assert.equal(recorded(turn).categoryId, 'english-speaking');

  const followup = await app.send('我先把刚才那句话读一遍。');
  assert.deepEqual(historyFor(followup), [
    historyEntry(turn, 0),
    historyEntry(first, 1, 'superseded'),
  ]);
});

test('elapsed wall time leaves consecutive passive offers at zero turns and lets the reviewer keep the child in chat', async () => {
  let now = Date.parse('2026-11-24T07:15:33.474Z');
  const app = await demo({ clock: () => new Date(now) });
  const firstText = '最近很火的一个数学猜想被证明了，那个东西是啥你帮我搜一下呢';
  const first = await app.send(firstText, {
    decision: proactive(pisili, '数学猜想', 'math-calculation', { reason: '皮斯理可以解释数学猜想。' }),
    reply: '猜想是数学家提出、还需要证明的说法。',
  });
  assert.deepEqual(first.historyReviews, []);
  assert.deepEqual(offers(first).map(event => event.mentor.id), [pisili.id]);

  now += 181_000;
  const text = '黎曼猜想这个东西是啥呢？你简单解释下吧';
  const reply = '它关心的是素数出现的规律。';
  const reason = '这是同一个数学猜想的追问，推荐之后还没有完成一个回合。';
  const second = await app.send(text, {
    decision: proactive(pisili, '黎曼猜想', 'math-calculation', { reason: '皮斯理可以解释黎曼猜想。' }),
    historyReview: { decision: 'stay', reason, replyHint: reply }, reply,
  });
  assert.equal(second.sessionId, first.sessionId);
  const [review] = second.historyReviews;
  assert.equal(second.historyReviews.length, 1);
  assert.deepEqual(review.tools, []);
  assert.deepEqual(review.input.recommendationHistory, [historyEntry(first, 0)]);
  assert.deepEqual(review.input.latestUserMessages, [text]);
  assert.ok(review.input.previousTurns.some(turn => turn.role === 'user' && turn.text === firstText));
  assert.equal(review.input.candidate.categoryId, 'math-calculation');
  assert.equal(review.input.candidate.status, 'offer');
  assert.equal(review.input.candidate.mentor.name, pisili.name);
  assert.equal(second.receipts[0].status, 'stay');
  assert.equal(second.receipts[0].reason, reason);
  assert.equal(second.receipts[0].replyHint, reply);
  assert.deepEqual(second.context.toolCalls[0].result.historyReview, { decision: 'stay', reason });
  assert.equal(Object.hasOwn(second.receipts[0], 'historyReview'), false);
  const decisionCharges = second.snapshot.tables.usage_records.filter(row => row.run_id === second.run.id &&
    ['mentor_decision', 'mentor_history_review'].includes(row.kind));
  assert.deepEqual(decisionCharges.map(row => row.kind).sort(), ['mentor_decision', 'mentor_history_review']);
  assert.deepEqual(offers(second), []);
  assert.equal(recorded(second), null);
  assert.deepEqual(parts(second), [reply]);
});

test('an unavailable history reviewer does not display or persist the unreviewed card', async t => {
  for (const [name, historyReview] of [
    ['request failure', new Error('synthetic history reviewer failure')],
    ['malformed verdict', { decision: 'retry', reason: '格式错误。' }],
  ]) {
    await t.test(name, async () => {
      const app = await demo();
      const first = await app.send(englishPractice, { decision: proactive(duoluo, englishPractice, 'english-speaking') });
      assert.equal(offers(first).length, 1);
      const reply = '蹬稳以后再往前迈。';
      const second = await app.send(sportsPractice, {
        decision: proactive(shangang, sportsPractice, 'sports-technique'), historyReview, reply,
      });
      assert.equal(second.historyReviews.length, 1);
      assert.equal(second.receipts[0].status, 'unavailable');
      assert.equal(second.context.toolCalls[0].result.historyReview.decision, 'unavailable');
      assert.deepEqual(offers(second), []);
      assert.equal(recorded(second), null);
      assert.deepEqual(parts(second), [reply]);
    });
  }
});

test('explicit requests by capability can offer a card after an unrelated refusal', async () => {
  const app = await demo();
  const english = await app.send(englishPractice, {
    triggerReason: 'outside_specialty',
    decision: proactive(duoluo, '练习用英语在咖啡店点餐', 'english-speaking'),
  });
  assert.deepEqual(offers(english).map(event => event.mentor.id), [duoluo.id]);
  const refusal = await app.send('我还是听你讲吧，我不去找别人。', {
    trigger: 'skip', triggerReason: 'ordinary_chat_or_utility', reply: '好，咱俩在这里练。',
  });
  assert.deepEqual(offers(refusal), []);

  const math = await app.send('你又不懂数学，你带我去找懂数学的', {
    triggerReason: 'outside_specialty',
    decision: decision('offer', {
      mentorIds: [pisili.id], evidence: '带我去找懂数学的', basis: 'explicit_request', categoryId: 'math-calculation',
    }),
  });
  assert.equal(historyFor(math)[0].turnsSince, 1);
  assert.equal(math.context.mentorTrigger.reason, 'outside_specialty');
  assert.equal(math.receipts[0].status, 'offer');
  assert.deepEqual(offers(math).map(event => event.mentor.id), [pisili.id]);

  const biology = await app.send('换个懂观察小动物的和我聊聊吧。', {
    decision: decision('offer', {
      mentorIds: [xiaolin.id], evidence: '换个懂观察小动物的和我聊聊', basis: 'explicit_request',
    }),
  });
  assert.equal(historyFor(biology)[0].turnsSince, 0);
  assert.equal(biology.receipts[0].status, 'offer');
  assert.deepEqual(offers(biology).map(event => event.mentor.id), [xiaolin.id]);
});

test('an unfinished response leaves its candidate out of the recommendation history', async () => {
  const app = await demo();
  const english = proactive(duoluo, '练习用英语在咖啡店点餐', 'english-speaking');
  const failed = await app.send(englishPractice, { decision: english, failContinuation: true });
  assert.equal(failed.receipts[0].status, 'offer');
  assert.equal(failed.offersBeforeContinuation, 0);
  assert.deepEqual(offers(failed), []);
  assert.equal(recorded(failed), null);

  const visible = await app.send('帮我找多罗，我想跟她练点餐。', { failContinuation: true, decision: decision('offer', {
    mentorIds: [duoluo.id], evidence: '帮我找多罗', basis: 'explicit_request', categoryId: 'english-speaking',
  }) });
  assert.deepEqual(historyFor(visible), []);
  assert.equal(visible.offersBeforeContinuation, 0);
  assert.deepEqual(offers(visible), []);
  assert.equal(recorded(visible), null);

  const next = await app.send(sportsPractice, {
    decision: decision('stay'), reply: '先从一次轻蹬地的小练习开始。',
  });
  assert.deepEqual(historyFor(next), []);
  assert.equal(next.receipts[0].status, 'stay');
  assert.deepEqual(offers(next), []);
  assert.equal(recorded(next), null);
});

test('Benny receives the published role prompt verbatim while the mentor tool still uses his catalog profile', async () => {
  const published = readFileSync(new URL('../config/benny-published-prompt.md', import.meta.url), 'utf8');
  assert.equal(currentMentor.definition, published);
  const app = await demo();
  const turn = await app.send('布爸在吗？', { reply: '在。' });
  assert.ok(turn.outerRequests[0].system.includes(`【角色设定】${published}`));
  assert.ok(!turn.outerRequests[0].system.includes(currentMentor.metadata.description));
  assert.equal(turn.classifications[0].input.currentMentor.description, currentMentor.metadata.description);
});

test('directory answers expose eligible published profiles and never emit an introduction card', async () => {
  const adult = { ...mofei, id: 'adult-mentor', name: '成年物理导师',
    metadata: { ...mofei.metadata, audience: { minimumAge: 18 } } };
  const hidden = { ...mofei, id: 'hidden-mentor', name: '隐藏导师',
    metadata: { ...mofei.metadata, hidden: true } };
  const retired = { ...mofei, id: 'deleted-mentor', name: '退休导师',
    metadata: { ...mofei.metadata, publicDeleted: true } };
  const app = await demo({ agents: [...demoAgents, adult, hidden, retired] });
  const list = await app.send('有哪些导师，各自会什么？', { decision: decision('directory') });
  assert.equal(list.receipts[0].status, 'directory');
  const eligibleIds = demoAgents.map(mentor => mentor.id).sort();
  assert.equal(eligibleIds.length, 12);
  assert.deepEqual(list.receipts[0].mentors.map(mentor => mentor.id).sort(), eligibleIds);
  assert.deepEqual(list.classifications[0].input.mentors.map(mentor => mentor.id).sort(), eligibleIds);
  for (const { id, metadata } of demoAgents) {
    const received = list.classifications[0].input.mentors.find(mentor => mentor.id === id);
    assert.equal(received.description, metadata.description);
    assert.equal(received.specialty, metadata.mentor.specialty);
  }
  assert.deepEqual(offers(list), []);

  const target = await app.send('莫非老师是做什么的？', { decision: decision('directory', { mentorIds: [mofei.id] }) });
  assert.equal(target.receipts[0].status, 'directory');
  assert.deepEqual(target.receipts[0].mentors.map(mentor => mentor.id), [mofei.id]);
  assert.deepEqual(offers(target), []);
});

test('clarification gives the main model eligible options without a card or pending invitation', async t => {
  const text = '我想找人陪我试试，还没想好是观察昆虫、做个实验，还是练投篮。';
  const reply = '认昆虫可以问小林，做实验可以问莫非，练投篮可以找山冈。你眼下想先试哪一个？';
  const app = await demo();

  await t.test('selected options preserve order and exclude duplicates and the current mentor', async () => {
    const turn = await app.send(text, { reply, decision: decision('clarify', {
      mentorIds: [xiaolin.id, currentMentor.id, xiaolin.id, mofei.id, shangang.id], replyHint: '问用户更想先尝试哪个方向',
    }) });
    const instruction = turn.receipts[0];
    assert.equal(instruction.status, 'clarify');
    assert.ok(instruction.replyInstruction?.trim());
    assert.deepEqual(instruction.mentors, [xiaolin, mofei, shangang].map(({ id, name, metadata }) => ({
      id, name, specialty: metadata.mentor.specialty, description: metadata.description,
      ...(metadata.card?.portrait ? { avatarUrl: metadata.card.portrait } : {}),
    })));
    assert.deepEqual(parts(turn), [reply]);
    assert.deepEqual(offers(turn), []);
    assert.equal(turn.context.mentorInvitation, undefined);
  });

  await t.test('an unspecified destination may return an empty option list', async () => {
    const turn = await app.send('我想换个导师。', { reply: '你想先聊哪件事？', decision: decision('clarify') });
    assert.equal(turn.receipts[0].status, 'clarify');
    assert.deepEqual(turn.receipts[0].mentors, []);
    assert.deepEqual(offers(turn), []);
    assert.equal(turn.context.mentorInvitation, undefined);
  });

  await t.test('an unknown ID rejects the whole decision', async () => {
    const turn = await app.send(text, { decision: decision('clarify', { mentorIds: [xiaolin.id, 'missing-mentor'] }) });
    assert.equal(turn.receipts[0].status, 'unavailable');
    assert.equal(turn.receipts[0].mentors, undefined);
    assert.deepEqual(offers(turn), []);
    assert.equal(turn.context.mentorInvitation, undefined);
  });
});

test('an existing demo imports new mentors and refreshes stock specialty without losing its chats', async () => {
  const oldXiaolin = {
    id: xiaolin.id, name: xiaolin.name, version: 'mentor-demo-v1',
    definition: '你是好奇学院的小鹿小林，负责生命与生物。你留心孩子看到的小细节，善于用简单的比较说明生物知识。先接住眼前的问题，一次带孩子观察一件事。',
    metadata: { description: '陪你认动植物、观察昆虫、设计自然观察记录。',
      mentor: { specialty: '生命与生物' }, card: { specialties: ['生命与生物'] } },
  };
  const oldWorkspace = await demo({ agents: [oldXiaolin] });
  const previous = await oldWorkspace.send('蜜蜂为什么要采蜜？', { agentId: oldXiaolin.id });

  const workspace = createBrowserWorkspace({ defaultAgents: demoAgents, defaultChildren: demoChildren,
    model: { configured: false }, memoryModel: { configured: false } });
  const upgraded = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: previous.snapshot });
  assert.equal(upgraded.value.agents.length, 12);
  const updated = upgraded.value.agents.find(mentor => mentor.id === xiaolin.id);
  assert.equal(updated.definition, xiaolin.definition);
  assert.equal(updated.description, xiaolin.metadata.description);
  assert.deepEqual(updated.card.specialties, [xiaolin.metadata.mentor.specialty]);
  assert.deepEqual(upgraded.snapshot.tables.sessions, previous.snapshot.tables.sessions);
  assert.deepEqual(upgraded.snapshot.tables.messages, previous.snapshot.tables.messages);
  assert.deepEqual(upgraded.snapshot.tables.children, previous.snapshot.tables.children);
  const repeated = await workspace.execute({ method: 'GET', path: '/api/state', snapshot: upgraded.snapshot });
  assert.deepEqual(repeated.snapshot.tables.agents, upgraded.snapshot.tables.agents);
});

test('a delivered invitation follows the helpful reply and may be accepted in the next turn', async () => {
  const app = await demo();
  const invite = await app.send(project, { decision: invitation(), reply: projectAnswer });
  const receipt = invite.receipts[0];
  assert.equal(receipt.status, 'invite');
  assert.equal(receipt.autoFollowUp, true);
  assert.equal(receipt.question, undefined);
  assert.deepEqual(offers(invite), []);
  const displayed = invite.context.mentorInvitation;
  const recordedInvite = invite.context.toolCalls.find(call => call.name === 'find_mentor').result;
  const inviteEntry = recorded(invite);
  assert.equal(inviteEntry.action, 'invite');
  assert.equal(inviteEntry.mentorId, xiaolin.id);
  assert.ok(recordedInvite.question);
  assert.match(recordedInvite.question, /区分不同路线，做一份对照记录/);
  assert.equal(displayed.question, recordedInvite.question);
  assert.equal(displayed.mentorId, xiaolin.id);
  assert.equal(displayed.assistantId, invite.messages.at(-1).id);
  assert.ok(parts(invite).indexOf(projectAnswer) >= 0);
  assert.ok(parts(invite).indexOf(recordedInvite.question) > parts(invite).indexOf(projectAnswer));
  assert.equal(parts(invite).filter(text => text === recordedInvite.question).length, 1);

  const accept = await app.send('好呀', { decision: accepted() });
  assert.equal(accept.sessionId, invite.sessionId);
  assert.equal(accept.outerRequests.length, 1);
  assert.equal(accept.outerRequests[0].toolChoice, undefined);
  assert.deepEqual(accept.context.toolCalls.map(({ name, source }) => [name, source]), [['find_mentor', 'turn_check']]);
  assert.deepEqual(accept.classifications[0].input.previousInvitation, displayed);
  assert.deepEqual(historyFor(accept), [{ id: invite.run.id, turnsSince: 0, ...inviteEntry }]);
  assert.deepEqual(offers(accept).map(event => event.mentor.id), [xiaolin.id]);
  assert.equal(recorded(accept).basis, 'accepted_invitation');
});

test('generic acceptance cannot reuse an unshown, stale or different mentor invitation', async t => {
  await t.test('tool return did not result in visible invitation', async () => {
    const app = await demo();
    const invite = await app.send(project, { decision: invitation(), reply: projectAnswer, failContinuation: true });
    assert.equal(invite.receipts[0].status, 'invite');
    assert.ok(!invite.context.mentorInvitation);
    assert.ok(!parts(invite).includes(invite.context.toolCalls[0].result.question));
    assert.deepEqual(offers(invite), []);

    const accept = await app.send('好呀', { decision: accepted() });
    assert.equal(accept.classifications[0].input.previousInvitation, null);
    assert.equal(accept.receipts[0].status, 'unavailable');
    assert.deepEqual(offers(accept), []);
  });
  await t.test('an intervening reply supersedes the invitation', async () => {
    const app = await demo();
    const invite = await app.send(project, { decision: invitation(), reply: projectAnswer });
    await app.send('先不聊蚂蚁了，你继续讲蜂蜜吧。');
    const accept = await app.send('好呀', { decision: accepted() });
    assert.equal(accept.sessionId, invite.sessionId);
    assert.equal(accept.classifications[0].input.previousInvitation, null);
    assert.equal(accept.receipts[0].status, 'unavailable');
    assert.deepEqual(offers(accept), []);
  });
  await t.test('another source conversation has no previous invitation', async () => {
    const app = await demo();
    const invite = await app.send(project, { decision: invitation(), reply: projectAnswer });
    const accept = await app.send('好呀', { agentId: mofei.id, decision: accepted() });
    assert.notEqual(accept.sessionId, invite.sessionId);
    assert.equal(accept.classifications[0].input.previousInvitation, null);
    assert.equal(accept.receipts[0].status, 'unavailable');
    assert.deepEqual(offers(accept), []);
  });
  await t.test('the decision cannot substitute a different destination', async () => {
    const app = await demo();
    await app.send(project, { decision: invitation(), reply: projectAnswer });
    const accept = await app.send('好呀', { decision: accepted(mofei.id) });
    assert.equal(accept.classifications[0].input.previousInvitation.mentorId, xiaolin.id);
    assert.equal(accept.receipts[0].status, 'unavailable');
    assert.deepEqual(offers(accept), []);
  });
  await t.test('referring to a mentor from a directory reply does not accept an invitation', async () => {
    const app = await demo();
    await app.send('谁擅长设计物理实验？', {
      decision: decision('directory', { mentorIds: [mofei.id] }), reply: '鼹鼠莫非擅长物理小实验。',
    });
    const accept = await app.send('就找你提的那位。', {
      decision: decision('offer', {
        mentorIds: [mofei.id], evidence: '找你提的那位', basis: 'accepted_invitation',
      }),
    });
    assert.equal(accept.classifications[0].input.previousInvitation, null);
    assert.equal(accept.receipts[0].status, 'unavailable');
    assert.deepEqual(offers(accept), []);
  });
});

test('invalid classification results fail safely and neutral decisions remain card-free', async t => {
  const cases = [
    { label: 'malformed JSON', raw: 'not JSON' },
    { label: 'classifier transport failure', raw: new Error('classifier failed') },
    { label: 'unrecognized status', raw: decision('invented') },
    { label: 'out-of-roster ID', raw: decision('offer', { mentorIds: ['missing-mentor'], evidence: '帮我找一位导师', basis: 'explicit_request' }) },
    { label: 'current mentor is already active', raw: decision('offer', { mentorIds: [currentMentor.id], evidence: '帮我找一位导师', basis: 'explicit_request' }) },
    { label: 'unrecognized offer basis', raw: decision('offer', { mentorIds: [xiaolin.id], basis: 'unknown' }) },
    { label: 'missing invitation display text', raw: decision('invite', { mentorIds: [xiaolin.id] }) },
    { label: 'unavailable result', raw: decision('unavailable') },
    { label: 'clarification result', raw: decision('clarify', { replyHint: '问用户想解决哪个问题' }), expected: 'clarify' },
  ];
  for (const { label, raw, expected = 'unavailable' } of cases) {
    await t.test(label, async () => {
      const app = await demo();
      const turn = await app.send('帮我找一位导师。', { decision: raw });
      assert.equal(turn.classifications.length, 1);
      assert.equal(turn.receipts[0].status, expected);
      assert.deepEqual(offers(turn), []);
    });
  }
  await t.test('the model receives the prior reply and chooses whether to clarify a reference', async () => {
    const app = await demo();
    const text = '行，就找你说的那位吧。';
    const clarify = ({ previousTurns }) => {
      assert.equal(previousTurns.at(-1).text, '先固定桥墩的距离。');
      return decision('clarify', { reason: '前一条没有说到具体人选。' });
    };
    await app.send('纸桥怎么做？', { reply: '先固定桥墩的距离。' });
    const ambiguous = await app.send(text, { decision: clarify });
    assert.equal(ambiguous.receipts[0].status, 'clarify');
    assert.deepEqual(offers(ambiguous), []);
    await app.send('谁擅长设计物理实验？', {
      decision: decision('directory', { mentorIds: [mofei.id] }), reply: '鼹鼠莫非擅长物理小实验。',
    });
    const grounded = await app.send(text, { decision: ({ previousTurns }) => {
      assert.equal(previousTurns.at(-1).text, '鼹鼠莫非擅长物理小实验。');
      return decision('offer', { mentorIds: [mofei.id], basis: 'explicit_request' });
    } });
    assert.deepEqual(offers(grounded).map(event => event.mentor.id), [mofei.id]);
  });
});

test('a model-selected offer remains valid when its decision omits the optional category', async () => {
  const app = await demo();
  const text = '银行利息是怎么来的？';
  const reason = '孩子想弄懂银行利息，利利能用少量零花钱讲清来由。';
  const turn = await app.send(text, { triggerReason: 'outside_specialty', decision: decision('offer', {
    mentorIds: [lili.id], basis: 'proactive_specialty', reason,
  }) });
  assert.equal(turn.receipts[0].status, 'offer');
  assert.equal(turn.receipts[0].reason, reason);
  assert.deepEqual(offers(turn).map(event => event.mentor.id), [lili.id]);
  assert.ok(recorded(turn).categoryId == null);
});
