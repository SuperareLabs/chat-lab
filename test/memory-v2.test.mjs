import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_FORMAT, memoryFormatFor, memoryMessages, memoryRequestFor, resolveMemoryOutput,
  validateMemoryOutput, validDate } from '../lib/memory.mjs';
import { COMMON_PROMPT, loadSouls, MEMORY_PROMPT, prepareMessages, renderSoul } from '../lib/prompts.mjs';

const source = [
  { id: 'u-first', role: 'user', text: '每周六上午我还是练大提琴。', createdAt: '2026-11-11T15:55:00Z' },
  { id: 'a', role: 'assistant', text: '还是那个时段。', createdAt: '2026-11-11T15:56:00Z' },
  { id: 'u-last', role: 'user', text: '对，刚才说的时段没变，还是周六上午。', createdAt: '2026-11-11T16:13:00Z' },
];
const context = {
  memoryIndex: [
    { id: 'm-cello', version: 2, state: 'active', kind: 'understanding', summary: '用户每周六上午练大提琴。', topics: ['大提琴'] },
    { id: 'm-tea', version: 1, state: 'archived', kind: 'understanding', summary: '用户喜欢浓缩咖啡。', topics: ['饮品'] },
    { id: 'm-event', version: 1, state: 'archived', kind: 'event', summary: '用户去年在南京城墙迷路。', topics: ['南京'] },
  ],
  overview: { summary: '用户每周六上午练大提琴，喜欢浓缩咖啡。', memoryIds: ['m-cello', 'm-tea'], version: 2 },
  revision: 9,
};
const empty = () => ({ creates: [], updates: [], mentions: [], retractions: [], overview: null });
const evidence = (anchorMessageId = 'u-last', sourceMessageIds = [anchorMessageId]) => ({ anchorMessageId, sourceMessageIds });
const wireEvidence = (sourceMessageIds = ['U2']) => ({ sourceMessageIds });
const validate = (plan, ctx = context, messages = source) => validateMemoryOutput(JSON.stringify(plan), messages, 'Asia/Shanghai', ctx);

test('V2 schema and prompt expose four operations plus same-call source-backed overview', () => {
  assert.equal(MEMORY_FORMAT.json_schema.name, 'general_chat_memory_v2');
  assert.deepEqual(MEMORY_FORMAT.json_schema.schema.required, ['creates', 'updates', 'mentions', 'retractions', 'overview']);
  assert.match(MEMORY_PROMPT, /createIndexes/);
  assert.match(MEMORY_PROMPT, /用户概括从 understanding/);
  assert.match(MEMORY_PROMPT, /不因活跃记忆已满而停止提取/);
  assert.match(MEMORY_PROMPT, /后台注入、工具检索、读取详情/);
});

test('summary/detail policy keeps the existing V2 protocol and preserves unchanged update summaries', () => {
  const section = MEMORY_PROMPT.split('【摘要与详情】')[1].split('【用户概括】')[0];
  assert.match(section, /用一句话识别/);
  assert.match(section, /当前状态/);
  assert.match(section, /用户不吃香菜。.*无需 detail/u);
  assert.match(section, /detail.notes 保留“想和国外同事交流；听力和口语比较吃力”/);
  assert.match(section, /"plannedAt":"2026-12-15","place":"苏州"/);
  assert.match(section, /尚未确认这些事实已在详情中保留时，保留旧摘要中的相关事实/);
  assert.match(section, /没有实质变化时只放入 mentions/);
  assert.match(MEMORY_PROMPT, /updates：\n- memoryId。\n- changeType：supplement 或 correction。\n- summary：无需变化时沿用原文。/u);
  assert(MEMORY_FORMAT.json_schema.schema.properties.updates.items.required.includes('summary'));
  assert.doesNotMatch(MEMORY_PROMPT, /candidateMemoryIds|readDetailFor|baseCandidateId|verdict/u);
});

test('per-session schema permits only valid user sources and leaves the shared format unchanged', () => {
  const before = JSON.stringify(MEMORY_FORMAT);
  const format = memoryFormatFor([
    ...source,
    { id: 'tool-result', role: 'tool', createdAt: source[2].createdAt },
    { id: 'invalid-time-user', role: 'user', createdAt: 'not-a-time' },
    { id: '', role: 'user', createdAt: source[2].createdAt },
  ]);
  for (const channel of ['creates', 'updates', 'mentions', 'retractions']) {
    const properties = format.json_schema.schema.properties[channel].items.properties;
    assert.equal(properties.anchorMessageId, undefined);
    assert.deepEqual(properties.sourceMessageIds.items.enum, ['U1', 'U2']);
    if (properties.summary) assert.equal(properties.summary.enum, undefined, 'shared string schema must not gain anchor restrictions');
  }
  assert.equal(format.json_schema.schema.properties.overview.anyOf[0].properties.summary.enum, undefined);
  format.json_schema.schema.properties.creates.items.properties.sourceMessageIds.items.enum.push('local-mutation');
  assert.equal(JSON.stringify(MEMORY_FORMAT), before);
  assert.deepEqual(memoryFormatFor(source).json_schema.schema.properties.creates.items.properties.sourceMessageIds.items.enum, ['U1', 'U2']);
});

test('per-session schema rejects snapshots without a valid user source', () => {
  assert.throws(() => memoryFormatFor([]), /没有可用作记忆锚点/);
  assert.throws(() => memoryFormatFor(source.filter(message => message.role === 'assistant')), /没有可用作记忆锚点/);
  assert.throws(() => memoryFormatFor([{ id: 'bad', role: 'user', sentAt: 'invalid' }]), /没有可用作记忆锚点/);
});

test('assistant anchor validation failure carries entry evidence without remapping the ID', () => {
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-cello', ...evidence('a') });
  assert.throws(() => validate(plan), error => {
    assert.equal(error.message, '记忆锚点须为本会话中有有效时间的用户消息');
    assert.deepEqual(error.validationContext, { channel: 'mentions', index: 0, anchorMessageId: 'a', anchorRole: 'assistant' });
    return true;
  });
  assert.equal(plan.mentions[0].anchorMessageId, 'a');
});

test('same-time user messages remain eligible and latest snapshot order still validates', () => {
  const messages = source.map(message => ({ ...message, createdAt: '2026-11-12T08:00:00Z' }));
  const format = memoryFormatFor(messages);
  assert.equal(format.json_schema.schema.properties.mentions.items.properties.anchorMessageId, undefined);
  assert.deepEqual(format.json_schema.schema.properties.mentions.items.properties.sourceMessageIds.items.enum, ['U1', 'U2']);
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-cello', ...evidence('u-last', ['u-first', 'u-last']) });
  assert.equal(validate(plan, context, messages).mentions[0].anchorMessageId, 'u-last');
  plan.mentions[0].anchorMessageId = 'u-first';
  assert.throws(() => validate(plan, context, messages), error => error.validationContext.anchorMessageId === 'u-first'
    && error.validationContext.anchorRole === 'user');
});

test('memory input has actual sent times, local date, retrieved archive and overview; no duplicate transcript alias', () => {
  const messages = memoryMessages(source, 'Asia/Shanghai', context);
  const input = JSON.parse(messages[1].content);
  assert.equal(input.userMessages[1].sentAt, source[2].createdAt);
  assert.equal(input.userMessages[0].id, 'U1');
  assert.equal(input.userMessages[1].id, 'U2');
  assert.equal(input.userMessages[1].localDate, '2026-11-12');
  assert.equal(input.userMessages[0].localDate, '2026-11-11');
  assert.equal(input.messages, undefined);
  assert.equal(input.memoryIndex[1].state, 'archived');
  assert.deepEqual(input.overview, context.overview);
  assert.equal(input.revision, 9);
  assert.equal(input.conversation, undefined);
  assert.throws(() => memoryMessages(source, 'Asia/Shanghai', { memoryIndex: Array(501).fill(context.memoryIndex[0]) }), /最多 500/);
});

test('request encoding keeps original-order user references private and omits assistant IDs', () => {
  const request = memoryRequestFor(source, 'Asia/Shanghai', context);
  const input = JSON.parse(request.messages[1].content);
  assert.equal(request.responseFormat.json_schema.strict, true);
  assert.equal(request.responseFormat.json_schema.schema.properties.overview.anyOf[0].properties.createIndexes.items.minimum, undefined);
  assert.deepEqual(request.references, [{ ref: 'U1', messageId: 'u-first' }, { ref: 'U2', messageId: 'u-last' }]);
  assert.deepEqual(input.referenceFormat.userMessageIds, ['U1', 'U2']);
  assert.equal(input.assistantContext[0].beforeUserId, 'U2');
  assert.equal(input.assistantContext[0].text, source[1].text);
  assert.equal(input.assistantContext[0].sentAt, source[1].createdAt);
  assert.equal(Object.hasOwn(input.assistantContext[0], 'id'), false);
  assert.equal(Object.hasOwn(input.userMessages[0], 'role'), false);
  assert(Object.keys(input).indexOf('assistantContext') < Object.keys(input).indexOf('userMessages'));
  assert.equal(Object.keys(input).at(-1), 'userMessages');
  assert(!request.messages[1].content.includes('u-first'));
  assert(!request.messages[1].content.includes('u-last'));
  for (const channel of ['creates', 'updates', 'mentions', 'retractions']) {
    const props = request.responseFormat.json_schema.schema.properties[channel].items.properties;
    assert.equal(props.anchorMessageId, undefined);
    assert.deepEqual(props.sourceMessageIds.items.enum, ['U1', 'U2']);
    assert.equal(props.sourceMessageIds.minItems, undefined, 'unsupported bounds remain enforced locally');
  }
  const shiftedTimes = source.map((message, index) => ({ ...message, createdAt: index === 0
    ? '2026-11-12T09:00:00Z' : '2026-11-12T08:00:00Z' }));
  assert.deepEqual(memoryRequestFor(shiftedTimes, 'Asia/Shanghai').references, request.references, 'numbering follows snapshot order, not timestamp rank');
});

test('assistant context points only to the following user, preserving order and excluding the trailing answer', () => {
  const messages = [
    { id: 'ask-first', role: 'assistant', text: '你放学了吗？', createdAt: '2026-11-12T00:00:00Z' },
    { id: 'reply-first', role: 'user', text: '还没呢。', createdAt: '2026-11-12T00:01:00Z' },
    { id: 'ask-second', role: 'assistant', text: '老师没发现吧？', createdAt: '2026-11-12T00:02:00Z' },
    { id: 'context-extra', role: 'assistant', text: '我先听你说。', createdAt: '2026-11-12T00:02:01Z' },
    { id: 'reply-second', role: 'user', text: '没呢。', createdAt: '2026-11-12T00:03:00Z' },
    { id: 'trailing-answer', role: 'assistant', text: '这是没有后续用户确认的助手回复。', createdAt: '2026-11-12T00:04:00Z' },
  ];
  const input = JSON.parse(memoryRequestFor(messages, 'Asia/Shanghai').messages[1].content);
  assert.deepEqual(input.userMessages.map(message => [message.id, message.text]), [['U1', '还没呢。'], ['U2', '没呢。']]);
  assert.deepEqual(input.assistantContext.map(message => [message.beforeUserId, message.text]), [
    ['U1', '你放学了吗？'], ['U2', '老师没发现吧？'], ['U2', '我先听你说。'],
  ]);
  assert(input.assistantContext.every(message => !Object.hasOwn(message, 'id')));
  assert(!JSON.stringify(input).includes('没有后续用户确认的助手回复'));
});

test('exact short references resolve to real source IDs before existing strict validation', () => {
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-cello', ...wireEvidence(['U1', 'U2']) });
  const resolved = resolveMemoryOutput(JSON.stringify(plan), source);
  const decoded = JSON.parse(resolved);
  assert.equal(decoded.mentions[0].anchorMessageId, 'u-last');
  assert.deepEqual(decoded.mentions[0].sourceMessageIds, ['u-first', 'u-last']);
  const validated = validateMemoryOutput(resolved, source, 'Asia/Shanghai', context);
  assert.equal(validated.mentions[0].mentionedAt, source[2].createdAt);
  assert.equal(plan.mentions[0].anchorMessageId, undefined, 'original model plan has no computed internal anchor');
});

test('unknown references, assistant IDs and raw IDs in strict mode are never guessed or remapped', () => {
  for (const ref of ['U3', 'A1', 'a', 'u-last', 'outside-thread']) {
    const plan = empty();
    plan.mentions.push({ memoryId: 'm-cello', ...wireEvidence([ref]) });
    assert.throws(() => resolveMemoryOutput(JSON.stringify(plan), source), error => {
      assert.equal(error.message, '记忆引用须为本次会话中的用户编号');
      assert.equal(error.validationContext.reference, ref);
      assert.equal(error.validationContext.channel, 'mentions');
      return true;
    });
  }
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-cello', ...wireEvidence(['U2', 'a']) });
  assert.throws(() => resolveMemoryOutput(JSON.stringify(plan), source), error =>
    error.validationContext.field === 'sourceMessageIds' && error.validationContext.referenceRole === 'assistant');
});

test('explicit fixture compatibility accepts only known real user IDs, never assistant IDs', () => {
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-cello', ...wireEvidence(['u-first', 'u-last']) });
  const resolved = resolveMemoryOutput(JSON.stringify(plan), source, { allowRealUserIds: true });
  assert.equal(JSON.parse(resolved).mentions[0].anchorMessageId, 'u-last');
  plan.mentions[0].sourceMessageIds = ['a'];
  assert.throws(() => resolveMemoryOutput(JSON.stringify(plan), source, { allowRealUserIds: true }));
});

test('model cannot supply an anchor and invalid overview selections remain rejected', () => {
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-cello', ...evidence('U1', ['U1', 'U2']) });
  assert.throws(() => resolveMemoryOutput(JSON.stringify(plan), source), /锚点由后端计算/);
  const event = empty();
  event.creates.push({ kind: 'event', topics: ['南京'], summary: '用户去过南京。', ...wireEvidence() });
  event.overview = { summary: '用户去过南京。', memoryIds: [], createIndexes: [0] };
  const eventResolved = resolveMemoryOutput(JSON.stringify(event), source);
  assert.deepEqual(JSON.parse(eventResolved).overview.createIndexes, [0]);
  assert.throws(() => validateMemoryOutput(eventResolved, source, 'Asia/Shanghai', context), /来源索引无效/);
});

test('source-only resolution computes latest valid time and same-time snapshot order, independent of source array order', () => {
  for (const ids of [['U1', 'U2'], ['U2', 'U1']]) {
    const plan = empty();
    plan.mentions.push({ memoryId: 'm-cello', ...wireEvidence(ids) });
    const resolved = resolveMemoryOutput(JSON.stringify(plan), source);
    assert.equal(JSON.parse(resolved).mentions[0].anchorMessageId, 'u-last');
    assert.equal(validateMemoryOutput(resolved, source, 'Asia/Shanghai', context).mentions[0].mentionedAt, source[2].createdAt);
    const sameTime = source.map(message => ({ ...message, createdAt: '2026-11-12T08:00:00Z' }));
    const tied = resolveMemoryOutput(JSON.stringify(plan), sameTime);
    assert.equal(JSON.parse(tied).mentions[0].anchorMessageId, 'u-last');
    assert.equal(validateMemoryOutput(tied, sameTime, 'Asia/Shanghai', context).mentions[0].anchorMessageId, 'u-last');
  }
  const differentTimes = source.map((message, index) => ({ ...message, createdAt: index === 0
    ? '2026-11-12T09:00:00Z' : '2026-11-12T08:00:00Z' }));
  const plan = empty(); plan.mentions.push({ memoryId: 'm-cello', ...wireEvidence(['U2', 'U1']) });
  assert.equal(JSON.parse(resolveMemoryOutput(JSON.stringify(plan), differentTimes)).mentions[0].anchorMessageId, 'u-first');
});

test('source-only operations require at least one actual user source', () => {
  for (const sourceMessageIds of [[], null, 'U1']) {
    const plan = empty(); plan.mentions.push({ memoryId: 'm-cello', sourceMessageIds });
    assert.throws(() => resolveMemoryOutput(JSON.stringify(plan), source), /非空用户来源/);
  }
});

// These are prompt contract checks, not claims that every model follows them.
test('prompt distinguishes user facts from questions, assistant answers and transient emotional exaggeration', () => {
  assert.match(MEMORY_PROMPT, /个人事实由用户明确提供或确认/);
  assert.match(MEMORY_PROMPT, /助手的回答、推测、劝说和角色台词只帮助理解上下文/);
  assert.match(MEMORY_PROMPT, /用户问“我是谁”/);
  assert.match(MEMORY_PROMPT, /不等于用户确认/);
  assert.match(MEMORY_PROMPT, /长期了解需要持续适用的依据/);
  assert.match(MEMORY_PROMPT, /本次受挫和当时想法/);
  assert.match(MEMORY_PROMPT, /不要求固定句式或重复次数/);
  assert.match(MEMORY_PROMPT, /userMessages：本次用户发言的主证据/);
  assert.match(MEMORY_PROMPT, /beforeUserId/);
  assert.match(MEMORY_PROMPT, /仅采用那一部分/);
  assert.match(MEMORY_PROMPT, /持续性不明确时/);
  assert.match(MEMORY_PROMPT, /同一会话反复强调仍是当次表达/);
  assert.doesNotMatch(MEMORY_PROMPT, /anchorMessageId/);
  assert.match(MEMORY_PROMPT, /四个操作数组的每项均包含非空 sourceMessageIds/);
  assert.match(MEMORY_PROMPT, /后端从这些来源的真实发送时间与原始会话顺序/);
});

test('duplicate mentions preserve ID and derive time from latest user source rather than extraction time', () => {
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-cello', ...evidence('u-last', ['u-first', 'u-last']) });
  const result = validate(plan);
  assert.equal(result.mentions[0].memoryId, 'm-cello');
  assert.equal(result.mentions[0].mentionedAt, source[2].createdAt);
  assert.equal(result.mentions[0].mentionedOn, '2026-11-12');
  assert.equal(result.overview, null);
});

test('assistant/tool anchors, guessed IDs and an earlier referenced user anchor are rejected', () => {
  for (const item of [
    { memoryId: 'm-cello', ...evidence('a') },
    { memoryId: 'm-cello', ...evidence('tool') },
    { memoryId: 'guessed', ...evidence() },
    { memoryId: 'm-cello', ...evidence('u-first', ['u-first', 'u-last']) },
  ]) {
    const plan = empty(); plan.mentions.push(item);
    assert.throws(() => validate(plan));
  }
});

test('archive event can be mentioned without copying it or changing the user overview', () => {
  const plan = empty(); plan.mentions.push({ memoryId: 'm-event', ...evidence() });
  const result = validate(plan);
  assert.equal(result.mentions[0].memoryId, 'm-event');
  assert.equal(result.creates.length, 0);
  assert.equal(result.overview, null);
});

test('legacy output and model-owned archive/time fields are rejected', () => {
  assert.throws(() => validateMemoryOutput('{"items":[]}', source, 'Asia/Shanghai', context), /V2/);
  const top = { ...empty(), capacityBlocked: false };
  assert.throws(() => validate(top), /V2/);
  for (const field of ['lastMentionedAt', 'state', 'archivedAt']) {
    const plan = empty(); plan.mentions.push({ memoryId: 'm-cello', ...evidence(), [field]: 'active' });
    assert.throws(() => validate(plan), /结构无效/);
  }
});

test('same old ID cannot be both updated/mentioned or withdrawn/reactivated', () => {
  const plan = empty();
  plan.mentions.push({ memoryId: 'm-tea', ...evidence() });
  plan.retractions.push({ memoryId: 'm-tea', reason: '旧记录错误。', ...evidence() });
  assert.throws(() => validate(plan), /只能对应一种操作/);
});

test('new understanding may omit overview for post-review backend source maintenance', () => {
  const plan = empty();
  plan.creates.push({ kind: 'understanding', topics: ['称呼'], summary: '用户希望被称为阿澈。', ...evidence() });
  assert.equal(validate(plan).overview, null);
  plan.overview = { summary: '用户希望被称为阿澈，也每周六上午练大提琴。', memoryIds: ['m-cello'], createIndexes: [0] };
  const result = validate(plan);
  assert.deepEqual(result.overview.createIndexes, [0]);
  assert.deepEqual(result.overview.memoryIds, ['m-cello']);
});

test('overview can cite the same updated understanding ID but cannot cite withdrawn facts', () => {
  const plan = empty();
  plan.updates.push({ memoryId: 'm-tea', changeType: 'correction', summary: '用户不再喝咖啡，改喝陈皮白茶。', ...evidence() });
  plan.overview = { summary: '用户改喝陈皮白茶。', memoryIds: ['m-tea'], createIndexes: [] };
  assert.equal(validate(plan).updates[0].changeType, 'correction');
  plan.updates = [];
  plan.retractions.push({ memoryId: 'm-tea', reason: '原咖啡偏好记错了。', ...evidence() });
  assert.throws(() => validate(plan), /已撤回或未知记忆/);
  plan.overview = { summary: '用户每周六上午练大提琴。', memoryIds: ['m-cello'], createIndexes: [] };
  assert.equal(validate(plan).retractions.length, 1);
});

test('overview forbids event/unknown/new-event sources and requires matching evidence for nonempty summary', () => {
  for (const value of [
    { summary: '用户去南京。', memoryIds: ['m-event'], createIndexes: [] },
    { summary: '用户有猫。', memoryIds: ['unknown'], createIndexes: [] },
    { summary: '无依据的概括。', memoryIds: [], createIndexes: [] },
    { summary: '', memoryIds: ['m-cello'], createIndexes: [] },
    { summary: '用户每周练琴。', memoryIds: [], createIndexes: [0] },
  ]) {
    const plan = empty(); plan.overview = value;
    assert.throws(() => validate(plan));
  }
  const event = empty();
  event.creates.push({ kind: 'event', topics: [], summary: '用户去过南京。', ...evidence() });
  event.overview = { summary: '用户去过南京。', memoryIds: [], createIndexes: [0] };
  assert.throws(() => validate(event), /来源索引无效/);
});

test('withdrawing the last overview source can explicitly clear the overview', () => {
  const plan = empty();
  plan.retractions.push({ memoryId: 'm-tea', reason: '原记录错误。', ...evidence() });
  const ctx = { ...context, overview: { summary: '用户喜欢咖啡。', memoryIds: ['m-tea'], version: 1 } };
  assert.equal(validate(plan, ctx).overview, null);
  plan.overview = { summary: '', memoryIds: [], createIndexes: [] };
  assert.deepEqual(validate(plan, ctx).overview, plan.overview);
});

test('event details keep actual occurrence separate from current mention and reject invented date formats', () => {
  const plan = empty();
  plan.updates.push({ memoryId: 'm-event', changeType: 'supplement', summary: '用户去年在南京城墙迷路，姐姐带回出口。',
    detailDelta: { occurredAt: '2025-10-04', place: '南京城墙' }, ...evidence() });
  const result = validate(plan);
  assert.equal(result.updates[0].detailDelta.occurredAt, '2025-10-04');
  assert.equal(result.updates[0].mentionedOn, '2026-11-12');
  for (const bad of ['2025', '昨天', '2025-02-29', '2025-10-04（星期六）', '2025-10-04T25:00:00Z']) {
    plan.updates[0].detailDelta.occurredAt = bad;
    assert.throws(() => validate(plan), /日期/);
  }
  assert.equal(validDate('2024-02-29'), true);
});

test('new chat context carries basic user and concise overview, omitting raw recent memories and legacy profile', () => {
  const history = [{ role: 'user', text: '在吗？' }];
  const messages = prepareMessages({ system: '角色设定', localTime: { localDate: '2026-11-12' },
    userProfile: { id: 'private-id', name: '阿澈', age: 28, interests: ['游泳'] },
    userOverview: { summary: '喜欢先听结论。', memoryIds: ['m-secret'] },
    soulProfile: { interest: ['legacy-topic'] }, recentMemories: [{ summary: '不应自动注入的旧事' }], history });
  const data = JSON.parse(messages[1].content.split('\n').slice(1).join('\n'));
  assert.deepEqual(data.userProfile, { name: '阿澈', age: 28, interests: ['游泳'] });
  assert.equal(data.userOverview, '喜欢先听结论。');
  assert.match(messages[1].content.split('\n')[0], /背景资料.*不是用户本轮发言或新的任务/);
  assert.equal(messages.at(-1).content, '在吗？');
  assert.equal(data.recentMemories, undefined);
  assert.equal(data.soulProfile, undefined);
  assert(!messages[1].content.includes('m-secret'));
  assert(!messages[1].content.includes('private-id'));
  const legacy = prepareMessages({ system: '', childProfile: { name: '兼容用户' }, history });
  assert.match(legacy[1].content, /兼容用户/);
});

test('platform prompt is general while each Soul retains its own identity and speaking style', () => {
  assert.doesNotMatch(COMMON_PROMPT, /陪孩子聊天|鳄鱼爸爸 APP/);
  assert.match(COMMON_PROMPT, /已知年龄/);
  assert.match(COMMON_PROMPT, /当前资料不足时，先按话题主动查记忆/);
  for (const soul of loadSouls().values()) {
    const rendered = renderSoul(soul);
    assert(rendered.includes(soul.schemaVersion === 2 ? soul.definition : soul.speakingStyle));
    assert(rendered.includes(soul.identity.name));
    assert(!rendered.includes('孩子也叫你'));
  }
});

