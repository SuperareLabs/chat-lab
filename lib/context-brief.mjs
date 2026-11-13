import { createHash } from 'node:crypto';

export const CONTEXT_BRIEF_VERSION = 1;
export const CONTEXT_BRIEF_PROMPT = `你负责为聊天上下文选择简洁的用户概括来源。输入 records 全是已有的有效长期了解，不改写、补充或删除原记忆。
将信息完整覆盖的重复条目分为一组，选择信息完整且简洁的一条作为 representativeId；memberIds 包含这组所有来源。互补、有独立信息或互相矛盾的条目分别保留。保留人物归属、否定关系和时间条件；不能仅凭记录时间推断目标已经完成或偏好已经失效。
主题相同不代表信息被覆盖；具体引号短语、作品名、数字范围及否定约束都是独立信息，代表摘要没有保留时分开成组。
category 按内容选 background（身份与个人背景）、preferences（喜好、常玩内容与风格偏好）、goals（持续目标与学习计划）、interaction（称呼、沟通和相处方式）、other（其他）。先消除完整覆盖的冗余，再把所有独立信息分组，按默认相处时的有用程度排序；以完整保留独立信息为优先。通用目标只有被更具体的同一目标完整包含时，才放进该代表的 memberIds。
后端展示来源完整摘要，总预算1200字符；能放下的独立信息全部展示，预算不足时才按优先顺序延后。deferredIds 仅保存预算后备的低优先来源，后端仍会在剩余预算中追加，原记录始终可按需查询。
每个输入 ID 恰好属于一个组的 memberIds 或 deferredIds，代表 ID 必须属于本组。仅输出来源编号，不输出新正文。
只返回 JSON：{"groups":[{"category":"goals","representativeId":"S1","memberIds":["S1"]}],"deferredIds":[]}。`;

const CATEGORIES = ['background', 'preferences', 'goals', 'interaction', 'other'];
const LABELS = { background: '背景', preferences: '偏好', goals: '目标', interaction: '相处方式', other: '其他了解' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && !!value.trim();
const keysOnly = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));

function sourcesFor(records) {
  if (!Array.isArray(records)) throw new Error('概括投影需要长期了解来源列表');
  const seen = new Set();
  const sources = records.map(record => {
    if (!plain(record) || !nonblank(record.id) || !nonblank(record.summary)
        || record.kind !== 'understanding' || record.state !== undefined && !['active', 'archived'].includes(record.state)) {
      throw new Error('概括投影来源须为有效长期了解');
    }
    if (seen.has(record.id)) throw new Error('概括投影来源 ID 重复');
    seen.add(record.id);
    return { id: record.id, summary: record.summary.trim(), kind: 'understanding' };
  });
  return sources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function briefFingerprint(records, { modelName = '' } = {}) {
  const sources = sourcesFor(records);
  return createHash('sha256').update(JSON.stringify({ version: CONTEXT_BRIEF_VERSION,
    prompt: CONTEXT_BRIEF_PROMPT, modelName, records: sources })).digest('hex');
}

export function briefRequestFor(records) {
  const sources = sourcesFor(records);
  if (!sources.length) return null;
  const input = sources.map((record, index) => ({ id: `S${index + 1}`, summary: record.summary }));
  const ref = { type: 'string', enum: input.map(record => record.id) };
  const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
  return {
    messages: [{ role: 'system', content: CONTEXT_BRIEF_PROMPT },
      { role: 'user', content: JSON.stringify({ records: input }) }],
    responseFormat: { type: 'json_schema', json_schema: { name: 'context_brief_selection_v1', strict: true,
      schema: object({ groups: { type: 'array', items: object({ category: { type: 'string', enum: [...CATEGORIES] },
        representativeId: ref, memberIds: { type: 'array', items: ref } }, ['category', 'representativeId', 'memberIds']) },
      deferredIds: { type: 'array', items: ref } }, ['groups', 'deferredIds']) } },
  };
}

function selectionFor(output, sources, resolve) {
  if (!keysOnly(output, ['groups', 'deferredIds']) || !Array.isArray(output.groups) || !Array.isArray(output.deferredIds)) {
    throw new Error('概括投影须返回 groups 与 deferredIds');
  }
  const known = new Set(sources.map(record => record.id));
  const used = new Set();
  const read = raw => {
    const id = resolve(raw);
    if (!nonblank(id) || !known.has(id)) throw new Error('概括投影引用了未知来源');
    return id;
  };
  const own = raw => {
    const id = read(raw);
    if (used.has(id)) throw new Error('概括投影来源被重复分配');
    used.add(id);
    return id;
  };
  const groups = output.groups.map(group => {
    if (!keysOnly(group, ['category', 'representativeId', 'memberIds']) || !CATEGORIES.includes(group.category)
        || !Array.isArray(group.memberIds) || !group.memberIds.length) throw new Error('概括投影分组结构无效');
    const representativeId = read(group.representativeId);
    const memberIds = group.memberIds.map(own);
    if (!memberIds.includes(representativeId)) throw new Error('概括投影代表来源须属于本组');
    return { category: group.category, representativeId, memberIds };
  });
  const deferredIds = output.deferredIds.map(own);
  if (used.size !== known.size) throw new Error('概括投影遗漏了来源分配');
  return { groups, deferredIds };
}

const literalText = text => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const statementText = text => literalText(text).replace(/[，,。.!！?？、;；:：“”‘’「」『』《》"']/gu, '');

function quotedAnchors(text) {
  const values = [];
  const pattern = /“([^”]+)”|‘([^’]+)’|「([^」]+)」|『([^』]+)』|《([^》]+)》|"([^"\r\n]+)"|'([^'\r\n]+)'/gu;
  for (const match of text.matchAll(pattern)) {
    const value = match.slice(1).find(part => part !== undefined);
    if (value?.trim()) values.push(literalText(value));
  }
  return values;
}

function numericAnchors(text) {
  const normalized = literalText(text).replace(/[—–~～]/gu, '-').replace(/(?<=\d)(?:至|到)(?=\d)/gu, '-');
  return new Set(normalized.match(/[+-]?\d+(?:\.\d+)?(?:-[+-]?\d+(?:\.\d+)?)?%?/gu) ?? []);
}

function canCoverLiteralConstraints(member, representative) {
  const target = literalText(representative);
  if (quotedAnchors(member).some(anchor => !target.includes(anchor))) return false;
  const targetNumbers = numericAnchors(representative);
  if ([...numericAnchors(member)].some(anchor => !targetNumbers.has(anchor))) return false;
  const hasNegation = /不|没|未|勿|无|拒绝|避免|\b(?:not|no|never|without|cannot)\b|\b[a-z]+n['’]t\b/iu.test(member);
  return !hasNegation || statementText(representative).includes(statementText(member));
}

/** A reference-valid grouping still need not preserve every fact. Keep
 * explicit literal constraints visible when the proposed representative lacks
 * them; this only splits groups and never rewrites or deletes source content. */
function preserveLiteralConstraints(selection, sources) {
  const byId = new Map(sources.map(source => [source.id, source]));
  const groups = selection.groups.flatMap(group => {
    const representative = byId.get(group.representativeId).summary;
    const separated = group.memberIds.filter(id => id !== group.representativeId
      && !canCoverLiteralConstraints(byId.get(id).summary, representative));
    if (!separated.length) return [group];
    const separateIds = new Set(separated);
    return [{ ...group, memberIds: group.memberIds.filter(id => !separateIds.has(id)) },
      ...separated.map(id => ({ category: group.category, representativeId: id, memberIds: [id] }))];
  });
  return { groups, deferredIds: [...selection.deferredIds] };
}

export function validateBriefOutput(content, records) {
  const sources = sourcesFor(records);
  const refs = new Map(sources.map((record, index) => [`S${index + 1}`, record.id]));
  const output = typeof content === 'string' ? JSON.parse(content) : structuredClone(content);
  return preserveLiteralConstraints(selectionFor(output, sources, value => refs.get(value)), sources);
}

/** Render existing complete summaries only. This projection never changes the
 * underlying memory records or treats cache reads as actual user mentions. */
export function renderContextBrief(selection, records, { budget = 1200 } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('概括投影预算须为非负整数');
  const sources = sourcesFor(records);
  const chosen = preserveLiteralConstraints(selectionFor(selection ?? { groups: sources.map(source => ({ category: 'other',
    representativeId: source.id, memberIds: [source.id] })), deferredIds: [] }, sources, value => value), sources);
  // A model may defer independent facts even while the context has ample
  // room. Treat these as lower-priority candidates, not invisible records.
  const candidates = [...chosen.groups, ...chosen.deferredIds.map(id => ({ category: 'other',
    representativeId: id, memberIds: [id] }))];
  const byId = new Map(sources.map(record => [record.id, record]));
  const textFor = groups => {
    const lines = [];
    let category;
    for (const group of groups) {
      if (category !== group.category) lines.push(`【${LABELS[group.category]}】`);
      lines.push(byId.get(group.representativeId).summary);
      category = group.category;
    }
    return lines.join('\n');
  };
  const noticeFor = count => `另有${count}条长期了解可按需查询。`;
  const full = textFor(candidates);
  // Reserve a small omission notice when not everything can be displayed.
  // For tiny budgets a complete first fact takes precedence over that notice.
  const allFits = full.length <= budget;
  const reserve = !allFits && sources.length ? noticeFor(sources.length).length + 1 : 0;
  const fit = capacity => {
    const groups = [];
    for (const group of candidates) if (textFor([...groups, group]).length <= capacity) groups.push(group);
    return groups;
  };
  let groups = fit(Math.max(0, budget - reserve));
  if (!groups.length && candidates.length) groups = fit(budget);
  const coveredMemoryIds = groups.flatMap(group => group.memberIds);
  const covered = new Set(coveredMemoryIds);
  const deferredMemoryIds = sources.filter(record => !covered.has(record.id)).map(record => record.id);
  let summary = textFor(groups);
  if (deferredMemoryIds.length) {
    const notice = noticeFor(deferredMemoryIds.length);
    if (summary.length + (summary ? 1 : 0) + notice.length <= budget) summary += (summary ? '\n' : '') + notice;
  }
  return { summary, memoryIds: groups.map(group => group.representativeId), coveredMemoryIds,
    deferredMemoryIds, groups: structuredClone(groups), sourceCount: sources.length, itemCount: groups.length };
}
