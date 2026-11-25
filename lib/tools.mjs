import { calculate, CalculationError } from './calculate.mjs';
import { validDate } from './memory.mjs';
import { validatePublicQuery } from './search.mjs';
import { hasCharacterReferences, readCharacterReference } from './character-reference.mjs';

const text = { type: 'string' };
const tool = (name, description, properties, required) => ({
  type: 'function', function: {
    name, description,
    parameters: { type: 'object', additionalProperties: false, properties, required },
  },
});

const DEFINITIONS = [
  tool('find_mentor', '按当前发言和会话记录核对导师名册、可提供的帮助、推荐和留聊。', {
    query: { ...text, description: '本轮用户发言' },
  }, ['query']),
  tool('recall_memory', '当前资料不足以回应涉及用户的过往事实、偏好、关系、计划或进展时，主动按话题查找活跃及归档记忆摘要。宽泛问题也可查；摘要足够即可回答。', {
    query: { ...text, description: '按当前话题组织的检索线索，可用主题或计划方向，无需具体事件名。' },
    fromDate: { ...text, description: '可选，YYYY-MM-DD；限定实际聊到该记忆的起始日期，不是事情发生或计划执行日期。' },
    toDate: { ...text, description: '可选，YYYY-MM-DD；限定实际聊到该记忆的结束日期，不是事情发生或计划执行日期。' },
  }, ['query']),
  tool('get_memory_detail', '已找到摘要，仍需核对具体时间、最新状态或经过时，按摘要 ID 读取当前摘要、原始详情及明确标注的补充和更正。', {
    memoryId: { ...text, description: '已找到的记忆摘要所返回的 memoryId。' },
  }, ['memoryId']),
  tool('search_web', '孩子请你搜索或核对可检索的公开资料时调用，即使你知道答案或这轮还有其他需求。回答依赖当前、最新或缺少可靠依据的公开信息时也调用。孩子想辨认自己看到或遇到的具体东西，而本轮和前文缺少特征或内容时，先请孩子补充线索。后续优先复用会话中仍适用的结果。依据可核验来源的资料性质、地点和适用时间作答。每轮最多一次。', {
    query: { ...text, description: '围绕问题组织必要的公开主题、地点和时间线索，可合并紧密相关的后续关注点。' },
    limit: { type: 'integer', minimum: 1, maximum: 5 },
  }, ['query']),
  tool('calculate', '求出数值、代入公式或核对结果时调用。支持大整数、精确小数、括号、科学计数法、加减乘除、整数次幂、取余，以及自然对数 ln(x)、常用对数 log10(x) 和平方根 sqrt(x)。大数和小数可以字符串返回。approximate=true 表示结果是近似值，exactResult 存在时可引用精确分数。', { expression: text }, ['expression']),
  tool('read_character_reference', '只读当前人物随包保存的 Nuwa 原始资料。path=__index__列文件；references/casebook.md可用section=C05等章节前缀定位，startLine为文件绝对行号，lineCount每次最多120。不是用户记忆、联网或任意文件读取。', {
    path: text, section: text, startLine: { type: 'integer', minimum: 1 },
    lineCount: { type: 'integer', minimum: 1, maximum: 120 },
  }, ['path']),
];
const BY_NAME = new Map(DEFINITIONS.map(definition => [definition.function.name, definition]));

export function availableTools(search, agentId, mentorEnabled = false) {
  return DEFINITIONS.filter(definition => (definition.function.name !== 'search_web' || search?.configured) &&
    (definition.function.name !== 'find_mentor' || mentorEnabled) &&
    (definition.function.name !== 'read_character_reference' || hasCharacterReferences(agentId)));
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

export function makeToolRunner({ store, search, run, clock, signal, recommendMentor }) {
  const available = new Set(availableTools(search, run.agentId, Boolean(recommendMentor)).map(definition => definition.function.name));
  let searched = false;
  let mentorResult;
  return async function execute(name, args, { onUsage } = {}) {
    if (!available.has(name)) return { status: 'unavailable' };
    try {
      validateKeys(name, args);
    } catch {
      return { status: 'invalid', error: '工具参数不符合已开放的结构' };
    }
    if (signal.aborted) return { status: 'unavailable' };
    switch (name) {
      case 'find_mentor':
        mentorResult ??= recommendMentor(args.query, onUsage);
        return mentorResult;
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
