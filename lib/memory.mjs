import { MEMORY_PROMPT, toLocalTime } from './prompts.mjs';

export const DETAIL_KEYS = ['occurredAt', 'plannedAt', 'place', 'event', 'sequence', 'notes'];
const CHANNELS = ['creates', 'updates', 'mentions', 'retractions'];
const string = { type: 'string' };
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const array = items => ({ type: 'array', items });
const detail = object(Object.fromEntries(DETAIL_KEYS.map(key => [key, string])), []);
const source = { anchorMessageId: string, sourceMessageIds: { ...array(string), minItems: 1 } };
const sourceRequired = Object.keys(source);
const modelSource = { sourceMessageIds: source.sourceMessageIds };
const overview = object({ summary: string, memoryIds: array(string), createIndexes: array({ type: 'integer', minimum: 0 }) },
  ['summary', 'memoryIds', 'createIndexes']);

export const MEMORY_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'general_chat_memory_v2', strict: false,
    schema: object({
      creates: array(object({ ...modelSource, kind: { type: 'string', enum: ['understanding', 'event'] },
        topics: array(string), summary: string, detail }, ['sourceMessageIds', 'kind', 'topics', 'summary'])),
      updates: array(object({ ...modelSource, memoryId: string, changeType: { type: 'string', enum: ['supplement', 'correction'] },
        summary: string, detailDelta: detail }, ['sourceMessageIds', 'memoryId', 'changeType', 'summary'])),
      mentions: array(object({ ...modelSource, memoryId: string }, ['sourceMessageIds', 'memoryId'])),
      retractions: array(object({ ...modelSource, memoryId: string, reason: string }, ['sourceMessageIds', 'memoryId', 'reason'])),
      overview: { anyOf: [overview, { type: 'null' }] },
    }, [...CHANNELS, 'overview']),
  },
};

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeysOnly = (value, allowed) => plainObject(value) && Object.keys(value).every(key => allowed.includes(key));
const nonblank = value => typeof value === 'string' && !!value.trim();
const sentAt = message => message.sentAt ?? message.createdAt;

function userReferencesFor(sourceMessages) {
  if (!Array.isArray(sourceMessages)) throw new Error('记忆来源须为本次会话消息列表');
  const seen = new Set();
  let ordinal = 0;
  const references = [];
  for (const message of sourceMessages) {
    if (message?.role !== 'user') continue;
    ordinal++;
    if (!nonblank(message.id) || !Number.isFinite(Date.parse(sentAt(message))) || seen.has(message.id)) continue;
    seen.add(message.id);
    references.push({ ref: `U${ordinal}`, messageId: message.id });
  }
  if (!references.length) throw new Error('此会话没有可用作记忆锚点的用户消息');
  return references;
}

function formatForReferences(references) {
  const refs = references.map(item => item.ref);
  const format = structuredClone(MEMORY_FORMAT);
  // Ark's strict schema grammar supports enum/items/required, but not numeric
  // minimum or array minItems. Keep those checks in the local validator.
  format.json_schema.strict = true;
  delete format.json_schema.schema.properties.overview.anyOf[0].properties.createIndexes.items.minimum;
  for (const channel of CHANNELS) {
    const properties = format.json_schema.schema.properties[channel].items.properties;
    // Replace fields rather than mutating the shared string schema, which is
    // also used by summaries and other unrestricted string values.
    properties.sourceMessageIds = { ...properties.sourceMessageIds, items: { type: 'string', enum: [...refs] } };
    delete properties.sourceMessageIds.minItems;
  }
  return format;
}

export function memoryFormatFor(sourceMessages) {
  return formatForReferences(userReferencesFor(sourceMessages));
}

/** Resolve only exact references from this snapshot. Unknown references and
 * assistant IDs fail closed; they are never guessed or moved to a nearby user. */
export function resolveMemoryOutput(content, sourceMessages, { allowRealUserIds = false } = {}) {
  const references = userReferencesFor(sourceMessages);
  const byRef = new Map(references.map(item => [item.ref, item.messageId]));
  const userIds = new Set(references.map(item => item.messageId));
  const sourceById = new Map(sourceMessages.map((message, index) => [message.id, { message, index }]));
  const output = typeof content === 'string' ? JSON.parse(content) : structuredClone(content);
  if (!plainObject(output)) return JSON.stringify(output);
  for (const channel of CHANNELS) {
    if (!Array.isArray(output[channel])) continue;
    for (const [index, item] of output[channel].entries()) {
      if (!plainObject(item)) continue;
      const invalid = (message, extra = {}) => Object.assign(new Error(message), { validationContext: { channel, index, ...extra } });
      if (Object.hasOwn(item, 'anchorMessageId')) throw invalid('模型只需提供用户来源，记忆锚点由后端计算');
      const resolve = (ref, field) => {
        if (byRef.has(ref)) return byRef.get(ref);
        if (allowRealUserIds && userIds.has(ref)) return ref;
        throw invalid('记忆引用须为本次会话中的用户编号', { field, reference: ref ?? null,
          referenceRole: sourceById.get(ref)?.message.role ?? null });
      };
      if (!Array.isArray(item.sourceMessageIds) || !item.sourceMessageIds.length) throw invalid('记忆操作须提供非空用户来源');
      item.sourceMessageIds = item.sourceMessageIds.map(ref => resolve(ref, 'sourceMessageIds'));
      const latest = item.sourceMessageIds.map(id => sourceById.get(id))
        .sort((a, b) => Date.parse(sentAt(b.message)) - Date.parse(sentAt(a.message)) || b.index - a.index)[0];
      item.anchorMessageId = latest.message.id;
    }
  }
  return JSON.stringify(output);
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validEventTime(value) {
  return validDate(value) || (
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
  );
}

function readDetail(raw) {
  if (!ownKeysOnly(raw, DETAIL_KEYS)) throw new Error('记忆详情结构无效');
  return Object.fromEntries(Object.entries(raw).map(([field, text]) => {
    if (!nonblank(text)) throw new Error('记忆详情字段须为有内容的字符串');
    const value = text.trim();
    if (['occurredAt', 'plannedAt'].includes(field) && !validEventTime(value)) {
      throw new Error('记忆详情日期须为有效日期或带时区的时刻');
    }
    return [field, value];
  }));
}

/** Validate against the exact source/candidate snapshot. Meaning and whether a
 * user actually referred to a memory remain model responsibilities. This gate
 * checks the latest referenced user source without inventing missing evidence. */
export function validateMemoryOutput(content, sourceMessages, timezone, context = {}) {
  const output = JSON.parse(content);
  if (!ownKeysOnly(output, [...CHANNELS, 'overview']) || !CHANNELS.every(key => Array.isArray(output[key]))
    || !Object.hasOwn(output, 'overview')) throw new Error('记忆整理须返回 V2 四类操作与用户概括');
  const sources = new Map(sourceMessages.map((message, index) => [message.id, { message, index }]));
  const candidates = new Map((context.memoryIndex ?? []).map(item => [item.id ?? item.memoryId, item]));
  const usedIds = new Map();
  const result = { creates: [], updates: [], mentions: [], retractions: [], overview: null };
  for (const channel of CHANNELS) {
    for (const [index, item] of output[channel].entries()) {
      const validationContext = { channel, index, anchorMessageId: item?.anchorMessageId ?? null,
        anchorRole: sources.get(item?.anchorMessageId)?.message.role ?? null };
      const invalid = (message, extra = {}) => Object.assign(new Error(message), {
        validationContext: { ...validationContext, ...extra },
      });
      const allowed = channel === 'creates' ? [...sourceRequired, 'kind', 'topics', 'summary', 'detail']
        : channel === 'updates' ? [...sourceRequired, 'memoryId', 'changeType', 'summary', 'detailDelta']
          : channel === 'mentions' ? [...sourceRequired, 'memoryId'] : [...sourceRequired, 'memoryId', 'reason'];
      if (!ownKeysOnly(item, allowed) || !nonblank(item.anchorMessageId) || !Array.isArray(item.sourceMessageIds)
        || !item.sourceMessageIds.length || !item.sourceMessageIds.includes(item.anchorMessageId)
        || item.sourceMessageIds.some(id => !sources.has(id)) || new Set(item.sourceMessageIds).size !== item.sourceMessageIds.length) {
        throw invalid('记忆操作结构无效或引用了本会话之外的来源');
      }
      const anchor = sources.get(item.anchorMessageId)?.message;
      if (!anchor || anchor.role !== 'user' || !Number.isFinite(Date.parse(sentAt(anchor)))) {
        throw invalid('记忆锚点须为本会话中有有效时间的用户消息');
      }
      const latest = item.sourceMessageIds.map(id => sources.get(id)).filter(entry => entry.message.role === 'user')
        .sort((a, b) => Date.parse(sentAt(b.message)) - Date.parse(sentAt(a.message)) || b.index - a.index)[0];
      if (latest.message.id !== anchor.id) throw invalid('记忆锚点须使用本次来源中最后一条用户消息');
      const normalized = {
        anchorMessageId: anchor.id, sourceMessageIds: [...item.sourceMessageIds],
        mentionedAt: sentAt(anchor), mentionedOn: toLocalTime(new Date(sentAt(anchor)), timezone).localDate,
      };
      if (channel === 'creates') {
        if (!['understanding', 'event'].includes(item.kind) || !Array.isArray(item.topics)
          || item.topics.some(topic => !nonblank(topic))) throw new Error('新增记忆须提供有效类型与主题词');
        normalized.kind = item.kind;
        normalized.topics = [...new Set(item.topics.map(topic => topic.trim()))];
      } else {
        const existing = candidates.get(item.memoryId);
        if (!nonblank(item.memoryId) || !existing || existing.state === 'retracted') {
          throw invalid('记忆 ID 不在本次有效候选中', { memoryId: item.memoryId ?? null });
        }
        if (usedIds.has(item.memoryId)) {
          throw invalid('同一记忆 ID 在本轮只能对应一种操作', {
            memoryId: item.memoryId, conflictingOperation: usedIds.get(item.memoryId),
          });
        }
        usedIds.set(item.memoryId, { channel, index });
        normalized.memoryId = item.memoryId;
      }
      if (channel === 'updates') {
        if (!['supplement', 'correction'].includes(item.changeType)) throw new Error('记忆更新类型无效');
        normalized.changeType = item.changeType;
      }
      if (channel === 'creates' || channel === 'updates') {
        if (!nonblank(item.summary)) throw new Error('记忆操作缺少摘要');
        normalized.summary = item.summary.trim();
        const field = channel === 'creates' ? 'detail' : 'detailDelta';
        if (item[field] !== undefined) normalized[field] = readDetail(item[field]);
      }
      if (channel === 'retractions') {
        if (!nonblank(item.reason)) throw new Error('撤回记忆须说明本轮明确依据');
        normalized.reason = item.reason.trim();
      }
      result[channel].push(normalized);
    }
  }
  const retracted = new Set(result.retractions.map(item => item.memoryId));
  // Null is recoverable: after validation and exact deduplication, commit derives
  // missing overview sources from effective understanding records.
  // Explicit source selections still go through every validation below.
  if (output.overview !== null) {
    const value = output.overview;
    if (!ownKeysOnly(value, ['summary', 'memoryIds', 'createIndexes']) || typeof value.summary !== 'string'
      || value.summary.trim().length > 1200 || !Array.isArray(value.memoryIds) || !Array.isArray(value.createIndexes)) {
      throw new Error('用户概括结构无效或内容过长');
    }
    const ids = [...new Set(value.memoryIds)];
    const indexes = [...new Set(value.createIndexes)];
    if (ids.some(id => !nonblank(id) || !candidates.has(id) || candidates.get(id).kind !== 'understanding'
        || candidates.get(id).state === 'retracted' || retracted.has(id))) throw new Error('用户概括引用了非长期了解、已撤回或未知记忆');
    if (indexes.some(index => !Number.isSafeInteger(index) || index < 0 || result.creates[index]?.kind !== 'understanding')) {
      throw new Error('用户概括的新建来源索引无效');
    }
    const summary = value.summary.trim();
    if (Boolean(summary) !== Boolean(ids.length + indexes.length)) throw new Error('用户概括内容与来源引用不一致');
    result.overview = { summary, memoryIds: ids, createIndexes: indexes };
  }
  return result;
}

/** Build the model-facing payload and its private audit mapping together.
 * The mapping is deliberately separate from messages sent to the provider. */
export function memoryRequestFor(sourceMessages, timezone, context = {}) {
  const memoryIndex = context.memoryIndex ?? [];
  if (!Array.isArray(memoryIndex) || memoryIndex.length > 500) throw new Error('记忆候选须为最多 500 条的列表');
  const references = userReferencesFor(sourceMessages);
  const byId = new Map(references.map(item => [item.messageId, item.ref]));
  const dated = message => ({ text: message.text, sentAt: sentAt(message),
    localDate: toLocalTime(new Date(sentAt(message)), timezone).localDate });
  const assistantContext = [];
  let followingUserId = null;
  for (let index = sourceMessages.length - 1; index >= 0; index--) {
    const message = sourceMessages[index];
    if (message.role === 'user') followingUserId = byId.get(message.id) ?? null;
    else if (message.role === 'assistant' && followingUserId) {
      assistantContext.push({ beforeUserId: followingUserId, ...dated(message) });
    }
  }
  assistantContext.reverse();
  const messages = [
    { role: 'system', content: MEMORY_PROMPT },
    { role: 'user', content: JSON.stringify({
      timezone,
      referenceFormat: {
        userMessageIds: references.map(item => item.ref),
        userMessageIdFormat: 'U + 原会话中的用户发言序号',
        assistantContextLink: 'beforeUserId',
      },
      memoryIndex,
      overview: context.overview ?? { summary: '', memoryIds: [], version: 0 },
      revision: context.revision ?? 0,
      assistantContext,
      userMessages: sourceMessages.filter(message => message.role === 'user')
        .map(message => ({ id: byId.get(message.id), ...dated(message) })),
    }) },
  ];
  return { messages, responseFormat: formatForReferences(references), references };
}

export function memoryMessages(sourceMessages, timezone, context = {}) {
  return memoryRequestFor(sourceMessages, timezone, context).messages;
}
