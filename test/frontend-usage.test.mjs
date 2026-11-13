import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the actual formatter and its adjacent pure dependencies. The app's
// DOM/network bootstrap is intentionally outside this slice.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function tokenCount(');
const end = source.indexOf('function usageIcon(', start);
assert.ok(start >= 0 && end > start, 'the app usage formatter source must be present');
const formatterSource = source.slice(start, end) + '\nusageMetricDetails;';
const metrics = (usage, selected = false) => runInNewContext(formatterSource, {
  hasScope: () => selected,
}, { filename: 'public/app.js:usageMetricDetails' })(usage);
const cost = result => result.find(metric => metric.key === 'cost');
const historicalFee = result => cost(result).rows.find(([label]) => label === '历史概括整理');
const recordedUsage = overrides => ({
  recordedCalls: 1,
  totalTokens: 1010,
  inputTokens: 1000,
  outputTokens: 10,
  cachedTokens: 0,
  reasoningTokens: 0,
  totalCostCny: 0.01,
  knownCostCny: 0.01,
  toolCostCny: 0,
  ...overrides,
});

test('empty initial usage renders before and after selecting a user', () => {
  for (const selected of [false, true]) {
    let result;
    assert.doesNotThrow(() => { result = metrics(null, selected); });
    assert.equal(result.map(metric => metric.key).join(','), 'context,tokens,cost');
    assert.ok(result.every(metric => metric.value === '—'));
    assert.equal(historicalFee(result), undefined);
    assert.match(result[0].note, selected ? /发送消息后/ : /选择用户和角色后/);
    assert.equal(cost(result).rows.find(([label]) => label === '合计')[1], '—');
  }
});

test('sessions without historical context-brief calls omit its fee row', () => {
  for (const calls of [undefined, [], [{ kind: 'chat', modelCostCny: 0.01 }]]) {
    const result = metrics(recordedUsage({ calls }));
    assert.equal(historicalFee(result), undefined);
    assert.equal(cost(result).value, '¥0.010000');
    assert.equal(cost(result).rows.find(([label]) => label === '合计')[1], '¥0.010000');
  }
});

test('historical context-brief costs stay visible and included in the total', () => {
  const calls = [
    { kind: 'chat', modelCostCny: 0.01 },
    { kind: 'memory', modelCostCny: 0.002 },
    { kind: 'context_brief', modelCostCny: 0.0005 },
    { kind: 'context_brief', modelCostCny: 0.0007 },
  ];
  const result = metrics(recordedUsage({ recordedCalls: calls.length, calls,
    totalCostCny: 0.0132, knownCostCny: 0.0132 }));
  assert.equal(historicalFee(result)?.[1], '¥0.001200');
  assert.equal(cost(result).value, '¥0.013200');
  assert.equal(cost(result).rows.find(([label]) => label === '合计')[1], '¥0.013200');
  assert.equal(cost(result).rows.find(([label]) => label === '聊天模型')[1], '¥0.010000');
  assert.equal(cost(result).rows.find(([label]) => label === '记忆模型')[1], '¥0.002000');
});
