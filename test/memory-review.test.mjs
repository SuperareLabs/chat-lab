import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryReviewRequestFor, applyMemoryReview, MEMORY_REVIEW_PROMPT } from '../lib/memory-review.mjs';
import { validateMemoryOutput } from '../lib/memory.mjs';

const snapshot = [
  { id: 'assistant-question', role: 'assistant', text: '老师没发现吧？', createdAt: '2026-11-12T01:00:00Z' },
  { id: 'user-one', role: 'user', text: '没呢。', createdAt: '2026-11-12T01:00:01Z' },
  { id: 'assistant-guess', role: 'assistant', text: '你是在课间溜来的吧？', createdAt: '2026-11-12T01:00:02Z' },
  { id: 'user-two', role: 'user', text: '我在开小差。', createdAt: '2026-11-12T01:00:03Z' },
  { id: 'unrelated', role: 'user', text: '一段不相关的私密原话。', createdAt: '2026-11-12T01:00:04Z' },
];
const context = { memoryIndex: [{ id: 'memory-old', kind: 'understanding', state: 'active', summary: '用户喜欢白茶。' },
  { id: 'memory-unrelated', kind: 'event', summary: '无关旧记忆不应传入。' }] };
const source = id => ({ anchorMessageId: id, sourceMessageIds: [id], mentionedAt: 'derived', mentionedOn: 'derived' });
const empty = () => ({ creates: [], updates: [], mentions: [], retractions: [], overview: null });
const review = (channel, index, decision, changes = {}) => ({ channel, index, decision, ...changes });
const apply = (reviews, plan) => applyMemoryReview(JSON.stringify({ reviews }), plan);

test('review request only sends each candidate evidence, preceding assistant context and matched old summary', () => {
  const plan = empty();
  plan.creates.push({ kind: 'event', topics: ['开小差'], summary: '用户课间开小差。', detail: { notes: '老师没发现。' }, ...source('user-two') });
  plan.updates.push({ memoryId: 'memory-old', changeType: 'correction', summary: '用户改喝乌龙茶。', ...source('user-one') });
  const request = memoryReviewRequestFor(plan, snapshot, 'Asia/Shanghai', context);
  const input = JSON.parse(request.messages[1].content);
  assert.equal(request.responseFormat.json_schema.name, 'general_chat_memory_review_v1');
  assert.equal(request.responseFormat.json_schema.strict, true);
  assert.deepEqual(input.items.map(item => [item.channel, item.index]), [['creates', 0], ['updates', 0]]);
  assert.deepEqual(input.items[0].userSources.map(item => item.text), ['我在开小差。']);
  assert.deepEqual(input.items[0].topics, ['开小差']);
  assert.equal(input.items[0].userSources[0].assistantContext[0].text, '你是在课间溜来的吧？');
  assert.deepEqual(input.items[1].previousMemory, { kind: 'understanding', summary: '用户喜欢白茶。' });
  const text = JSON.stringify(input);
  assert(!text.includes('不相关的私密原话'));
  assert(!text.includes('无关旧记忆'));
  assert(!text.includes('user-two'));
  assert(!text.includes('assistant-guess'));
  assert(!text.includes('memory-old'));
  assert.match(MEMORY_REVIEW_PROMPT, /同一会话反复强调不单独证明持续习惯/);
});

test('pure mentions and withdrawals skip the second request', () => {
  const plan = empty();
  plan.mentions.push({ memoryId: 'memory-old', ...source('user-one') });
  plan.retractions.push({ memoryId: 'other', reason: '记错了。', ...source('user-two') });
  assert.equal(memoryReviewRequestFor(plan, snapshot, 'Asia/Shanghai', context), null);
  const raw = apply([], plan);
  assert.equal(raw.mentions[0].anchorMessageId, 'user-one');
  assert.equal(raw.mentions[0].mentionedAt, undefined);
});

test('keep preserves content and evidence and only removes internal derived fields', () => {
  const plan = empty();
  plan.creates.push({ kind: 'event', topics: [], summary: '用户开小差。', detail: { notes: '本轮经历。' }, ...source('user-two') });
  const before = JSON.stringify(plan);
  const result = apply([review('creates', 0, 'keep', { summary: '不采纳的改写。' })], plan);
  assert.equal(result.creates[0].summary, plan.creates[0].summary);
  assert.deepEqual(result.creates[0].detail, plan.creates[0].detail);
  assert.equal(result.creates[0].anchorMessageId, 'user-two');
  assert.deepEqual(result.creates[0].sourceMessageIds, ['user-two']);
  assert.equal(result.creates[0].mentionedAt, undefined);
  assert.equal(result.creates[0].mentionedOn, undefined);
  assert.equal(JSON.stringify(plan), before);
});

test('revise replaces summary and removes omitted detail instead of retaining unsupported old text', () => {
  const plan = empty();
  plan.creates.push({ kind: 'event', topics: ['开小差'], summary: '用户课间开小差。', detail: { notes: '课间。' }, ...source('user-two') });
  plan.updates.push({ memoryId: 'memory-old', changeType: 'correction', summary: '用户改喝乌龙茶。', detailDelta: { notes: '旧增量。' }, ...source('user-one') });
  const result = apply([review('creates', 0, 'revise', { summary: '用户本轮说自己在开小差。' }),
    review('updates', 0, 'revise', { summary: '用户改喝乌龙茶。', detail: { notes: '明确更正饮品偏好。' } })], plan);
  assert.equal(result.creates[0].detail, undefined);
  assert.deepEqual(result.creates[0].topics, [], 'omitted revised topics cannot retain unsupported old entities');
  assert.equal(result.updates[0].memoryId, 'memory-old');
  assert.equal(result.updates[0].changeType, 'correction');
  assert.deepEqual(result.updates[0].detailDelta, { notes: '明确更正饮品偏好。' });
  assert.equal(result.creates[0].kind, 'event');
});

test('revised create topics replace old tags, while updates keep their original field contract', () => {
  const plan = empty();
  plan.creates.push({ kind: 'event', topics: ['课间', '开小差'], summary: '课间开小差。', ...source('user-two') });
  plan.updates.push({ memoryId: 'memory-old', changeType: 'correction', summary: '改喝乌龙。', ...source('user-one') });
  const result = apply([review('creates', 0, 'revise', { summary: '用户说自己在开小差。', topics: ['开小差'] }),
    review('updates', 0, 'revise', { summary: '用户改喝乌龙。', topics: ['不进入更新字段'] })], plan);
  assert.deepEqual(result.creates[0].topics, ['开小差']);
  assert.equal(result.updates[0].topics, undefined);
  assert.throws(() => apply([review('creates', 0, 'revise', { summary: '有效。', topics: [''] }),
    review('updates', 0, 'keep')], plan), /主题词/);
});

test('drop compacts creation indexes and filters overview references without changing existing sources', () => {
  const plan = empty();
  plan.creates.push({ kind: 'understanding', topics: [], summary: '无依据的年龄。', ...source('user-one') },
    { kind: 'event', topics: [], summary: '当次开小差。', ...source('user-two') },
    { kind: 'understanding', topics: [], summary: '有效偏好。', ...source('user-two') });
  plan.overview = { summary: '供审计的概括草稿。', memoryIds: ['memory-old'], createIndexes: [0, 2] };
  const result = apply([review('creates', 0, 'drop'), review('creates', 1, 'keep'), review('creates', 2, 'keep')], plan);
  assert.equal(result.creates.length, 2);
  assert.deepEqual(result.overview.createIndexes, [1]);
  assert.deepEqual(result.overview.memoryIds, ['memory-old']);
});

test('all new understanding dropped clears an overview with no remaining sources', () => {
  const plan = empty();
  plan.creates.push({ kind: 'understanding', topics: [], summary: '无依据画像。', ...source('user-one') });
  plan.overview = { summary: '无依据草稿。', memoryIds: [], createIndexes: [0] };
  const result = apply([review('creates', 0, 'drop')], plan);
  assert.deepEqual(result.overview, { summary: '', memoryIds: [], createIndexes: [] });
  assert.deepEqual(validateMemoryOutput(JSON.stringify(result), snapshot, 'Asia/Shanghai', context).creates, []);
});

test('verdict coverage is exact; missing, duplicate, extra or identity-changing entries fail atomically', () => {
  const plan = empty();
  plan.creates.push({ kind: 'event', topics: [], summary: '用户开小差。', ...source('user-two') });
  for (const verdicts of [[], [review('creates', 0, 'keep'), review('creates', 0, 'drop')],
    [review('updates', 0, 'keep')], [review('creates', 1, 'keep')],
    [review('creates', 0, 'revise', { summary: '改写。', sourceMessageIds: ['other'] })],
    [review('creates', 0, 'revise', { summary: '改写。', kind: 'understanding' })]]) {
    const before = JSON.stringify(plan);
    assert.throws(() => apply(verdicts, plan));
    assert.equal(JSON.stringify(plan), before);
  }
});

test('revise requires complete summary and valid detail structure; final date validation still applies', () => {
  const plan = empty();
  plan.creates.push({ kind: 'event', topics: [], summary: '用户开小差。', ...source('user-two') });
  for (const changes of [{}, { summary: '' }, { summary: '有效。', detail: { unsupported: '字段' } },
    { summary: '有效。', detail: { notes: '' } }]) assert.throws(() => apply([review('creates', 0, 'revise', changes)], plan));
  const raw = apply([review('creates', 0, 'revise', { summary: '用户本轮开小差。', detail: { occurredAt: '昨天' } })], plan);
  assert.throws(() => validateMemoryOutput(JSON.stringify(raw), snapshot, 'Asia/Shanghai', context), /日期/);
});

test('review request rejects assistant-only evidence rather than silently taking nearby user evidence', () => {
  const plan = empty();
  plan.creates.push({ kind: 'event', topics: [], summary: '无用户证据。', ...source('assistant-guess') });
  assert.throws(() => memoryReviewRequestFor(plan, snapshot, 'Asia/Shanghai'), /只能引用本轮用户来源/);
});
