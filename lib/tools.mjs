import { calculate } from './calculate.mjs';
import { validDate } from './memory.mjs';
import { validatePublicQuery } from './search.mjs';
import { normalizeReferenceImage } from './reference-images.mjs';

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
  tool('search_web', '回答所需的当前、最新或其他公开信息缺少可靠依据时，主动搜索核实，无需用户明确说查。同次搜索兼顾紧密相关的可能追问，后续优先复用会话中仍适用的结果。依据可核验来源的资料性质、地点和适用时间作答。只有视觉参考能帮助理解或用户要图时才请求配图；有可靠来源网页配图才附最多一张，没图照常答，不编图片 URL。每轮最多一次。', {
    query: { ...text, description: '围绕问题组织必要的公开主题、地点和时间线索，可合并紧密相关的后续关注点。' },
    limit: { type: 'integer', minimum: 1, maximum: 5 },
    includeImage: { type: 'boolean', description: '可选，默认 false。仅视觉参考有助理解或用户要求图片时为 true；来源网页配图仅供参考，不保证对应特定现场或照片。' },
  }, ['query']),
  tool('calculate', '需要精确算术结果时调用。', { expression: text }, ['expression']),
];
const BY_NAME = new Map(DEFINITIONS.map(definition => [definition.function.name, definition]));

export function availableTools(search) {
  return DEFINITIONS.filter(definition => definition.function.name !== 'search_web' || search?.configured);
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

export function makeToolRunner({ store, search, run, clock, signal }) {
  const available = new Set(availableTools(search).map(definition => definition.function.name));
  let searched = false;
  return async function execute(name, args, { onUsage, onReferenceImage } = {}) {
    if (!available.has(name)) return { status: 'unavailable' };
    try {
      validateKeys(name, args);
    } catch {
      return { status: 'invalid', error: '工具参数不符合已开放的结构' };
    }
    if (signal.aborted) return { status: 'unavailable' };
    switch (name) {
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
        catch { return { ok: false, expression: typeof args.expression === 'string' ? args.expression.slice(0, 160) : '', error: '算式无效或超出可计算范围' }; }
      case 'search_web': {
        if (searched) return { ok: false, error: '这轮已请求过联网搜索' };
        let attempted = false;
        try {
          const query = validatePublicQuery(args.query);
          const limit = args.limit ?? 3;
          const includeImage = args.includeImage === undefined ? false : args.includeImage;
          if (query.length < 2 || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 5
              || typeof includeImage !== 'boolean') {
            return { ok: false, error: '请提供有效的公开搜索词' };
          }
          const profile = store.profile(run.childId, run.agentId);
          const identifiers = [profile.childProfile?.name, profile.soulProfile.preferred_name]
            .map(value => typeof value === 'string' ? normalized(value) : '').filter(value => value.length > 1);
          if (identifiers.some(value => normalized(query).includes(value))) return { ok: false, error: '只可搜索公开主题' };
          searched = true;
          attempted = true;
          onUsage?.({ phase: 'start', model: search.metadata?.endpoint });
          const result = await search.search({ query, limit, includeImage, signal });
          onUsage?.({ phase: 'complete', receipt: result.receipt, metrics: result.metrics, model: search.metadata?.endpoint });
          const referenceImage = includeImage && result.metadata?.provenance === 'provider_url_citation'
            ? result.results.map(item => normalizeReferenceImage({
              imageUrl: item.cover_image?.url, sourceUrl: item.url, title: item.title,
              width: item.cover_image?.width, height: item.cover_image?.height,
            })).find(Boolean) : null;
          if (referenceImage) onReferenceImage?.(referenceImage);
          return {
            ok: true, query, untrusted: true, retrieved_at: result.metadata?.retrieved_at,
            results: result.results.map(({ title, url, snippet, published_at }) => ({
              title, url, ...(snippet ? { snippet } : {}), ...(published_at ? { published_at } : {}),
            })),
            // Image URLs stay in the application side channel, not in model
            // tool text, chat history or memory-extraction evidence.
            ...(includeImage ? { reference_image: { status: referenceImage ? 'available' : 'unavailable' } } : {}),
          };
        } catch (error) {
          if (attempted) onUsage?.({ phase: 'complete', receipt: error.receipt, model: search.metadata?.endpoint, status: 'failed' });
          return { ok: false, error: '目前没有查到可核验的联网结果' };
        }
      }
    }
  };
}
