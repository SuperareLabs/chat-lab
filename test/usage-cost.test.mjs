import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateUsage, getModelContext } from '../lib/usage-cost.mjs';

const economy = 'deepseek-v4-1-flash-economy-261017';
const mini = 'doubao-seed-2-0-mini-260428';
const usage = (input, output, cached = 0, reasoning = 0) => ({
  prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
  prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: reasoning },
});

test('economy rates use completion time in Beijing and charge cached/reasoning subsets once', () => {
  const peak = estimateUsage({ model: economy, usage: usage(1000, 200, 500, 150), serviceTier: 'default', at: '2026-11-12T01:00:00Z' });
  assert.equal(peak.rates.period, 'peak');
  assert.equal(peak.modelCostCny, .002096);
  assert.equal(peak.totalTokens, 1200);
  assert.equal(peak.reasoningTokens, 150);
  const lunch = estimateUsage({ model: economy, usage: usage(1000, 200, 500), serviceTier: 'default', at: '2026-11-12T04:00:00Z' });
  assert.equal(lunch.rates.period, 'idle');
  assert.equal(lunch.modelCostCny, peak.modelCostCny / 2);
  const afternoon = estimateUsage({ model: economy, usage: usage(1000, 0), at: '2026-11-12T06:00:00Z' });
  assert.equal(afternoon.rates.period, 'peak');
  const evening = estimateUsage({ model: economy, usage: usage(1000, 0), at: '2026-11-12T10:00:00Z' });
  assert.equal(evening.rates.period, 'idle');
  const weekend = estimateUsage({ model: economy, usage: usage(1000, 0), at: '2026-11-14T02:00:00Z' });
  assert.equal(weekend.rates.period, 'idle');
});

test('mini tiers use the full input including cached tokens and honor service modes', () => {
  const normal = estimateUsage({ model: mini, usage: usage(32768, 1000, 10000), serviceTier: 'default' });
  assert.equal(normal.rates.inputPerMillion, .2);
  assert.equal(normal.modelCostCny, .0069536);
  const nextBand = estimateUsage({ model: mini, usage: usage(32769, 1000, 32768), serviceTier: 'default' });
  assert.equal(nextBand.rates.inputPerMillion, .4);
  assert.equal(nextBand.modelCostCny, .00662184);
  const highBand = estimateUsage({ model: mini, usage: usage(131073, 0), serviceTier: 'default' });
  assert.equal(highBand.rates.outputPerMillion, 8);
  const fast = estimateUsage({ model: mini, usage: usage(32768, 1000, 10000), serviceTier: 'fast' });
  assert.equal(fast.modelCostCny, normal.modelCostCny * 2);
  const flex = estimateUsage({ model: mini, usage: usage(32768, 1000, 10000), serviceTier: 'flex' });
  assert.equal(flex.rates.inputPerMillion, .1);
  assert.equal(flex.rates.cachedInputPerMillion, .04);
  assert.equal(flex.modelCostCny, .0036768);
});

test('Responses search costs retain actual plugin usage and exclude account free allowances', () => {
  const raw = {
    input_tokens: 5000, output_tokens: 100, total_tokens: 5100,
    input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 0 },
    tool_usage: { web_search: 2 }, tool_usage_details: { web_search: { search_engine: 2 } },
  };
  const value = estimateUsage({ model: mini, usage: raw, serviceTier: 'auto', kind: 'search' });
  assert.equal(value.modelCostCny, .00104);
  assert.equal(value.searchCalls, 2);
  assert.equal(value.toolCostCny, .008);
  assert.equal(value.totalCostCny, .00904);
  assert.match(value.basis, /未扣每月免费额度/);
  assert.match(value.basis, /未抵扣 TPM/);
  assert.equal(value.usageStatus, 'reported');
  const sources = estimateUsage({ model: mini, usage: { ...raw, tool_usage_details: { web_search: { search_engine: 1, toutiao: 1 } } }, kind: 'search' });
  assert.equal(sources.toolCostCny, .01);
  const emptySources = estimateUsage({ model: mini, usage: { ...raw, tool_usage_details: { web_search: {} } }, kind: 'search' });
  assert.equal(emptySources.toolCostCny, .008, 'missing source details must not turn a known plugin count into zero cost');
  const unknownSources = estimateUsage({ model: mini, usage: { ...raw, tool_usage_details: { web_search: { unknown_source: 1 } } }, kind: 'search' });
  assert.equal(unknownSources.toolCostCny, null);
});

test('missing or unpriced model usage stays unknown while known plugin cost can be retained', () => {
  const missing = estimateUsage({ model: mini, kind: 'search' });
  assert.equal(missing.inputTokens, null);
  assert.equal(missing.modelCostCny, null);
  assert.equal(missing.toolCostCny, null);
  assert.equal(missing.totalCostCny, null);
  assert.equal(missing.usageStatus, 'missing');
  const partial = estimateUsage({ model: mini, kind: 'search', searchCalls: 1 });
  assert.equal(partial.modelCostCny, null);
  assert.equal(partial.toolCostCny, .004);
  assert.equal(partial.totalCostCny, null);
  assert.equal(partial.pricingStatus, 'partial');
  const unknown = estimateUsage({ model: 'custom-model', usage: usage(1000, 20) });
  assert.equal(unknown.totalTokens, 1020);
  assert.equal(unknown.modelCostCny, null);
  assert.equal(unknown.pricingStatus, 'unpriced');
  const unsupported = estimateUsage({ model: economy, usage: usage(1000, 20), serviceTier: 'flex' });
  assert.equal(unsupported.modelCostCny, null);
  const invalid = estimateUsage({ model: mini, usage: usage(10, 20, 100) });
  assert.equal(invalid.modelCostCny, null);
  assert.equal(invalid.usageStatus, 'invalid');
});

test('local tools have no incremental external fee and context size is separate from accumulated use', () => {
  const local = estimateUsage({ kind: 'local_tool' });
  assert.equal(local.totalCostCny, 0);
  assert.equal(local.usageStatus, 'not_applicable');
  assert.equal(getModelContext(economy).contextWindowTokens, 1048576);
  assert.equal(getModelContext(mini).maxInputTokens, 229376);
  assert.equal(getModelContext('unknown'), null);
});
