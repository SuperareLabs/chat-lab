// Official list-price estimates, not account bills. Update the tariff snapshot
// when prices change; stored ledger entries retain their own rate snapshot.
export const PRICE_AS_OF = '2026-11-12';
export const MODEL_PRICE_SOURCE = 'https://docs.volcengine.com/docs/ark/model-pricing?lang=zh';
export const SEARCH_PRICE_SOURCE = 'https://docs.volcengine.com/docs/ark/online-content-plugin-pricing?lang=zh';
export const MODEL_CONTEXT_SOURCE = 'https://docs.volcengine.com/docs/ark/model-list?lang=zh';
export const MODEL_TIER_SOURCE = 'https://docs.volcengine.com/docs/ark/get-model-activation-api?lang=zh';

const ECONOMY = 'deepseek-v4-1-flash-economy-261017';
const FLASH = 'deepseek-v4-1-flash-261017';
const MINI = 'doubao-seed-2-0-mini-260428';
const LITE = 'doubao-seed-2-1-lite-260915';
// GetModelActivation's official pricing example explicitly maps its 0–32K
// tier to MaxPromptTokens=32768; money's per-million denominator stays decimal.
const K = 1024;
const million = 1_000_000;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const firstInteger = (...values) => values.map(integer).find(value => value !== null) ?? null;
const rounded = value => Math.round(value * 1e12) / 1e12;
const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function beijingPeriod(at) {
  const date = at == null ? null : new Date(at);
  if (!date || !Number.isFinite(date.valueOf())) return null;
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map(part => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday);
  return weekday && ((minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60))
    ? 'peak' : 'idle';
}

export function getModelContext(model) {
  let contextWindowTokens;
  let maxInputTokens;
  if ([ECONOMY, FLASH, LITE].includes(model)) {
    contextWindowTokens = 1024 * K;
    maxInputTokens = 1024 * K;
  } else if (model === MINI) {
    contextWindowTokens = 256 * K;
    maxInputTokens = 224 * K;
  } else return null;
  return {
    contextWindowTokens, maxInputTokens,
    label: `${contextWindowTokens / K}K`,
    basis: '官方标注窗口，展示按 1K=1024 token 折算；实际可用输入还需预留输出空间',
    asOf: PRICE_AS_OF, sources: [MODEL_CONTEXT_SOURCE],
  };
}

function normalizeUsage(usage, kind, suppliedSearchCalls) {
  const source = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : null;
  const inputTokens = firstInteger(source?.prompt_tokens, source?.input_tokens);
  const outputTokens = firstInteger(source?.completion_tokens, source?.output_tokens);
  const reportedTotal = integer(source?.total_tokens);
  const totalTokens = reportedTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cachedTokens = firstInteger(source?.prompt_tokens_details?.cached_tokens, source?.input_tokens_details?.cached_tokens);
  const reasoningTokens = firstInteger(source?.completion_tokens_details?.reasoning_tokens, source?.output_tokens_details?.reasoning_tokens);
  const sourceCounts = source?.tool_usage_details?.web_search;
  const sourceEntries = sourceCounts && typeof sourceCounts === 'object' && !Array.isArray(sourceCounts)
    ? Object.entries(sourceCounts).filter(([, value]) => integer(value) !== null) : [];
  const sourceUsage = sourceEntries.length ? Object.fromEntries(sourceEntries) : null;
  const resourceTotal = sourceUsage ? Object.values(sourceUsage).reduce((sum, value) => sum + value, 0) : null;
  const searchCalls = firstInteger(source?.tool_usage?.web_search, suppliedSearchCalls, resourceTotal)
    ?? (kind === 'search' ? null : 0);
  const badCache = cachedTokens !== null && inputTokens !== null && cachedTokens > inputTokens;
  const badTotal = inputTokens !== null && outputTokens !== null && reportedTotal !== null && reportedTotal !== inputTokens + outputTokens;
  const badReasoning = reasoningTokens !== null && outputTokens !== null && reasoningTokens > outputTokens;
  return {
    inputTokens, outputTokens, totalTokens, cachedTokens, reasoningTokens, searchCalls, sourceUsage,
    audioTokens: firstInteger(source?.prompt_tokens_details?.audio_tokens, source?.input_tokens_details?.audio_tokens),
    audioCachedTokens: firstInteger(source?.prompt_tokens_details?.audio_cached_tokens, source?.input_tokens_details?.audio_cached_tokens),
    usageStatus: !source ? 'missing' : badCache || badTotal || badReasoning ? 'invalid'
      : inputTokens === null || outputTokens === null ? 'partial' : 'reported',
  };
}

function modelRate(model, inputTokens, serviceTier, at, notes) {
  const tier = serviceTier || 'default';
  if (!serviceTier) notes.push('未返回服务档位，按常规刊例价估算');
  if (tier === 'auto' || tier === 'scale') notes.push('按常规刊例价估算，未抵扣 TPM 保障包或账户优惠');
  if (!['default', 'auto', 'scale', 'fast', 'flex'].includes(tier)) return null;
  if (model === ECONOMY || model === FLASH) {
    // Economy has no published fast/flex row in the current price table.
    if (tier === 'fast' || (model === ECONOMY && tier === 'flex')) return null;
    let period = beijingPeriod(at);
    if (!period) {
      period = 'peak';
      notes.push('缺少有效完成时间，按高峰刊例价估算');
    }
    const factor = model === ECONOMY ? .8 : 1;
    const multiplier = period === 'peak' ? 2 : 1;
    const input = tier === 'flex' && period === 'peak' ? 1 : factor * multiplier;
    const output = tier === 'flex' && period === 'peak' ? 4 : factor * multiplier * 4;
    return { inputPerMillion: input, cachedInputPerMillion: factor * multiplier * .02,
      outputPerMillion: output, mode: tier === 'flex' ? 'flex' : 'standard', period, inputBand: '0–1024K' };
  }
  let input;
  let cached;
  let output;
  let inputBand;
  if (model === MINI) {
    if (inputTokens > 256 * K) return null;
    const band = inputTokens <= 32 * K ? 0 : inputTokens <= 128 * K ? 1 : 2;
    input = [.2, .4, .8][band];
    cached = [.04, .08, .16][band];
    output = [2, 4, 8][band];
    inputBand = ['0–32K', '32–128K', '128–256K'][band];
  } else if (model === LITE) {
    if (inputTokens > 1024 * K) return null;
    input = .8;
    cached = .16;
    output = 2.7;
    inputBand = '0–1024K';
  } else return null;
  if (tier === 'fast') { input *= 2; cached *= 2; output *= 2; }
  if (tier === 'flex') { input *= .5; output *= .5; }
  return { inputPerMillion: input, cachedInputPerMillion: cached, outputPerMillion: output,
    mode: tier === 'fast' ? 'fast' : tier === 'flex' ? 'flex' : 'standard', period: null, inputBand,
    inputBandMaximumTokens: model === MINI ? (inputTokens <= 32 * K ? 32 * K : inputTokens <= 128 * K ? 128 * K : 256 * K) : 1024 * K };
}

function pluginEstimate(normalized, kind, notes) {
  if (kind !== 'search' && !normalized.searchCalls && !normalized.sourceUsage) return 0;
  notes.push('联网插件按刊例毛费用估算，未扣每月免费额度、优惠或账户抵扣');
  const rates = { search_engine: .004, toutiao: .006, douyin: .006, moji: .006 };
  if (normalized.sourceUsage) {
    const entries = Object.entries(normalized.sourceUsage);
    if (entries.some(([source]) => !Object.hasOwn(rates, source))) return null;
    return rounded(entries.reduce((sum, [source, count]) => sum + rates[source] * count, 0));
  }
  if (normalized.searchCalls === null) return null;
  // The current search adapter is explicitly restricted to search_engine.
  notes.push('未返回来源明细，按当前配置 search_engine 的实际调用次数估算');
  return rounded(normalized.searchCalls * rates.search_engine);
}

/** All counts come from receipts, never from characters. Reasoning and cached
 * tokens are subsets and must not be added to output/input a second time. */
export function estimateUsage({ model = null, usage = null, serviceTier = null, at = null, kind = 'chat', searchCalls } = {}) {
  if (kind === 'local_tool') return {
    model: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0,
    searchCalls: 0, modelCostCny: 0, toolCostCny: 0, totalCostCny: 0, knownCostCny: 0,
    usageStatus: 'not_applicable', pricingStatus: 'not_applicable', rates: null,
    basis: '本地工具无额外外部调用费；模型组织回复的 token 已计入聊天模型用量',
    asOf: PRICE_AS_OF, sources: [],
  };
  const normalized = normalizeUsage(usage, kind, searchCalls);
  const notes = ['人民币刊例价预估，实际费用以方舟账单为准；不含独立缓存存储费用'];
  const rate = normalized.inputTokens === null ? null : modelRate(model, normalized.inputTokens, serviceTier, at, notes);
  const textOnly = !normalized.audioTokens && !normalized.audioCachedTokens;
  if (!textOnly) notes.push('收到音频输入用量，当前模块只配置文本计价，模型费用未估算');
  if (normalized.cachedTokens === null && normalized.inputTokens !== null) notes.push('缺少缓存明细，按未命中缓存估算');
  const cache = normalized.cachedTokens ?? 0;
  const modelCostCny = rate && textOnly && normalized.inputTokens !== null && normalized.outputTokens !== null && normalized.usageStatus !== 'invalid'
    ? rounded(((normalized.inputTokens - cache) * rate.inputPerMillion + cache * rate.cachedInputPerMillion
      + normalized.outputTokens * rate.outputPerMillion) / million) : null;
  const toolCostCny = pluginEstimate(normalized, kind, notes);
  if (modelCostCny === null) notes.push(normalized.usageStatus === 'missing' || normalized.usageStatus === 'partial'
    ? '缺少完整模型用量，未用字符数推算 token 或费用' : '该模型、服务档位或用量未能匹配当前价目，模型费用未估算');
  const totalCostCny = modelCostCny !== null && toolCostCny !== null ? rounded(modelCostCny + toolCostCny) : null;
  const known = [modelCostCny, toolCostCny].filter(value => value !== null);
  const pricingStatus = totalCostCny !== null ? 'estimated' : known.some(value => value > 0) ? 'partial'
    : normalized.usageStatus === 'missing' || normalized.usageStatus === 'partial' ? 'missing_usage' : 'unpriced';
  const { sourceUsage, audioTokens, audioCachedTokens, ...counts } = normalized;
  return {
    model, ...counts, modelCostCny, toolCostCny, totalCostCny,
    knownCostCny: known.length ? rounded(known.reduce((sum, value) => sum + value, 0)) : null,
    pricingStatus, rates: rate, basis: notes.join('；'), asOf: PRICE_AS_OF,
    sources: [MODEL_PRICE_SOURCE, ...(model === MINI ? [MODEL_TIER_SOURCE] : []),
      ...(kind === 'search' || normalized.searchCalls > 0 ? [SEARCH_PRICE_SOURCE] : [])],
  };
}
