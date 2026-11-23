import { calculate, CalculationError } from './calculate.mjs';
import { validDate } from './memory.mjs';
import { validatePublicQuery } from './search.mjs';
import { hasCharacterReferences, readCharacterReference } from './character-reference.mjs';
import { maxVideoDialogueCharacters, plannedVideoDuration } from './character-media.mjs';

const text = { type: 'string' };
const mediaFraming = { type: 'string', enum: ['selfie', 'subject'],
  description: 'selfie：角色入镜。subject：用后摄只拍物件、环境或结果。' };
const mediaScene = { ...text, description: '画面里可见的主体、地点和细节。' };
const mediaReferences = {
  type: 'array', minItems: 1, maxItems: 2,
  description: '可选。当前画面需要延续已发照片中的场景、物品或布局时填写。',
  items: {
    type: 'object', additionalProperties: false, required: ['id', 'keep'],
    properties: {
      id: { ...text, description: '背景资料中给出的已发照片编号。' },
      keep: { ...text, description: '这张照片里需要保留的可见细节。' },
    },
  },
};
const tool = (name, description, properties, required) => ({
  type: 'function', function: {
    name, description,
    parameters: { type: 'object', additionalProperties: false, properties, required },
  },
});

const DEFINITIONS = [
  tool('recall_memory', '当前资料不足以回应涉及用户的过往事实、偏好、关系、计划或进展时，主动按话题查找活跃及归档记忆摘要。宽泛问题也可查；摘要足够即可回答。', {
    query: { ...text, description: '按当前话题组织的检索线索，可用主题或计划方向，无需具体事件名。' },
    fromDate: { ...text, description: '可选，YYYY-MM-DD；限定实际聊到该记忆的起始日期，不是事情发生或计划执行日期。' },
    toDate: { ...text, description: '可选，YYYY-MM-DD；限定实际聊到该记忆的结束日期，不是事情发生或计划执行日期。' },
  }, ['query']),
  tool('get_memory_detail', '已找到摘要，仍需核对具体时间、最新状态或经过时，按摘要 ID 读取当前摘要、原始详情及明确标注的补充和更正。', {
    memoryId: { ...text, description: '已找到的记忆摘要所返回的 memoryId。' },
  }, ['memoryId']),
  tool('search_web', '回答所需的当前、最新或其他公开信息缺少可靠依据时，主动搜索核实，无需用户明确说查。同次搜索兼顾紧密相关的可能追问，后续优先复用会话中仍适用的结果。依据可核验来源的资料性质、地点和适用时间作答。每轮最多一次。', {
    query: { ...text, description: '围绕问题组织必要的公开主题、地点和时间线索，可合并紧密相关的后续关注点。' },
    limit: { type: 'integer', minimum: 1, maximum: 5 },
  }, ['query']),
  tool('calculate', '需要算术结果时调用，支持大整数、精确小数、括号、科学计数法、加减乘除和整数次幂。^ 是乘方，% 是取余。大数和小数以字符串返回，照原值使用；approximate=true 表示循环小数的近似值，exactResult 是精确分数。', { expression: text }, ['expression']),
  tool('read_character_reference', '只读当前人物随包保存的 Nuwa 原始资料。path=__index__列文件；references/casebook.md可用section=C05等章节前缀定位，startLine为文件绝对行号，lineCount每次最多120。不是用户记忆、联网或任意文件读取。', {
    path: text, section: text, startLine: { type: 'integer', minimum: 1 },
    lineCount: { type: 'integer', minimum: 1, maximum: 120 },
  }, ['path']),
  tool('send_character_photo', '分享一张角色当前生活场景的手机照片。', {
    framing: mediaFraming,
    scene: mediaScene,
    references: mediaReferences,
  }, ['framing', 'scene']),
  tool('send_character_video', '分享一段能看到动作、过程或听到现场声的手机短视频。', {
    framing: mediaFraming,
    scene: mediaScene,
    references: mediaReferences,
    motion: { ...text, description: '开场的一个自然单手动作。' },
    dialogue: { ...text, description: `可选台词，可画外说。最多 ${maxVideoDialogueCharacters} 字，不计标点和空格。` },
    ambience: { ...text, description: '可选环境底噪和动作声，如风声、杯碟声。背景没有其他人说话。' },
    duration: { type: 'integer', enum: [3, 4, 5], description: '动作需要的最短时长，后端可按台词延长。' },
  }, ['framing', 'scene', 'motion', 'duration']),
];
const BY_NAME = new Map(DEFINITIONS.map(definition => [definition.function.name, definition]));
export const characterMediaTools = { __proto__: null, send_character_photo: 'photo', send_character_video: 'video' };

export function availableTools(search, agentId, media, agent) {
  return DEFINITIONS.filter(({ function: { name } }) => {
    const kind = characterMediaTools[name];
    if (kind) return !!media?.available(kind, agent);
    return (name !== 'search_web' || search?.configured) &&
      (name !== 'read_character_reference' || hasCharacterReferences(agentId));
  });
}

function validateKeys(name, args) {
  const definition = BY_NAME.get(name)?.function.parameters;
  if (!definition || args == null || typeof args !== 'object' || Array.isArray(args) ||
      !Object.keys(args).every(key => Object.hasOwn(definition.properties, key)) ||
      !definition.required.every(key => Object.hasOwn(args, key))) {
    throw new Error('工具参数不符合已开放的结构');
  }
}
function boundedString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function makeToolRunner({ store, search, media, agent, run, clock, signal, photoReferences = [] }) {
  const referenceIds = new Map(photoReferences.map(photo => [photo.id, photo.assetId]));
  const available = new Set(availableTools(search, run.agentId, media, agent).map(definition => definition.function.name));
  let searched = false;
  let generatedMedia = false;
  return async function execute(name, args, { onUsage } = {}) {
    if (!available.has(name)) return { status: 'unavailable' };
    try {
      validateKeys(name, args);
    } catch {
      return { status: 'invalid', error: '工具参数不符合已开放的结构' };
    }
    if (signal.aborted) return { status: 'unavailable' };
    const kind = characterMediaTools[name];
    if (kind) {
      if (generatedMedia) return { ok: false, error: '本轮已请求一份角色影像' };
      if (!mediaFraming.enum.includes(args.framing) || !boundedString(args.scene, 600) ||
          (kind === 'video' && (!boundedString(args.motion, 400) || ![3, 4, 5].includes(args.duration) ||
            (args.dialogue !== undefined && args.dialogue !== '' && !boundedString(args.dialogue, 120)) ||
            (args.ambience !== undefined && args.ambience !== '' && !boundedString(args.ambience, 240))))) {
        return { ok: false, error: '请提供简短清晰的角色场景与动作' };
      }
      const duration = kind === 'video' ? plannedVideoDuration(args.duration, args.dialogue) : undefined;
      if (duration > 5) return { ok: false, error: `台词太长，请缩到 ${maxVideoDialogueCharacters} 字以内后再试` };
      const requested = args.references === undefined ? [] : args.references;
      if (!Array.isArray(requested) || requested.length > mediaReferences.maxItems ||
          requested.some(ref => !ref || Object.keys(ref).length !== 2 ||
            !referenceIds.has(ref.id) || !boundedString(ref.keep, 200)) ||
          new Set(requested.map(ref => ref.id)).size !== requested.length) {
        return { ok: false, error: '请选择本次会话中可用的照片，并说明要保留的细节' };
      }
      const references = requested.map(ref => ({ assetId: referenceIds.get(ref.id), keep: ref.keep.trim() }));
      generatedMedia = true;
      return media.generate(kind, { agent, framing: args.framing, scene: args.scene.trim(), motion: args.motion?.trim(), duration,
        actionDuration: args.duration, dialogue: args.dialogue?.trim(), ambience: args.ambience?.trim(),
        references, runId: run.runId, sessionId: run.sessionId, signal, onUsage });
    }
    switch (name) {
      case 'read_character_reference':
        return readCharacterReference(run.agentId, args);
      case 'recall_memory': {
        const { query, fromDate, toDate } = args;
        if (!boundedString(query, 200) || !normalized(query) ||
            (fromDate !== undefined && !validDate(fromDate)) || (toDate !== undefined && !validDate(toDate)) ||
            (fromDate && toDate && fromDate > toDate)) return { status: 'unavailable', items: [] };
        try { return store.recall(run.childId, run.agentId, { query: query.trim(), fromDate, toDate }); }
        catch { return { status: 'unavailable', items: [] }; }
      }
      case 'get_memory_detail': {
        if (!boundedString(args.memoryId, 80)) return { status: 'not_found' };
        try {
          const item = store.memoryDetail(args.memoryId, run.childId, run.agentId);
          return item && item.state !== 'retracted' ? { status: 'found', item } : { status: 'not_found' };
        } catch { return { status: 'unavailable' }; }
      }
      case 'calculate':
        try { return { ok: true, ...calculate(args.expression) }; }
        catch (error) { return { ok: false, expression: typeof args.expression === 'string' ? args.expression.slice(0, 1024) : '', error: error instanceof CalculationError ? error.message : '计算暂时失败，请稍后重试' }; }
      case 'search_web': {
        if (searched) return { ok: false, error: '这轮已请求过联网搜索' };
        let attempted = false;
        try {
          const query = validatePublicQuery(args.query);
          const limit = args.limit ?? 3;
          if (query.length < 2 || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 5) {
            return { ok: false, error: '请提供有效的公开搜索词' };
          }
          const profile = store.profile(run.childId, run.agentId);
          const identifiers = [profile.childProfile?.name, profile.soulProfile.preferred_name]
            .map(value => typeof value === 'string' ? normalized(value) : '').filter(value => value.length > 1);
          if (identifiers.some(value => normalized(query).includes(value))) return { ok: false, error: '只可搜索公开主题' };
          searched = true;
          attempted = true;
          onUsage?.({ phase: 'start', model: search.metadata?.endpoint });
          const result = await search.search({ query, limit, signal });
          onUsage?.({ phase: 'complete', receipt: result.receipt, metrics: result.metrics, model: search.metadata?.endpoint });
          return {
            ok: true, query, untrusted: true, retrieved_at: result.metadata?.retrieved_at,
            results: result.results.map(({ title, url, snippet, published_at }) => ({
              title, url, ...(snippet ? { snippet } : {}), ...(published_at ? { published_at } : {}),
            })),
          };
        } catch (error) {
          if (attempted) onUsage?.({ phase: 'complete', receipt: error.receipt, model: search.metadata?.endpoint, status: 'failed' });
          return { ok: false, error: '目前没有查到可核验的联网结果' };
        }
      }
    }
  };
}
