import { DETAIL_KEYS } from './memory.mjs';
import { toLocalTime } from './prompts.mjs';

export const MEMORY_REVIEW_PROMPT = `你是记忆整理中的事实核对步骤，只核对输入 items 中已经提出的新增和更新。
逐项比较候选摘要、主题词与详情、userSources 和已有摘要 previousMemory，检查每个具体成分的依据、人物归属、否定和时间。
userSources 是本项的用户证据；其中 assistantContext 只用于理解该用户回复的省略、指代或局部确认，助手的猜测和解释不自动成为用户事实。问题本身不确认其答案，也不确认助手问题中的全部前提。
更新可以沿用 previousMemory 中未被本轮更正的事实。本次情绪、争辩和夸张结合处境理解；同一会话反复强调不单独证明持续习惯。understanding 需要用户提供或确认的可持续个人了解。
keep：候选内容有依据，保留原摘要与详情。
revise：保留有依据的内容，仅删除或收窄无依据的补足。提供修改后的完整 summary；可提供完整 detail。省略 detail 表示移除本项原详情增量，避免无依据成分残留。creates 可提供有依据的 topics 列表，省略时清空原主题词；updates 不修改主题词。
drop：没有支持候选的用户事实，或无法在原 kind 下修成有依据的记忆。类型不合适时整项 drop，不改成另一类或另建条目。
每个输入项按原 channel 和 index 恰好输出一条 reviews，不新增项目，不改变类型、旧记忆 ID 或用户来源。
只返回 JSON：{"reviews":[{"channel":"creates","index":0,"decision":"keep"}]}。
decision 为 keep、drop 或 revise；只有 revise 的 summary 和可选 detail 用于替换。updates 的 detail 指本次 detailDelta，不是整份旧详情。`;

const CHANNELS = ['creates', 'updates', 'mentions', 'retractions'];
const REVIEW_CHANNELS = ['creates', 'updates'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && !!value.trim();
const sentAt = message => message.sentAt ?? message.createdAt;
const key = (channel, index) => `${channel}:${index}`;
const shape = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });

function assertPlan(plan) {
  if (!object(plan) || CHANNELS.some(channel => !Array.isArray(plan[channel]))) throw new Error('事实核对需要完整记忆计划');
}

/** A small second pass: only each proposed fact, its own user evidence, the
 * immediately preceding assistant context and the matched old summary. */
export function memoryReviewRequestFor(plan, snapshot, timezone, context = {}) {
  assertPlan(plan);
  if (!plan.creates.length && !plan.updates.length) return null;
  if (!Array.isArray(snapshot)) throw new Error('事实核对缺少会话来源快照');
  const sources = new Map(snapshot.map((message, index) => [message.id, { message, index }]));
  const memories = new Map((context.memoryIndex ?? []).map(memory => [memory.id ?? memory.memoryId, memory]));
  const dated = message => {
    const at = sentAt(message);
    if (!Number.isFinite(Date.parse(at))) throw new Error('事实核对来源时间无效');
    return { text: message.text, sentAt: at, localDate: toLocalTime(new Date(at), timezone).localDate };
  };
  const items = REVIEW_CHANNELS.flatMap(channel => plan[channel].map((proposal, index) => {
    if (!object(proposal) || !nonblank(proposal.summary) || !Array.isArray(proposal.sourceMessageIds)
        || !proposal.sourceMessageIds.length) throw new Error('事实核对候选或用户来源无效');
    const previous = channel === 'updates' ? memories.get(proposal.memoryId) : null;
    if (channel === 'updates' && !previous) throw new Error('事实核对缺少更新对应的旧记忆摘要');
    const userSources = proposal.sourceMessageIds.map(id => {
      const source = sources.get(id);
      if (!source || source.message.role !== 'user') throw new Error('事实核对只能引用本轮用户来源');
      const assistantContext = [];
      for (let before = source.index - 1; before >= 0 && snapshot[before].role === 'assistant'; before--) {
        assistantContext.push(dated(snapshot[before]));
      }
      return { ...dated(source.message), assistantContext: assistantContext.reverse() };
    });
    const detail = channel === 'creates' ? proposal.detail : proposal.detailDelta;
    return { channel, index, kind: channel === 'creates' ? proposal.kind : previous.kind,
      ...(channel === 'creates' ? { topics: structuredClone(proposal.topics ?? []) } : {}),
      summary: proposal.summary, ...(detail !== undefined ? { detail: structuredClone(detail) } : {}),
      ...(previous ? { previousMemory: { kind: previous.kind, summary: previous.summary } } : {}), userSources };
  }));
  const detailSchema = shape(Object.fromEntries(DETAIL_KEYS.map(field => [field, { type: 'string' }])), []);
  const schema = shape({ reviews: { type: 'array', items: shape({
    channel: { type: 'string', enum: [...new Set(items.map(item => item.channel))] },
    index: { type: 'integer', enum: [...new Set(items.map(item => item.index))] },
    decision: { type: 'string', enum: ['keep', 'drop', 'revise'] },
    summary: { type: 'string' }, detail: detailSchema, topics: { type: 'array', items: { type: 'string' } },
  }, ['channel', 'index', 'decision']) } }, ['reviews']);
  return {
    messages: [{ role: 'system', content: MEMORY_REVIEW_PROMPT },
      { role: 'user', content: JSON.stringify({ timezone, items }) }],
    responseFormat: { type: 'json_schema', json_schema: { name: 'general_chat_memory_review_v1', strict: true, schema } },
  };
}

function readRevision(review) {
  if (!nonblank(review.summary)) throw new Error('修订记忆必须提供完整摘要');
  let detail;
  if (Object.hasOwn(review, 'detail')) {
    if (!object(review.detail) || Object.keys(review.detail).some(field => !DETAIL_KEYS.includes(field))
        || Object.values(review.detail).some(value => !nonblank(value))) throw new Error('修订详情结构无效');
    detail = Object.fromEntries(Object.entries(review.detail).map(([field, value]) => [field, value.trim()]));
  }
  if (Object.hasOwn(review, 'topics') && (!Array.isArray(review.topics) || review.topics.some(topic => !nonblank(topic)))) {
    throw new Error('修订主题词结构无效');
  }
  return { summary: review.summary.trim(), ...(detail !== undefined ? { detail } : {}),
    topics: [...new Set((review.topics ?? []).map(topic => topic.trim()))] };
}

/** Apply an exact verdict set without changing identity/evidence or guessing a
 * missing review. Return a UUID plan for the existing strict validator. */
export function applyMemoryReview(content, plan) {
  assertPlan(plan);
  const output = typeof content === 'string' ? JSON.parse(content) : structuredClone(content);
  if (!object(output) || Object.keys(output).some(field => field !== 'reviews') || !Array.isArray(output.reviews)) {
    throw new Error('事实核对须返回 reviews 列表');
  }
  const expected = new Set(REVIEW_CHANNELS.flatMap(channel => plan[channel].map((_, index) => key(channel, index))));
  const reviews = new Map();
  for (const review of output.reviews) {
    if (!object(review) || Object.keys(review).some(field => !['channel', 'index', 'decision', 'summary', 'detail', 'topics'].includes(field))
        || !REVIEW_CHANNELS.includes(review.channel) || !Number.isSafeInteger(review.index) || review.index < 0
        || !['keep', 'drop', 'revise'].includes(review.decision)) throw new Error('事实核对条目结构无效');
    const identity = key(review.channel, review.index);
    if (!expected.has(identity) || reviews.has(identity)) throw new Error('事实核对条目重复或不在本次候选中');
    let revision;
    try { if (review.decision === 'revise') revision = readRevision(review); }
    catch (error) { throw Object.assign(error, { validationContext: { phase: 'review', channel: review.channel, index: review.index } }); }
    reviews.set(identity, { ...review, revision });
  }
  if (reviews.size !== expected.size) throw new Error('事实核对未覆盖全部新增和更新');
  const result = structuredClone(plan);
  const createIndexes = new Map();
  for (const channel of CHANNELS) {
    result[channel] = plan[channel].flatMap((proposal, index) => {
      const verdict = reviews.get(key(channel, index));
      if (verdict?.decision === 'drop') return [];
      const { mentionedAt, mentionedOn, ...raw } = structuredClone(proposal);
      if (verdict?.decision === 'revise') {
        raw.summary = verdict.revision.summary;
        if (channel === 'creates') raw.topics = verdict.revision.topics;
        const detailField = channel === 'creates' ? 'detail' : 'detailDelta';
        delete raw[detailField];
        if (Object.hasOwn(verdict.revision, 'detail')) raw[detailField] = verdict.revision.detail;
      }
      if (channel === 'creates') createIndexes.set(index, createIndexes.size);
      return [raw];
    });
  }
  if (result.overview != null) {
    result.overview.createIndexes = result.overview.createIndexes.flatMap(index => createIndexes.has(index) ? [createIndexes.get(index)] : []);
    if (!result.overview.memoryIds.length && !result.overview.createIndexes.length) result.overview.summary = '';
  }
  return result;
}
