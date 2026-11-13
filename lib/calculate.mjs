/** Finite recursive-descent arithmetic, deliberately no eval / Function. */
export function calculate(expression) {
  if (typeof expression !== 'string' || expression.length < 1 || expression.length > 160) throw new Error('算式长度须为 1–160 字符');
  const raw = expression.trim();
  if (!raw || !/^[0-9\s.+\-*/^()%×÷]+$/.test(raw)) throw new Error('表达式只支持数字和算术符号');
  const source = raw.replace(/×/g, '*').replace(/÷/g, '/');
  let index = 0;
  let steps = 0;
  let depth = 0;
  const skip = () => { while (/\s/.test(source[index] ?? '') && index < source.length) index++; };
  const take = symbol => { skip(); if (source[index] === symbol) { index++; return true; } return false; };
  const bounded = value => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('计算结果超出范围（绝对值不超过 10^12）');
    if (++steps > 120) throw new Error('表达式太复杂');
    return value;
  };
  function atom() {
    if (++depth > 20) throw new Error('括号或幂嵌套太深');
    let value;
    if (take('(')) {
      value = add();
      if (!take(')')) throw new Error('括号不匹配');
    } else {
      skip();
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!match) throw new Error('缺少数字');
      index += match[0].length;
      value = bounded(Number(match[0]));
    }
    depth--;
    return value;
  }
  function power() {
    let value = atom();
    if (take('^')) {
      const exponent = unary();
      if (!Number.isInteger(exponent) || Math.abs(exponent) > 12) throw new Error('幂指数只支持 -12 到 12 的整数');
      value = bounded(value ** exponent);
    }
    return value;
  }
  function unary() {
    if (++depth > 20) throw new Error('符号或幂嵌套太深');
    let value;
    if (take('+')) value = unary();
    else if (take('-')) value = -unary();
    else value = power();
    depth--;
    return bounded(value);
  }
  function multiply() {
    let value = unary();
    while (true) {
      if (take('*')) value = bounded(value * unary());
      else if (take('/')) { const divisor = unary(); if (divisor === 0) throw new Error('不能除以零'); value = bounded(value / divisor); }
      else if (take('%')) { const divisor = unary(); if (divisor === 0) throw new Error('不能除以零'); value = bounded(value % divisor); }
      else break;
    }
    return value;
  }
  function add() {
    let value = multiply();
    while (true) {
      if (take('+')) value = bounded(value + multiply());
      else if (take('-')) value = bounded(value - multiply());
      else break;
    }
    return value;
  }
  const value = add();
  skip();
  if (index !== source.length) throw new Error('表达式包含无效的连续符号或未匹配括号');
  return { expression: raw, result: Object.is(value, -0) ? 0 : Number(value.toPrecision(12)) };
}
