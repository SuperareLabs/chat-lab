import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { demoAgents, demoChildren } from '../config/mentor-demo.mjs';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';
import { MENTOR_DECISION_PROMPT } from '../lib/mentor-recommendation.mjs';
import { loadSharedPrompts } from '../lib/shared-prompts.mjs';

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
  categoryId } = {}) =>
  ({ status, mentorIds, evidence, basis, reason, replyHint,
    ...(categoryId ? { categoryId } : {}),
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
const triggerUsageFor = turn => turn.snapshot.tables.usage_records
  .filter(row => row.run_id === turn.run.id && row.kind === 'mentor_trigger')
  .map(row => JSON.parse(row.entry));

async function demo({ agents = demoAgents } = {}) {
  let turn;
  const workspace = createBrowserWorkspace({
    defaultAgents: agents, defaultChildren: demoChildren, sharedPrompts: loadSharedPrompts(),
    model: { name: 'test', configured: true }, memoryModel: { configured: false },
    mentorTrigger: { model: 'test-trigger', async decide(input, { signal }) {
      assert.equal(signal.aborted, false);
      turn.triggerRequests.push(input);
      if (turn.trigger instanceof Error) throw turn.trigger;
      const choice = typeof turn.trigger === 'function' ? turn.trigger(input) : turn.trigger;
      return { decisions: { find_mentor: { choice, reason: turn.triggerReason } },
        receipt: { model: 'test-trigger', usage: { input_tokens: 100, output_tokens: 0 } } };
    } },
    provider: { async chat({ messages, tools, toolChoice }) {
      if (messages[0].content.startsWith('【导师工具内部判定】')) {
        const input = JSON.parse(messages.at(-1).content);
        turn.classifications.push({ system: messages[0].content, input, tools });
        if (turn.decision instanceof Error) throw turn.decision;
        const result = typeof turn.decision === 'function' ? turn.decision(input) : turn.decision;
        return response(typeof result === 'string' ? result : JSON.stringify(result));
      }
      const last = messages.at(-1);
      turn.outerRequests.push({ system: messages[0].content, tools: structuredClone(tools), toolChoice,
        previous: messages.at(-2), last });
      if (last.role === 'tool') {
        turn.receipts = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
        turn.offersBeforeContinuation ??= offers(turn).length;
      }
      if (turn.nativeTool && !messages.some(message => message.role === 'tool' && message.tool_call_id === turn.nativeTool.id)) {
        return response('', [turn.nativeTool], 'tool_calls');
      }
      const replyParts = Array.isArray(turn.reply) ? turn.reply : [turn.reply];
      return response(JSON.stringify({ messages: replyParts }), [], turn.failContinuation ? 'length' : 'stop');
    } },
  });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const childId = boot.value.children[0].id;
  let snapshot = boot.snapshot;
  const sessions = new Map();

  return {
    async send(text, options = {}) {
      const { agentId = currentMentor.id, reply = naturalAnswer, nativeTool, failContinuation = false,
        trigger = 'call', triggerReason = 'mentor_intent', requestId = crypto.randomUUID() } = options;
      const scope = { childId, agentId };
      turn = { reply, nativeTool, failContinuation, trigger, triggerReason, decision: options.decision ?? decision('stay'),
        events: [], triggerRequests: [], outerRequests: [], classifications: [], receipts: [] };
      const result = await workspace.execute({
        method: 'POST', path: '/api/chat', scope, snapshot,
        body: { ...scope, text, sessionId: sessions.get(agentId), requestId },
      }, { emit: event => turn.events.push(event) });
      const start = turn.events.find(event => event.type === 'start');
      assert.ok(start, result.value?.error);
      const terminal = turn.events.find(event => event.type === 'done' || event.type === 'error');
      assert.equal(terminal?.type, failContinuation ? 'error' : 'done', terminal?.message);
      snapshot = result.snapshot;
      sessions.set(agentId, start.sessionId);
      const saved = result.views[`/api/sessions/${start.sessionId}?${new URLSearchParams(scope)}`];
      const run = snapshot.tables.runs.find(row => row.request_id === requestId);
      assert.ok(run);
      return { ...turn, sessionId: start.sessionId, context: saved.context, messages: saved.messages, snapshot, run };
    },
    async newSession(agentId = currentMentor.id) {
      const scope = { childId, agentId };
      const result = await workspace.execute({ method: 'POST', path: '/api/sessions', scope, snapshot, body: scope });
      assert.equal(result.status, 201, result.value?.error);
      snapshot = result.snapshot;
      sessions.set(agentId, result.value.session.id);
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

test('the trigger receives the current specialty and only a call reaches the inner mentor decision', async () => {
  const app = await demo();
  const text = '银行利息是怎么来的？';
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
  assert.deepEqual(Object.keys(questions), ['find_mentor']);
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
  assert.equal(turn.offersBeforeContinuation, 1);
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
  assert.deepEqual(entry, { action: 'offer', basis: 'proactive_specialty', mentorId: duoluo.id,
    categoryId: 'english-speaking', at: entry.at, reason });

  await app.send('蜜蜂把花蜜带去哪里？');
  await app.send('那为什么要存起来？');
  const repeatedReply = '可以开口说：Excuse me, where is the library?';
  const stayReason = '虽然换了场景，孩子还是在练英语口语，多罗已经推荐过。';
  const repeated = await app.send('再换个场景，我想练用英语问去图书馆的路。', { reply: repeatedReply,
    decision: ({ recommendationHistory }) => recommendationHistory.some(record => record.categoryId === 'english-speaking')
      ? decision('stay', { reason: stayReason }) : proactive(duoluo, repeatedReply, 'english-speaking') });
  assert.deepEqual(historyFor(repeated), [{ id: first.run.id, turnsSince: 2, ...entry }]);
  assert.equal(repeated.receipts[0].status, 'stay');
  assert.equal(repeated.receipts[0].reason, stayReason);
  assert.deepEqual(parts(repeated), [repeatedReply]);
  assert.deepEqual(offers(repeated), []);
  assert.equal(repeated.context.mentorInvitation, undefined);
  assert.equal(recorded(repeated), null);

  const newSession = await app.newSession();
  const fresh = await app.send(englishPractice, { reply,
    decision: proactive(duoluo, '练习用英语在咖啡店点餐', 'english-speaking') });
  assert.equal(fresh.sessionId, newSession);
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.deepEqual(historyFor(fresh), []);
  assert.deepEqual(offers(fresh).map(event => event.mentor.id), [duoluo.id]);
});

test('the model receives successful-turn counts and can decide when a new topic is ready for a card', async () => {
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
  const stayReason = '才刚推荐过一次，先让孩子试试。';
  const whenReady = ({ recommendationHistory }) => recommendationHistory[0].turnsSince < 2
    ? decision('stay', { reason: stayReason }) : sports;
  const early = await app.send(sportsPractice, { decision: whenReady, reply: sportsReply });
  assert.equal(historyFor(early)[0].id, first.run.id);
  assert.equal(historyFor(early)[0].turnsSince, 1);
  assert.equal(early.receipts[0].status, 'stay');
  assert.equal(early.receipts[0].reason, stayReason);
  assert.deepEqual(parts(early), [sportsReply]);
  assert.deepEqual(offers(early), []);
  assert.equal(early.context.mentorInvitation, undefined);
  assert.equal(recorded(early), null);

  const ready = await app.send('我想接着练短跑起跑的动作，总觉得后脚慢半拍。', { decision: whenReady, reply: sportsReply });
  assert.equal(historyFor(ready)[0].turnsSince, 2);
  assert.equal(ready.receipts[0].status, 'offer');
  assert.deepEqual(offers(ready).map(event => event.mentor.id), [shangang.id]);

  const requested = await app.send('那就帮我找山冈继续练起跑。', { decision: decision('offer', {
    mentorIds: [shangang.id], evidence: '帮我找山冈', basis: 'explicit_request', categoryId: 'sports-technique',
  }), reply: '山冈能陪你把预备姿势和第一步分开练。' });
  assert.deepEqual(historyFor(requested).map(({ id, turnsSince }) => [id, turnsSince]), [[ready.run.id, 0], [first.run.id, 3]]);
  assert.equal(requested.receipts[0].status, 'offer');
  assert.equal(requested.offersBeforeContinuation, 1);
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

test('the backend preserves an offer from the model even with the same category and a recent card', async () => {
  const app = await demo();
  const first = await app.send(englishPractice, { decision: proactive(duoluo, englishPractice, 'english-speaking') });
  const reply = '可以先说：Excuse me, where is the station?';
  const turn = await app.send('我想换个场景练口语，模拟问路。', {
    reply, triggerReason: 'outside_specialty',
    decision: proactive(duoluo, '模拟问路', 'english-speaking'),
  });
  assert.deepEqual(historyFor(turn), [{ id: first.run.id, turnsSince: 0, ...recorded(first) }]);
  assert.equal(turn.receipts[0].status, 'offer');
  assert.equal(turn.offersBeforeContinuation, 0);
  assert.deepEqual(offers(turn).map(event => event.mentor.id), [duoluo.id]);
  assert.equal(recorded(turn).categoryId, 'english-speaking');

  const followup = await app.send('我先把刚才那句话读一遍。');
  assert.deepEqual(historyFor(followup), [
    { id: turn.run.id, turnsSince: 0, ...recorded(turn) },
    { id: first.run.id, turnsSince: 1, ...recorded(first) },
  ]);
});

test('explicit requests by capability can offer a card after an unrelated refusal and during cooldown', async () => {
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

test('a failed continuation records only the explicit card that was already displayed', async () => {
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
  assert.equal(visible.offersBeforeContinuation, 1);
  assert.deepEqual(offers(visible).map(event => event.mentor.id), [duoluo.id]);
  assert.equal(recorded(visible).basis, 'explicit_request');

  const next = await app.send(sportsPractice, {
    decision: decision('stay'), reply: '先从一次轻蹬地的小练习开始。',
  });
  assert.deepEqual(historyFor(next).map(({ id, turnsSince }) => [id, turnsSince]), [[visible.run.id, 0]]);
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
