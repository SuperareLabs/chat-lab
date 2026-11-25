import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserWorkspace } from '../lib/browser-workspace.mjs';
import { createToolDecision } from '../lib/tool-decision.mjs';

test('Jev sees five local turns and tools above the threshold keep their ordinary call flow', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chatlab-decision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'local-token');
  await writeFile(tokenFile, 'local-test-token', { mode: 0o600 });
  const model = '~typesafe/jev-latest';
  const path = '/api/alpha/decisions';
  const trace = [];
  const requests = [];
  let providerAvailable = true;
  const toolDecision = createToolDecision({ tokenFile, async fetcher(url, options) {
    if (url.startsWith('http://127.0.0.1:47391/')) {
      assert.match(url, /openrouter-jev-latest\/connection$/);
      assert.equal(options.headers['X-Service-Clan-Token'], 'local-test-token');
      return Response.json({ model, base_url: 'https://openrouter.ai', endpoints: [{ method: 'POST', path }],
        headers: { Authorization: 'Bearer provider-test-token' } });
    }
    assert.equal(url, 'https://openrouter.ai' + path);
    assert.equal(options.headers.Authorization, 'Bearer provider-test-token');
    assert.equal(options.headers['X-Service-Clan-Token'], undefined);
    const body = JSON.parse(options.body);
    requests.push(body);
    trace.push('jev');
    await Promise.resolve();
    if (!providerAvailable) return new Response(null, { status: 503 });
    const answers = Object.fromEntries(Object.keys(body.questions).map(name => [name, { noul: name === 'any_tool' ? 0.9 : name === 'calculate' ? 0.8 : 0.02 }]));
    return Response.json({ model: 'typesafe/jev-test-version', answers });
  } });
  const agentId = 'decision-test';
  const workspace = createBrowserWorkspace({
    toolDecision, defaultAgents: [{ id: agentId, name: '测试角色', definition: '仅主模型使用的角色设定。', metadata: {} }],
    defaultChildren: [{ name: '仅本机使用的资料', age: 22, interests: [] }],
    model: { name: 'reply-test', configured: true }, memoryModel: { configured: false },
    provider: { async chat({ messages, tools }) {
      trace.push('reply');
      assert(tools.some(tool => tool.function.name === 'calculate'));
      if (messages.at(-1)?.content.endsWith('算一下 2+3')) return { content: '', toolCalls: [
        { id: 'calculate-1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+3"}' } },
      ] };
      return { content: '收到。', toolCalls: [] };
    } },
  });
  const initial = await workspace.execute({ method: 'GET', path: '/api/state' });
  let snapshot = initial.snapshot;
  const scope = { childId: initial.value.children[0].id, agentId };
  async function send(texts) {
    const events = [];
    const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot, scope,
      body: { ...scope, messages: texts.map(text => ({ text })), requestId: crypto.randomUUID() } },
    { emit(event) {
      events.push(event);
      if (event.type === 'tool_decision') trace.push(event.decision.status);
    } });
    assert.equal(result.status, 200);
    snapshot = result.snapshot;
    const session = snapshot.tables.sessions.find(row => row.status === 'open');
    return { events, context: JSON.parse(session.context) };
  }
  for (let turn = 1; turn <= 5; turn++) await send([`第 ${turn} 轮`]);
  trace.length = 0;
  const { context, events } = await send(['最后一轮的第一条消息', '算一下 2+3']);
  assert.deepEqual(trace, ['running', 'jev', 'succeeded', 'reply', 'reply']);
  assert.deepEqual(requests.at(-1).state.conversation.map(turn => turn.map(message => message.text)), [
    ['第 2 轮', '收到。'], ['第 3 轮', '收到。'], ['第 4 轮', '收到。'], ['第 5 轮', '收到。'],
    ['最后一轮的第一条消息', '算一下 2+3'],
  ]);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /仅本机使用的资料|仅主模型|test-token|userId|sessionId/);
  assert.equal(context.toolDecision.anyToolProbability, 0.9);
  assert.equal(context.toolDecision.selectedTool, 'calculate');
  assert(context.toolDecision.probabilities.some(item => item.name === 'calculate' && item.probability === 0.8));
  assert.deepEqual(events.find(event => event.decision?.status === 'succeeded').decision, context.toolDecision);
  assert.equal(context.toolCalls[0].name, 'calculate');

  providerAvailable = false;
  trace.length = 0;
  const failed = await send(['你好']);
  assert.deepEqual(trace, ['running', 'jev', 'unavailable', 'reply']);
  assert.equal(failed.context.toolDecision.httpStatus, 503);
  assert(failed.events.some(event => event.type === 'done'));
});

test('an unready Jev relay immediately skips credential and provider requests', async () => {
  const decision = createToolDecision({ tokenFile: '/missing-local-token',
    fetcher() { assert.fail('should not fetch without the configured relay'); },
    relay: {
      available: () => false,
      request() { assert.fail('should not wait for the SSH process to connect'); },
    },
  });
  const result = await decision.evaluate({
    history: [{ id: 'message', role: 'user', text: '你好' }], turnStarts: ['message'],
    tools: [{ function: { name: 'calculate', description: '计算' } }], signal: new AbortController().signal,
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.route, 'chengdu-singapore');
  assert.equal(result.reason, 'relay');
});

test('media above 65% supplies this turn’s delivery status and the scene before the reply', async () => {
  const trace = [];
  const agentId = 'scripted-media-test';
  const scene = 'steel countertop near the kitchen window, a gentle spoon clink';
  const motion = 'gently pressing a lemon pudding with a spoon';
  const photoScene = 'a lemon pudding on a steel countertop';
  const environment = 'a warm kitchen with afternoon window light';
  const toolName = kind => kind === 'photo' ? 'share_photo' : 'share_video';
  const privateLine = '大家看这杯奶冻';
  let plannedKind;
  let activeCase;
  const workspace = createBrowserWorkspace({
    defaultAgents: [{ id: agentId, name: '测试角色', definition: '在厨房里做奶冻。', metadata: {} }],
    defaultChildren: [{ name: '测试访客', age: 22, interests: [] }],
    model: { name: 'route-test', configured: true }, memoryModel: { configured: false },
    toolDecision: { async evaluate({ tools }) {
      trace.push('decision');
      return { status: 'succeeded', anyToolProbability: activeCase.probability, probabilities: tools.map(({ function: { name } }) => ({
        name, probability: name === toolName(activeCase.kind) ? 0.95 : 0.01,
      })) };
    } },
    provider: { async chat({ messages, tools }) {
      assert.deepEqual(tools, []);
      if (messages[0].content.includes('参考图判断】')) {
        trace.push('reference decision');
        assert.deepEqual(JSON.parse(messages[1].content).photoReferences.map(photo => photo.id), ['photo-1', 'photo-2']);
        const references = activeCase.useReference ? [{ id: 'photo-2', keep: 'the steel countertop' }] : [];
        const decision = { needs_reference_image: Boolean(references.length), references };
        const output = activeCase.useReference ? { type: 'json_object', content: decision } : decision;
        return { content: JSON.stringify(output), toolCalls: [] };
      }
      if (messages[0].content.includes('【Share Video】') || messages[0].content.includes('【Share Photo】')) {
        trace.push('plan');
        const input = JSON.parse(messages[1].content);
        assert.equal(input.tool.name, toolName(activeCase.kind));
        assert.equal(input.conversation.at(-1).at(-1).text, activeCase.text);
        plannedKind = activeCase.kind;
        if (activeCase.invalid) return { content: '{"messages":["我给你发啦。"]}', toolCalls: [] };
        assert.deepEqual(input.selectedReferenceImages.map(photo => photo.id), activeCase.useReference ? ['photo-2'] : []);
        const args = plannedKind === 'video' ? { should_send_video: true, template_id: 'VID_POV_INTERACT', environment_and_sound: scene,
          primary_subject: { asset_id: activeCase.useReference ? 'photo-2' : null, action_or_state: motion }, spoken_line: privateLine }
          : { should_send_image: true, template_id: 'SHOT_POV_SUBJECT', environment_context: environment,
            primary_subject: { asset_id: activeCase.useReference ? 'photo-2' : null, action_or_state: photoScene } };
        let output = args;
        if (activeCase.useReference) output = { type: 'json_object', content: JSON.stringify(args) };
        else if (plannedKind === 'photo') output = { tool: { name: 'share_photo', parameters: args } };
        return { content: JSON.stringify(output), toolCalls: [] };
      }
      trace.push('reply');
      const supplied = messages[1].content.split('\n\n【本轮角色影像结果】\n')[1];
      if (activeCase.probability <= 0.65) assert.equal(supplied, undefined);
      else if (activeCase.invalid) {
        assert.deepEqual(JSON.parse(supplied), { media: activeCase.kind, sent: false, description: null });
        assert(messages[0].content.includes('description 只代表拍摄计划'));
      }
      else {
        assert.deepEqual(JSON.parse(supplied), { media: activeCase.kind, sent: true,
          description: activeCase.kind === 'video' ? { scene, motion } : { scene: `${photoScene}, ${environment}` } });
        assert(messages[0].content.includes('sent 为 true 表示附件已发出'));
        assert(!JSON.stringify(messages).includes('VENDOR_PRIVATE_PROMPT'));
        assert(!JSON.stringify(messages).includes(privateLine));
        if (activeCase.useReference) {
          return { content: '{"messages":["不发了","我真有点恼了"]}', toolCalls: [] };
        }
      }
      return { content: '{"messages":["这是今天做的奶冻。","加了一点柠檬。"]}', toolCalls: [] };
    } },
    characterMedia: { available: () => true, async photoReferences() {
      return !activeCase.invalid ? [{ id: 'photo-1', assetId: 'old-unrelated', scene: 'a bicycle' },
        { id: 'photo-2', assetId: 'old-countertop', scene: 'a steel countertop' }] : [];
    }, async generate(kind, args) {
      trace.push('generate');
      assert.equal(kind, plannedKind);
      assert.equal(args.scene, kind === 'video' ? scene : `${photoScene}, ${environment}`);
      if (kind === 'video') assert.equal(args.videoPlan.spokenLine, privateLine);
      assert.deepEqual(args.references, activeCase.useReference ? [{ assetId: 'old-countertop', keep: 'the steel countertop' }] : []);
      args.onPrompt('VENDOR_PRIVATE_PROMPT');
      return { ok: true, attachment: { id: 'a'.repeat(48), kind } };
    } },
  });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  let snapshot = boot.snapshot;
  const scope = { childId: boot.value.children[0].id, agentId };
  async function send(body) {
    const events = [];
    const result = await workspace.execute({ method: 'POST', path: '/api/chat', snapshot, scope, body },
      { emit(event) {
        events.push(event);
        if (['media_generation_prompt', 'character_media', 'reply_part'].includes(event.type)) trace.push(event.type);
      } });
    assert(events.some(event => event.type === 'done'));
    snapshot = result.snapshot;
    return events;
  }
  for (const [kind, useReference] of [['video', true], ['video', false], ['photo', true], ['photo', false]]) {
    trace.length = 0;
    activeCase = { kind, useReference, probability: 0.66, text: `发一份 ${kind} 给我看看` };
    const body = { ...scope, text: activeCase.text, requestId: crypto.randomUUID() };
    const events = await send(body);
    assert.deepEqual(trace, ['decision', 'reference decision', 'plan', 'generate', 'media_generation_prompt', 'character_media',
      'reply', 'reply_part', 'reply_part']);
    const decision = events.find(event => event.decision?.status === 'succeeded').decision;
    assert.equal(decision.mode, 'media');
    assert.equal(decision.selectedTool, toolName(kind));
    const id = events[0].sessionId;
    const read = await workspace.execute({ method: 'GET', path: `/api/sessions/${id}?${new URLSearchParams(scope)}`, snapshot, scope });
    const prompt = { tool: toolName(kind), text: 'VENDOR_PRIVATE_PROMPT' };
    assert.deepEqual(events.find(event => event.type === 'media_generation_prompt').prompt, prompt);
    assert.deepEqual(read.value.context.mediaGenerationPrompt, prompt);
    assert.equal(read.value.messages.at(-1).attachmentAfterParts, 0);
    assert.deepEqual(read.value.messages.at(-1).parts, useReference ? ['不发了', '我真有点恼了'] : ['这是今天做的奶冻。', '加了一点柠檬。']);
    trace.length = 0;
    await send(body);
    assert.deepEqual(trace, ['character_media', 'reply_part', 'reply_part']);
  }
  trace.length = 0;
  activeCase = { kind: 'video', probability: 0.65, text: '这个请求刚好达到门槛' };
  const low = await send({ ...scope, text: activeCase.text, requestId: crypto.randomUUID() });
  assert.equal(low.find(event => event.decision?.status === 'succeeded').decision.mode, 'reply');
  assert.deepEqual(trace, ['decision', 'reply', 'reply_part', 'reply_part']);

  for (const kind of ['video', 'photo']) {
    trace.length = 0;
    activeCase = { kind, probability: 0.9, invalid: true, text: '测试参数不合格时的回复' };
    await send({ ...scope, text: activeCase.text, requestId: crypto.randomUUID() });
    assert.deepEqual(trace, ['decision', 'plan', 'plan', 'reply', 'reply_part', 'reply_part']);
  }
});

test('a scripted flower photo can repair its plan once before submitting it for generation', async t => {
  const text = '院子里的粉色蔷薇开了，拍一张花给我看看，只拍花。';
  const good = { should_send_image: true, template_id: 'SHOT_POV_SUBJECT',
    primary_subject: { asset_id: null, action_or_state: 'pink roses in bloom' }, environment_context: 'a sunlit courtyard' };
  const badSubject = { ...good, primary_subject: { asset_id: 'character', action_or_state: 'holding pink roses' },
    environment_context: '洒满阳光的院子' };
  const attachment = { kind: 'photo', id: 'd'.repeat(48) };
  const cases = [
    { name: 'empty plan repaired', plans: [{}, good], submissions: 1 },
    { name: 'structured English photo setting is normalized without another model call',
      plans: [{ ...good, environment_context: { setting: 'a sunlit courtyard', timezone: 'Asia/Shanghai', weather: 'soft daylight' } }],
      submissions: 1, expectedEnvironment: 'a sunlit courtyard, soft daylight' },
    { name: 'an explicit optional POV limb resolves to the current character', plans: [{ ...good,
      secondary_subject: { asset_id: null, framing_mode: 'partial_limb_only', action_or_state: 'one hand holding a magnifying glass' } }],
    submissions: 1 },
    { name: 'the POV template supplies an omitted optional limb framing', plans: [{ ...good,
      secondary_subject: { asset_id: null, action_or_state: 'a green-sleeved arm reaching into frame' } }], submissions: 1 },
    { name: 'matched action payload is recovered without exposing its chat text', plans: [{ response: {
      message: '照片马上发。', action: { name: 'share_photo', payload: good, confidence: 0.9 } }, videoNote: '视频下次再说' }], submissions: 1 },
    { name: 'invalid POV subject and environment repaired', plans: [badSubject, good], submissions: 1 },
    { name: 'second invalid plan stays undelivered', plans: [{}, badSubject], submissions: 0 },
    { name: 'explicitly declining the photo needs no repair', plans: [{ should_send_image: false }], submissions: 0 },
    { name: 'provider failure after a repair never resubmits the generation', plans: [{}, good], submissions: 1, providerFails: true },
  ];
  for (const { name, plans, submissions, providerFails, expectedEnvironment = good.environment_context } of cases) await t.test(name, async () => {
    const requests = [];
    const generations = [];
    const events = [];
    const agentId = 'flower-photo-test';
    const workspace = createBrowserWorkspace({
      defaultAgents: [{ id: agentId, name: '测试角色', definition: '喜欢花。', metadata: {} }],
      defaultChildren: [{ name: '测试访客', age: 22, interests: [] }],
      model: { name: 'photo-test', configured: true }, memoryModel: { configured: false },
      toolDecision: {}, mentorTrigger: { model: 'test-trigger', async decide() {
        return { decisions: { character_media: { choice: 'call' } }, toolDecision: { status: 'succeeded',
          anyToolProbability: 0.99, probabilities: [{ name: 'share_photo', probability: 0.98 }] } };
      } },
      provider: { async chat({ messages }) {
        if (messages[0].content.includes('【Share Photo】')) {
          requests.push(messages);
          return { content: JSON.stringify(plans[requests.length - 1]), toolCalls: [] };
        }
        return { content: JSON.stringify({ messages: ['粉色蔷薇开得真好。'] }), toolCalls: [] };
      } },
      characterMedia: { available: kind => kind === 'photo', async generate(kind, { photoPlan }) {
        generations.push({ kind, template: photoPlan.template.template_id, subject: photoPlan.primary, environment: photoPlan.environment });
        if (providerFails) return { ok: false, error: 'synthetic generation failure' };
        return { ok: true, attachment };
      } },
    });
    const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
    const scope = { childId: boot.value.children[0].id, agentId };
    const turn = await workspace.execute({ method: 'POST', path: '/api/chat', scope, snapshot: boot.snapshot,
      body: { ...scope, text, requestId: crypto.randomUUID() } }, { emit: event => events.push(event) });
    assert.equal(turn.status, 200);
    assert.ok(events.some(event => event.type === 'done'));
    assert.equal(requests.length, plans.length);
    for (const input of requests) assert.ok(input.some(message => message.content.includes(text)), 'keep the original flower request');
    const purposes = ['character-media-plan', 'character-media-plan-repair'].slice(0, plans.length);
    const context = JSON.parse(turn.snapshot.tables.sessions[0].context);
    assert.ok(!JSON.stringify(context.toolCalls).includes('照片马上发'));
    assert.deepEqual(context.modelRequests.map(request => request.purpose).filter(Boolean), purposes);
    const planCharges = turn.snapshot.tables.usage_records.filter(row => row.kind === 'chat' && row.record_key.includes(':character-media-plan'));
    assert.deepEqual(planCharges.map(row => row.record_key.split(':').at(-1)).sort(), purposes);
    assert.deepEqual(context.toolCalls.map(call => call.name), ['share_photo']);
    const attachments = events.filter(event => event.type === 'character_media').map(event => event.attachment);
    assert.deepEqual(attachments, submissions && !providerFails ? [attachment] : []);
    assert.equal(generations.length, submissions);
    if (submissions) {
      assert.equal(generations[0].kind, 'photo');
      assert.equal(generations[0].template, good.template_id);
      assert.equal(generations[0].subject.id, null);
      assert.equal(generations[0].subject.text, good.primary_subject.action_or_state);
      assert.equal(generations[0].environment, expectedEnvironment);
    }
  });
});

test('a failed video environment is rewritten on its own and keeps the requested clip length', async () => {
  const text = '拍一段三秒短视频，玻璃碗里木勺慢慢搅拌奶冻，不要对白。';
  const primary = { asset_id: null, action_or_state: 'creamy pudding slowly swirling in a glass bowl' };
  const badPlan = { should_send_video: true, template_id: 'VID_AMBIENT_LOOP', primary_subject: primary,
    environment_and_sound: { type: 'string', description: '木勺搅动时发出轻柔的声音。' }, duration_seconds: 3 };
  const environment = 'soft spoon clinks against glass in a quiet room';
  const attachment = { kind: 'video', id: 'b'.repeat(48) };
  const requests = [], generations = [], events = [];
  const agentId = 'video-environment-test';
  const workspace = createBrowserWorkspace({
    defaultAgents: [{ id: agentId, name: '测试角色', definition: '喜欢做饭。', metadata: {} }],
    defaultChildren: [{ name: '测试访客', age: 22, interests: [] }],
    model: { name: 'video-test', configured: true }, memoryModel: { configured: false },
    toolDecision: {}, mentorTrigger: { model: 'test-trigger', async decide() {
      return { decisions: { character_media: { choice: 'call' } }, toolDecision: { status: 'succeeded',
        anyToolProbability: 0.98, probabilities: [{ name: 'share_video', probability: 0.97 }] } };
    } },
    provider: { async chat({ messages }) {
      const instructions = messages[0].content;
      if (!instructions.includes('【Share Video】')) return { content: '{"messages":["木勺轻轻碰了下玻璃碗。"]}' };
      requests.push(messages);
      return { content: JSON.stringify(instructions.includes('【影像规划修正】')
        ? { environment_and_sound: environment } : badPlan) };
    } },
    characterMedia: { available: kind => kind === 'video', async generate(kind, { videoPlan }) {
      generations.push(videoPlan);
      assert.equal(kind, 'video');
      return { ok: true, attachment };
    } },
  });
  const boot = await workspace.execute({ method: 'GET', path: '/api/state' });
  const scope = { childId: boot.value.children[0].id, agentId };
  const turn = await workspace.execute({ method: 'POST', path: '/api/chat', scope, snapshot: boot.snapshot,
    body: { ...scope, text, requestId: crypto.randomUUID() } }, { emit: event => events.push(event) });
  assert.equal(turn.status, 200);
  assert.equal(requests.length, 2);
  assert.ok(requests[1][1].content.includes(text));
  assert.match(requests[1][0].content, /只返回 \{"environment_and_sound":/u);
  assert.equal(generations.length, 1);
  assert.equal(generations[0].primary.text, primary.action_or_state);
  assert.equal(generations[0].environment, environment);
  assert.equal(generations[0].duration, 3);
  assert.deepEqual(events.filter(event => event.type === 'character_media').map(event => event.attachment), [attachment]);
});
