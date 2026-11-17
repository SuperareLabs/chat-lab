import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, CalculationError } from '../lib/calculate.mjs';
import { makeToolRunner } from '../lib/tools.mjs';

test('calculator returns screenshot product and integers beyond JS safe range exactly', () => {
  assert.equal(calculate('210380192*2791387').result, 587252533006304);
  assert.equal(calculate('9007199254740993 + 2').result, '9007199254740995');
  assert.equal(calculate('12345678901234567890 * 9876543210').result, '121932631124828532111263526900');
});
test('decimal and fraction arithmetic stays exact through intermediate operations', () => {
  assert.equal(calculate('0.1+0.2').result, '0.3');
  assert.equal(calculate('(1/3)*3').result, 1);
  assert.equal(calculate('1/8').result, '0.125');
  assert.equal(calculate('1e20+1').result, '100000000000000000001');
  assert.equal(calculate('.5 × 2.4 ÷ 3').result, '0.4');
});
test('nonterminating decimals explicitly expose approximation and exact fraction', () => {
  assert.deepEqual(calculate('2/3'), { expression: '2/3', result: '0.66666666666666666666666666666667', approximate: true, exactResult: '2/3', decimalPlaces: 32 });
  assert.equal(calculate('-1/3').exactResult, '-1/3');
  assert.equal(calculate('0/7').result, 0);
});
test('power precedence, negative powers and signed decimal remainder are correct', () => {
  for (const [expression, expected] of [['-2^2', -4], ['(-2)^2', 4], ['2^3^2', 512], ['2^-3', '0.125'], ['-5.5%2', '-1.5'], ['10^20', '100000000000000000000']]) {
    assert.equal(calculate(expression).result, expected, expression);
  }
});
test('invalid expressions, division by zero and excessive work fail safely', () => {
  for (const expression of ['1/0', '1%0', '0^-1', '2^0.5', '2^1001', '9^999^999', '1e999999', '('.repeat(65)+'1'+')'.repeat(65), '1+'.repeat(600)+'1', '1;process.exit()', '1 2', '2**3', '(2+3', 'NaN']) {
    assert.throws(() => calculate(expression), CalculationError, expression);
  }
});
test('calculate tool passes exact results and actionable safe errors to the model', async () => {
  const execute = makeToolRunner({ run: { agentId: 'test' }, signal: new AbortController().signal });
  const result = await execute('calculate', { expression: '210380192*2791387' });
  assert.equal(result.ok, true);
  assert.equal(result.result, 587252533006304);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(await execute('calculate', { expression: '1/0' }), { ok: false, expression: '1/0', error: '不能除以零' });
});
