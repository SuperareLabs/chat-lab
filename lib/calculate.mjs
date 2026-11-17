// Exact rational arithmetic with bounded work; never evaluates JavaScript.
const MAX_DIGITS = 4096;
const MAX_EXPONENT = 1000n;
export class CalculationError extends Error {
  constructor(message) { super(message); this.name = 'CalculationError'; }
}
const fail = message => { throw new CalculationError(message); };
const abs = n => n < 0n ? -n : n;
function gcd(a, b) { a = abs(a); while (b) [a, b] = [b, a % b]; return a; }
function fraction(n, d = 1n) {
  if (!d) fail('不能除以零');
  if (d < 0n) { n = -n; d = -d; }
  if (abs(n).toString().length > MAX_DIGITS || d.toString().length > MAX_DIGITS) {
    fail('计算规模过大，整数或分数最多支持 4096 位');
  }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
const plus = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const times = (a, b) => fraction(a.n * b.n, a.d * b.d);
const divide = (a, b) => fraction(a.n * b.d, a.d * b.n);
const negate = a => ({ n: -a.n, d: a.d });
function numberLiteral(literal) {
  const [decimal, exponentText = '0'] = literal.toLowerCase().split('e');
  const exponent = BigInt(exponentText);
  if (abs(exponent) > MAX_EXPONENT) fail('科学计数法指数须在 -1000 到 1000 之间');
  const [whole, part = ''] = decimal.split('.');
  const scale = part.length - Number(exponent);
  const n = BigInt((whole || '0') + part);
  return scale >= 0 ? fraction(n, 10n ** BigInt(scale)) : fraction(n * 10n ** BigInt(-scale));
}
function pow(base, exponent) {
  if (exponent.d !== 1n || abs(exponent.n) > MAX_EXPONENT) fail('幂指数只支持 -1000 到 1000 的整数');
  const e = abs(exponent.n);
  for (const component of [abs(base.n), base.d]) {
    // A conservative allocation bound before BigInt exponentiation.
    if (component > 1n && BigInt(component.toString().length) * e > BigInt(MAX_DIGITS)) {
      fail('幂运算规模过大，结果最多支持 4096 位');
    }
  }
  return exponent.n < 0n ? fraction(base.d ** e, base.n ** e) : fraction(base.n ** e, base.d ** e);
}
function decimalResult(value) {
  const { n, d } = value;
  if (d === 1n) {
    return { result: abs(n) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString() };
  }
  let denominator = d, twos = 0, fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
  const approximate = denominator !== 1n;
  const places = approximate ? 32 : Math.max(twos, fives);
  const scale = 10n ** BigInt(places);
  const magnitude = abs(n) * scale;
  let scaled = magnitude / d;
  if (approximate && (magnitude % d) * 2n >= d) scaled++;
  const digits = scaled.toString().padStart(places + 1, '0');
  const decimal = digits.slice(0, -places) + '.' + digits.slice(-places);
  const result = (n < 0n && scaled ? '-' : '') + decimal.replace(/0+$/, '').replace(/\.$/, '');
  return approximate ? { result, approximate: true, exactResult: `${n}/${d}`, decimalPlaces: places } : { result };
}

export function calculate(expression) {
  if (typeof expression !== 'string' || expression.length < 1 || expression.length > 1024) fail('算式长度须为 1–1024 字符');
  const raw = expression.trim();
  if (!raw || !/^[0-9eE\s.+\-*/^()%×÷]+$/.test(raw)) fail('表达式只支持数字、科学计数法和算术符号');
  const source = raw.replace(/×/g, '*').replace(/÷/g, '/');
  let index = 0, steps = 0, depth = 0;
  const skip = () => { while (index < source.length && /\s/.test(source[index])) index++; };
  const take = symbol => { skip(); if (source[index] === symbol) { index++; return true; } return false; };
  const tick = () => { if (++steps > 512) fail('表达式太复杂，最多支持 512 步运算'); };
  function atom() {
    let value;
    if (take('(')) {
      value = add();
      if (!take(')')) fail('括号不匹配');
    } else {
      skip();
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) fail('缺少数字');
      index += match[0].length;
      value = numberLiteral(match[0]);
    }
    return value;
  }
  function power() {
    const value = atom();
    return take('^') ? pow(value, unary()) : value;
  }
  function unary() {
    if (++depth > 64) fail('符号、括号或幂嵌套太深');
    tick();
    const value = take('+') ? unary() : take('-') ? negate(unary()) : power();
    depth--;
    return value;
  }
  function multiply() {
    let value = unary();
    while (true) {
      if (take('*')) { tick(); value = times(value, unary()); }
      else if (take('/')) { tick(); value = divide(value, unary()); }
      else if (take('%')) {
        tick();
        const divisor = unary();
        const quotient = divide(value, divisor);
        value = plus(value, negate(times(fraction(quotient.n / quotient.d), divisor)));
      } else break;
    }
    return value;
  }
  function add() {
    let value = multiply();
    while (true) {
      if (take('+')) { tick(); value = plus(value, multiply()); }
      else if (take('-')) { tick(); value = plus(value, negate(multiply())); }
      else break;
    }
    return value;
  }
  const value = add();
  skip();
  if (index !== source.length) fail('表达式包含无效符号或未匹配括号');
  return { expression: raw, ...decimalResult(value) };
}
