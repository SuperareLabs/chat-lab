import { calculate, CalculationError } from './calculate.mjs';
import { validDate } from './memory.mjs';
import { validatePublicQuery } from './search.mjs';
import { hasCharacterReferences, readCharacterReference } from './character-reference.mjs';
import { photoReferenceMessages, photoReferenceSelection, readSharePhotoPlan, sharePhotoMessages, sharePhotoProperties,
  sharePhotoRequired, sharePhotoScene } from './share-photo.mjs';

import { readShareVideoPlan, shareVideoDescription, shareVideoMessages, shareVideoProperties, shareVideoRequired } from './share-video.mjs';

const text = { type: 'string' };
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
  tool('share_photo', '对方想看照片或需要展示角色、物件、宠物、环境或风景的静态画面时，分享一张手机照片。',
    sharePhotoProperties, sharePhotoRequired),
  tool('share_video', '对方想看视频或需要展示角色、物件、宠物、环境的动态、过程或现场声音时，分享一段手机视频。',
    shareVideoProperties, shareVideoRequired),
];
const BY_NAME = new Map(DEFINITIONS.map(definition => [definition.function.name, definition]));
export const characterMediaTools = { __proto__: null, share_photo: 'photo', share_video: 'video' };

function isJSONObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function requestMediaObject(requestPlan, messages, purpose) {
  const { response, modelRequest } = await requestPlan(messages, purpose);
  modelRequest.replyFormat = 'invalid';
  if (response.receipt?.finish_reason === 'length' || response.toolCalls?.length ||
      typeof response.content !== 'string' || response.content.length > 16_000) return null;
  let result = JSON.parse(response.content);
  if (!isJSONObject(result)) return null;
  if (result.type === 'json_object' && Object.keys(result).length === 2) {
    result = typeof result.content === 'string' ? JSON.parse(result.content) : result.content;
    if (!isJSONObject(result)) return null;
  }
  modelRequest.replyFormat = purpose.endsWith('-reference-decision') ? purpose : 'character-media-arguments';
  return result;
}

export async function runScriptedCharacterMedia({ tool, system, conversation, localTime, photoReferences, hasPortrait,
  runId, signal, requestPlan, execute }) {
  const { name } = tool.function;
  const kind = characterMediaTools[name];
  let argumentsJSON = '';
  try {
    let selected = [];
    if (photoReferences.length) {
      const decision = await requestMediaObject(requestPlan, photoReferenceMessages({ system, conversation, photoReferences, kind }),
        `${kind}-reference-decision`);
      signal.throwIfAborted();
      selected = photoReferenceSelection(decision?.references, new Set(photoReferences.map(photo => photo.id)));
      if (!selected || decision.needs_reference_image !== Boolean(selected.length)) throw new Error('无效的参考图判断');
    }
    const selectedPhotos = selected.map(reference => ({ ...photoReferences.find(photo => photo.id === reference.id), keep: reference.keep }));
    const planningMessages = kind === 'video' ? shareVideoMessages : sharePhotoMessages;
    const input = planningMessages({ system, conversation, localTime, hasPortrait, photoReferences: selectedPhotos, tool: tool.function });
    const plan = await requestMediaObject(requestPlan, input, 'character-media-plan');
    if (plan) argumentsJSON = JSON.stringify({ ...plan, references: selected });
  } catch { /* An invalid plan follows the existing media failure response. */ }
  signal.throwIfAborted();
  const call = { id: 'media-plan-' + runId, type: 'function', function: { name, arguments: argumentsJSON } };
  return execute([call], { scripted: true });
}

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

export function makeToolRunner({ store, search, media, agent, run, clock, signal, photoReferences = [],
  tools = availableTools(search, run.agentId, media, agent) }) {
  const referenceIds = new Map(photoReferences.map(photo => [photo.id, photo.assetId]));
  const available = new Set(tools.map(definition => definition.function.name));
  let searched = false;
  let generatedMedia = false;
  return async function execute(name, args, { onUsage, onPrompt, onDescription } = {}) {
    if (!available.has(name)) return { status: 'unavailable' };
    if (name === 'share_photo' && args?.should_send_image === false) return { ok: false, error: '本轮没有生成照片' };
    if (name === 'share_video' && args?.should_send_video === false) return { ok: false, error: '本轮没有生成视频' };
    try {
      validateKeys(name, args);
    } catch {
      return { status: 'invalid', error: '工具参数不符合已开放的结构' };
    }
    if (signal.aborted) return { status: 'unavailable' };
    const kind = characterMediaTools[name];
    if (kind) {
      if (generatedMedia) return { ok: false, error: '本轮已请求一份角色影像' };
      if (kind === 'photo') {
        const photoPlan = readSharePhotoPlan(args, referenceIds);
        if (!photoPlan) return { ok: false, error: '照片机位、主体或参考图参数不匹配' };
        generatedMedia = true;
        const scene = sharePhotoScene(args);
        onDescription?.({ scene });
        return media.generate(kind, { agent, photoPlan, scene, framing: photoPlan.includePortrait ? 'selfie' : 'subject',
          references: photoPlan.references.map(({ id, keep }) => ({ assetId: referenceIds.get(id), keep })),
          runId: run.runId, sessionId: run.sessionId, signal, onUsage, onPrompt });
      }
      const invalidFields = [];
      const videoPlan = readShareVideoPlan(args, referenceIds, invalidFields);
      if (!videoPlan) return { ok: false, error: `视频参数不匹配（${invalidFields.join('、')}）` };
      generatedMedia = true;
      const description = shareVideoDescription(args);
      onDescription?.(description);
      return media.generate(kind, { agent, videoPlan, ...description,
        references: videoPlan.references.map(({ id, keep }) => ({ assetId: referenceIds.get(id), keep })),
        runId: run.runId, sessionId: run.sessionId, signal, onUsage, onPrompt });
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
