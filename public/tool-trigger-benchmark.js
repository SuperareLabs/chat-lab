const shortNames = { ark: '方舟', jev: 'Jev' };
const defaultNames = { ark: '火山方舟 System One', jev: 'TypeSafe Jev · OpenRouter' };
const byId = (id) => document.getElementById(id);
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const integerFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const filterIds = ['search', 'group-filter', 'tool-filter', 'outcome-filter'];
const emptyTools = [];
const mentorTool = 'find_mentor';
const decisionLabels = { call: '触发', skip: '跳过', uncertain: '不确定' };
const mentorReasonLabels = {
  mentor_intent: '想了解或找导师',
  outside_specialty_research: '超出专长的研究查证',
  outside_specialty: '超出专长',
  question_or_help: '提问或求助',
  in_specialty: '专长内的分享',
  ordinary_chat_or_utility: '闲聊或其他工具即可',
  insufficient: '信息不足',
  explicit_no_search: '孩子明确不要联网',
  missing_reference: '先补辨认线索',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function definition(label, value) {
  const row = element('div');
  row.append(element('dt', '', label), element('dd', '', value));
  return row;
}

function rate(numerator, denominator) {
  return denominator ? percentFormat.format(numerator / denominator) : '—';
}

function latency(ms) {
  return Number.isFinite(ms) ? integerFormat.format(ms) + ' ms' : '—';
}

function percentile(sorted, quantile) {
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function list(value) {
  return Array.isArray(value) ? value : emptyTools;
}

function normalizeResult(result, expected) {
  if (result?.status !== 'ok' && result?.status !== 'error') return null;
  const ok = result?.status === 'ok';
  const tools = new Set(list(result?.tools));
  const missed = [...expected].filter((tool) => !tools.has(tool));
  const extra = [...tools].filter((tool) => !expected.has(tool));
  return {
    ok,
    tools,
    missed,
    extra,
    exact: ok && !missed.length && !extra.length,
    latencyMs: result?.latencyMs,
    uncertain: list(result?.uncertain),
    decisions: result?.decisions ?? {},
    error: result?.error,
    responseModel: result?.responseModel,
    repeats: list(result.repeats).map((attempt) => normalizeResult(attempt, expected)).filter(Boolean),
  };
}

function summarize(rows, provider) {
  let attempted = 0;
  let correct = 0;
  let completed = 0;
  let missed = 0;
  let extra = 0;
  let uncertain = 0;
  let repeated = 0;
  let repeatedCorrect = 0;
  const latencies = [];
  for (const row of rows) {
    const result = row.results[provider];
    if (!result) continue;
    attempted++;
    correct += Number(result.exact);
    completed += Number(result.ok);
    missed += result.missed.length;
    extra += result.extra.length;
    uncertain += result.uncertain.length;
    if (result.repeats.length) {
      const attempts = [result, ...result.repeats];
      repeated += attempts.length;
      repeatedCorrect += attempts.filter((attempt) => attempt.exact).length;
    }
    if (result.ok && Number.isFinite(result.latencyMs)) latencies.push(result.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  return {
    attempted,
    correct,
    completed,
    missed,
    extra,
    uncertain,
    repeated,
    repeatedCorrect,
    failed: attempted - completed,
    p50: percentile(latencies, .5),
    p95: percentile(latencies, .95),
  };
}

function runDate(value, timeZone) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function renderOverview(payload, rows, providers) {
  const meta = byId('run-meta');
  meta.replaceChildren(definition('对话样本', integerFormat.format(rows.length) + ' 条'));
  if (payload.generatedAt) meta.append(definition('运行时间', runDate(payload.generatedAt, payload.timeZone)));
  if (payload.ruleVersion) meta.append(definition('规则版本', payload.ruleVersion));
  meta.hidden = false;

  byId('overview').replaceChildren(...providers.map((provider) => {
    const model = payload.models?.[provider];
    const stats = summarize(rows, provider);
    const article = element('article', 'model-card ' + provider);
    article.append(element('h3', 'model-title', model?.title || defaultNames[provider]));
    if (model?.model) article.append(element('p', 'model-id', model.model));
    const score = element('div', 'model-score');
    const headline = element('div');
    headline.append(element('span', 'score-label', '工具集合准确率'));
    score.append(headline);
    if (!stats.attempted) {
      headline.append(element('strong', 'pending-score', '未运行'));
      article.append(score);
      return article;
    }
    headline.append(element('strong', 'score-value', rate(stats.correct, stats.attempted)));
    score.append(element('span', 'score-count', stats.correct + ' / ' + stats.attempted + ' 条'));
    const metrics = element('dl', 'stat-grid');
    metrics.append(
      definition('P50 延迟', latency(stats.p50)),
      definition('P95 延迟', latency(stats.p95)),
      definition('接口成功／失败', stats.completed + ' / ' + stats.failed),
      definition('漏触发', integerFormat.format(stats.missed) + ' 次'),
      definition('误触发', integerFormat.format(stats.extra) + ' 次'),
      definition('不确定判定', integerFormat.format(stats.uncertain) + ' 次'),
    );
    if (stats.repeated) metrics.append(definition('稳定性用例命中', stats.repeatedCorrect + ' / ' + stats.repeated + ' 次'));
    article.append(score, metrics);
    return article;
  }));

  const pairedPanel = byId('paired');
  const missingProviders = providers.filter((provider) => rows.some(({ results }) => !results[provider]));
  const notice = byId('partial-notice');
  pairedPanel.hidden = notice.hidden = true;
  if (providers.length < 2) return;
  if (missingProviders.length) {
    notice.textContent = missingProviders.map((provider) => shortNames[provider]).join('、')
      + ' 的评测结果尚未齐备。完整结果生成后，刷新页面即可查看两边的对比。';
    notice.hidden = false;
    return;
  }
  pairedPanel.hidden = false;
  const counts = { both: 0, ark: 0, jev: 0, neither: 0 };
  for (const { results } of rows) {
    if (results.ark.exact && results.jev.exact) counts.both++;
    else if (results.ark.exact) counts.ark++;
    else if (results.jev.exact) counts.jev++;
    else counts.neither++;
  }
  const paired = { both: '双方正确', ark: '仅方舟正确', jev: '仅 Jev 正确', neither: '双方有误' };
  pairedPanel.replaceChildren(...Object.entries(paired).map(([id, label]) => {
    const badge = element('div', 'paired-item');
    badge.append(element('strong', '', integerFormat.format(counts[id])), element('span', '', label));
    return badge;
  }));
}

function table(headers) {
  const wrap = element('div', 'table-wrap');
  const node = element('table', 'comparison');
  const header = node.createTHead().insertRow();
  for (const title of headers) {
    const cell = element('th', '', title);
    cell.scope = 'col';
    header.append(cell);
  }
  wrap.append(node);
  return { wrap, body: node.createTBody() };
}

function rowTitle(row, title) {
  const cell = element('th', '', title);
  cell.scope = 'row';
  row.append(cell);
  return cell;
}

function currentRole(row) {
  const role = typeof row.role === 'object' ? row.role?.name ?? row.role?.id : row.role;
  return role || '鳄鱼爸爸';
}

function mentorResult(row, result) {
  if (!result) return element('span', 'chip empty', '未运行');
  if (!result.ok) return element('span', 'chip fail', '接口失败');
  if (row.unavailableTools.includes(mentorTool)) return element('span', 'chip empty', '不可用');
  const triggered = result.tools.has(mentorTool);
  const correct = triggered === row.expected.has(mentorTool);
  const label = result.uncertain.includes(mentorTool) ? '不确定 · 未触发' : triggered ? '触发' : '跳过';
  const mark = element('span', 'chip ' + (correct ? '' : 'fail'), label);
  const reason = result.decisions[mentorTool]?.reason;
  if (reason) {
    mark.title = reason;
    mark.append(element('span', 'role-result-reason', mentorReasonLabels[reason] ?? reason));
  }
  if (!correct) mark.append(element('span', 'role-result-error', triggered ? '误触发' : '漏触发'));
  return mark;
}

function renderRoleComparisons(rows, providers) {
  const groups = [...Map.groupBy(rows.filter((row) => row.comparisonId), (row) => row.comparisonId).values()]
    .filter((group) => new Set(group.map(currentRole)).size > 1);
  byId('role-comparisons').hidden = !groups.length;
  if (!groups.length) return;

  const totals = [definition('对照组', groups.length + ' 组')];
  for (const provider of providers) {
    const complete = groups.filter((group) => group.every((row) => row.results[provider]));
    const hits = complete.filter((group) => group.every((row) => {
      const result = row.results[provider];
      return result.ok && result.tools.has(mentorTool) === row.expected.has(mentorTool);
    })).length;
    totals.push(definition(shortNames[provider] + ' 全组正确', complete.length ? hits + ' / ' + complete.length + ' 组' : '未运行'));
  }
  byId('role-comparison-stats').replaceChildren(...totals);

  const cases = groups.map((group) => {
    const article = element('article', 'panel role-comparison');
    const first = group[0];
    article.append(element('h3', '', first.text));
    const comparison = table(['当前导师', '预期', ...providers.map((provider) => shortNames[provider])]);
    for (const row of group) {
      const line = comparison.body.insertRow();
      const title = rowTitle(line, currentRole(row));
      if (row.roleSpecialty) title.append(element('span', 'role-specialty', row.roleSpecialty));
      const expected = row.expected.has(mentorTool);
      line.insertCell().append(element('span', 'chip ' + (expected ? '' : 'empty'), expected ? '触发' : '跳过'));
      for (const provider of providers) line.insertCell().append(mentorResult(row, row.results[provider]));
    }
    article.append(comparison.wrap);
    return article;
  });
  byId('role-comparison-list').replaceChildren(...cases);
}

function renderBreakdowns(grouped, rows, toolIds, toolLabel, providers) {
  const columns = providers.map((provider) => shortNames[provider]);
  const groupTable = table(['场景', '样本', ...columns]);
  for (const [group, cases] of grouped) {
    const row = groupTable.body.insertRow();
    rowTitle(row, group);
    row.insertCell().textContent = cases.length;
    for (const provider of providers) {
      const results = cases.map((entry) => entry.results[provider]).filter(Boolean);
      const cell = row.insertCell();
      if (!results.length) {
        cell.append(element('span', 'number-secondary', '未运行'));
        continue;
      }
      const correct = results.filter((result) => result.exact).length;
      cell.append(element('span', '', rate(correct, results.length)),
        element('span', 'number-secondary', correct + ' / ' + results.length));
    }
  }
  byId('group-summary').replaceChildren(groupTable.wrap);

  const toolTable = table(['工具', '应触发', ...columns]);
  for (const id of toolIds) {
    const row = toolTable.body.insertRow();
    const label = toolLabel(id);
    const title = rowTitle(row, label);
    if (label !== id) title.append(element('span', 'table-tool-id', id));
    row.insertCell().textContent = rows.filter(({ expected }) => expected.has(id)).length;
    for (const provider of providers) {
      const attempted = rows.filter(({ results }) => results[provider]);
      const cell = row.insertCell();
      if (!attempted.length) {
        cell.append(element('span', 'number-secondary', '未运行'));
        continue;
      }
      const missed = attempted.filter(({ results }) => results[provider].missed.includes(id)).length;
      const extra = attempted.filter(({ results }) => results[provider].extra.includes(id)).length;
      const hits = attempted.filter(({ expected, results }) => expected.has(id) && results[provider].tools.has(id)).length;
      cell.append(element('span', '', '命中 ' + hits),
        element('span', 'number-secondary', '漏 ' + missed + ' / 误 ' + extra));
    }
  }
  byId('tool-summary').replaceChildren(toolTable.wrap,
    element('p', 'comparison-caption', '每个工具单独计数，同一样本可以涉及多个工具。'));
}

function fillSelect(id, options) {
  const select = byId(id);
  const current = select.value;
  const all = select.firstElementChild;
  select.replaceChildren(all);
  for (const [value, label] of options) {
    const option = element('option', '', label);
    option.value = value;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function pillSet(tools, toolLabel, empty = '无触发', className = 'empty') {
  const box = element('span', 'case-toolset');
  if (!tools.size) box.append(element('span', 'chip ' + className, empty));
  for (const id of tools) {
    const pill = element('span', 'chip', toolLabel(id));
    pill.title = id;
    box.append(pill);
  }
  return box;
}

function resultCell(provider, result, toolLabel) {
  const cell = element('span');
  const label = element('span', 'cell-label', shortNames[provider]);
  cell.append(label);
  if (!result) {
    cell.append(pillSet(new Set(), toolLabel, '未运行'));
    return cell;
  }
  cell.append(pillSet(result.tools, toolLabel,
    result.ok ? '无触发' : '接口失败', result.ok ? 'empty' : 'fail'));
  const meta = element('span', 'cell-meta');
  if (result.ok) {
    meta.append(element('span', result.exact ? 'is-good' : 'is-bad', result.exact ? '正确' : '有误'));
  }
  if (Number.isFinite(result.latencyMs)) meta.append(element('span', '', latency(result.latencyMs)));
  if (result.uncertain.length) {
    const uncertainty = element('span', 'is-uncertain', '不确定 ' + result.uncertain.length + ' 项');
    uncertainty.title = result.uncertain.map(toolLabel).join('、');
    meta.append(uncertainty);
  }
  if (result.repeats.length) {
    const attempts = [result, ...result.repeats];
    meta.append(element('span', '', attempts.filter((attempt) => attempt.exact).length + '/' + attempts.length + ' 次正确'));
  }
  cell.append(meta);
  return cell;
}

function contentOf(message) {
  if (typeof message === 'string') return message;
  return String(message?.text ?? message?.content ?? '');
}

function historyBox(row, toolLabel) {
  const box = element('div', 'detail-box');
  box.append(element('h3', '', '对话上下文'));
  const messages = element('ol', 'history-list');
  const roleNames = { user: '孩子', assistant: '导师', system: '系统', tool: '工具' };
  for (const message of row.history) {
    const item = element('li');
    const role = message?.role;
    item.append(element('strong', '', roleNames[role] ?? role ?? '上下文'), element('span', '', contentOf(message)));
    messages.append(item);
  }
  if (row.history.length) box.append(messages);
  else box.append(element('p', 'detail-facts', '此样本没有前文。'));
  box.append(element('p', 'detail-facts', '当前导师为 ' + currentRole(row) + '。'));
  if (row.roleSpecialty) box.append(element('p', 'detail-facts', '专长为 ' + row.roleSpecialty + '。'));
  if (row.expectedReason) box.append(element('p', 'detail-facts', '标注依据　' + row.expectedReason));
  if (row.pendingInvite) box.append(element('p', 'detail-facts', '当前有待确认的推荐邀请。'));
  if (row.activeMentorCard?.mentor?.name) {
    box.append(element('p', 'detail-facts', '当前推荐卡　' + row.activeMentorCard.mentor.name + ' · ' + row.activeMentorCard.goal));
  }
  if (row.previousWebSearch?.query) {
    box.append(element('p', 'detail-facts', '已有搜索　' + row.previousWebSearch.query));
  }
  if (row.unavailableTools.length) {
    box.append(element('p', 'detail-facts',
      '当前不可用的工具为 ' + row.unavailableTools.map(toolLabel).join('、') + '。'));
  }
  return box;
}

function decisionText(decision) {
  const choice = typeof decision === 'string' ? decision : decision?.choice;
  const parts = [decisionLabels[choice] ?? choice ?? '—'];
  const reason = decision?.reason;
  if (reason) parts.push(mentorReasonLabels[reason] ?? reason);
  const probability = decision?.probability;
  if (Number.isFinite(probability)) parts.push(rate(probability, 1));
  return parts.join(' · ');
}

function errorText(error) {
  if (typeof error === 'string') return error;
  return error?.message ?? error?.code ?? '未收到可用的判断结果。';
}

function decisionBox(provider, result, toolLabel) {
  const box = element('div', 'detail-box');
  box.append(element('h3', '', shortNames[provider] + ' · 工具判定'));
  if (!result) {
    box.append(element('p', 'detail-facts', '此样本未运行。'));
    return box;
  }
  const decisions = Object.entries(result.decisions);
  if (decisions.length) {
    const list = element('dl', 'decision-list');
    for (const [id, decision] of decisions) {
      const title = element('dt', '', toolLabel(id));
      title.title = id;
      list.append(title, element('dd', '', decisionText(decision)));
    }
    box.append(list);
  } else if (result.ok) {
    box.append(element('p', 'detail-facts', '此样本没有逐工具判定记录。'));
  }
  if (result.uncertain.length) {
    box.append(element('p', 'is-uncertain', '不确定的工具为 ' + result.uncertain.map(toolLabel).join('、') + '。'));
  }
  if (result.missed.length) box.append(element('p', 'is-bad', '漏触发 ' + result.missed.map(toolLabel).join('、')));
  if (result.extra.length) box.append(element('p', 'is-bad', '误触发 ' + result.extra.map(toolLabel).join('、')));
  if (result.responseModel) box.append(element('p', 'detail-facts', '响应标记模型 ' + result.responseModel));
  if (!result.ok) box.append(element('p', 'is-bad', errorText(result.error)));
  if (result.repeats.length) {
    const attempts = [result, ...result.repeats];
    const hits = attempts.filter((attempt) => attempt.exact).length;
    const runs = element('ol', 'history-list repeat-list');
    attempts.forEach((attempt, index) => {
      const line = element('li');
      line.append(element('strong', '', '第 ' + (index + 1) + ' 次'),
        pillSet(attempt.tools, toolLabel, attempt.ok ? '无触发' : '接口失败', attempt.ok ? 'empty' : 'fail'),
        element('span', attempt.exact ? 'is-good' : 'is-bad', attempt.exact ? '正确' : '有误'));
      runs.append(line);
    });
    box.append(element('p', 'detail-facts', '重复判断 ' + hits + ' / ' + attempts.length + ' 次正确'), runs);
  }
  return box;
}

function caseRow(row, toolLabel, providers) {
  const details = element('details', 'case-row');
  const summary = element('summary', 'case-grid');
  const title = element('span', 'case-main');
  const turn = row.sequenceTurn ? ' · 第 ' + row.sequenceTurn + ' 轮' : '';
  title.append(element('span', 'case-id', row.id + ' · ' + (row.sequenceTitle ?? row.group) + ' · ' + currentRole(row) + turn),
    element('span', 'case-text', row.text));
  const expected = element('span');
  expected.append(element('span', 'cell-label', '预期'), pillSet(row.expected, toolLabel));
  const chevron = element('span', 'chevron');
  chevron.setAttribute('aria-hidden', 'true');
  summary.append(title, expected, ...providers.map((provider) => resultCell(provider, row.results[provider], toolLabel)), chevron);
  const detail = element('div', 'case-detail');
  detail.append(historyBox(row, toolLabel), ...providers.map((provider) => decisionBox(provider, row.results[provider], toolLabel)));
  details.append(summary, detail);
  return details;
}

function matchOutcome({ results }, outcome) {
  const checked = Object.values(results).filter(Boolean);
  switch (outcome) {
    case 'wrong': return checked.some((result) => !result.exact || result.repeats.some((attempt) => !attempt.exact));
    case 'different': return checked.length === 2 && checked[0].exact !== checked[1].exact;
    case 'bothwrong': return checked.length === 2 && checked.every((result) => !result.exact);
    case 'correct': return checked.length > 0 && checked.every((result) => result.exact && result.repeats.every((attempt) => attempt.exact));
    case 'error': return checked.some((result) => !result.ok || result.repeats.some((attempt) => !attempt.ok));
    case 'uncertain': return checked.some((result) => result.uncertain.length || result.repeats.some((attempt) => attempt.uncertain.length));
    default: return true;
  }
}

function renderMethod(methodology) {
  const entries = [
    ['对照输入', methodology?.input || '两边使用相同的工具目录、语义判断规则和已标注对话。每条样本只判断当前这一轮。'],
    ['工具判定', methodology?.routingRule || '选中列记录这一轮模型选择的工具集合。'],
    ['准确率', '实际工具集合与预期集合完全一致才计为正确。接口失败计为错误。不确定判断单独展示。'],
    ['漏触发和误触发', '预期触发但未执行的工具记一次漏触发。预期之外执行的工具记一次误触发。接口失败时，预期工具均计为漏触发。'],
    ['P50 和 P95', (methodology?.measurement || '从本机向模型服务发起 HTTP 请求，记录拿到可解析判断的耗时。') + '分位值按升序最近秩统计。'],
    ['本次范围', methodology?.scope || '评测外层从语义判断到工具触发。导师卡片、推荐记录和频控由工具内部处理。'],
  ];
  const settings = [];
  if (Number.isFinite(methodology?.runsPerCase)) settings.push('常规用例每个模型 ' + methodology.runsPerCase + ' 次');
  if (Number.isFinite(methodology?.stabilityRuns)) settings.push('稳定性用例每个模型 ' + methodology.stabilityRuns + ' 次');
  if (Number.isFinite(methodology?.parallelCases)) settings.push('并行 ' + methodology.parallelCases + ' 题');
  if (Number.isFinite(methodology?.timeoutMs)) settings.push('单请求超时 ' + latency(methodology.timeoutMs));
  if (settings.length) entries.push(['运行设置', settings.join('，') + '。']);
  byId('method').replaceChildren(...entries.map(([label, detail]) => definition(label, detail)));

  const rules = methodology?.rules;
  if (!rules) return;
  const common = element('div', 'rule-general');
  common.append(element('h3', '', '共用规则'), element('p', '', rules.instructions));
  if (rules.uncertain) common.append(element('p', '', '判定不确定时的规则为「' + rules.uncertain + '」'));
  const toolRules = Object.entries(rules.tools ?? {}).map(([id, rule]) => {
    const box = element('div', 'rule-tool');
    box.append(element('h3', '', rule.label + ' · ' + id));
    if (rule.criteria) {
      box.className += ' rule-structured';
      if (rule.instructions) box.append(element('p', '', rule.instructions));
      const choices = element('dl', 'rule-choices');
      for (const [reason, condition] of Object.entries(rule.criteria)) {
        const action = rules.mentorActions?.[reason];
        const label = mentorReasonLabels[reason] ?? decisionLabels[reason] ?? reason;
        const row = definition(action ? label + ' · ' + (decisionLabels[action] ?? action) : label, condition);
        row.title = reason;
        choices.append(row);
      }
      box.append(choices);
    } else {
      box.append(element('p', '', '触发条件　' + rule.call), element('p', '', '跳过条件　' + rule.skip));
    }
    return box;
  });
  byId('rule-content').replaceChildren(common, ...toolRules);
  byId('rules').hidden = false;
}

function render(payload) {
  const providers = Object.keys(shortNames).filter((id) => payload.cases.some(({ results }) => results?.[id]));
  const singleModel = providers.length === 1;
  byId('report').toggleAttribute('data-single-model', singleModel);
  for (const option of byId('outcome-filter').querySelectorAll('[data-paired]')) option.hidden = option.disabled = singleModel;
  if (byId('outcome-filter').selectedOptions[0]?.disabled) byId('outcome-filter').value = '';
  const labels = payload.tools ?? {};
  const toolLabel = (id) => {
    const item = labels[id];
    return typeof item === 'string' ? item : item?.label ?? item?.title ?? id;
  };
  const rows = payload.cases.map((input) => {
    const expected = new Set(list(input.expected));
    const history = list(input.history);
    const group = input.group ?? '其他';
    return {
      ...input,
      group,
      expected,
      history,
      unavailableTools: list(input.unavailableTools).filter((tool) => Object.hasOwn(labels, tool)),
      query: [input.id, group, currentRole(input), input.comparisonId, input.sequenceTitle, input.contextComparisonId,
        input.text, ...history.map(contentOf)].join(' ').toLowerCase(),
      results: Object.fromEntries(providers.map((provider) => [provider, normalizeResult(input.results?.[provider], expected)])),
    };
  });
  const grouped = Map.groupBy(rows, (row) => row.group);
  const toolIds = new Set(Object.keys(labels));
  for (const { expected, results } of rows) {
    for (const id of [...expected, ...Object.values(results).flatMap((result) => [...(result?.tools ?? [])])]) toolIds.add(id);
  }
  renderOverview(payload, rows, providers);
  renderRoleComparisons(rows, providers);
  renderBreakdowns(grouped, rows, toolIds, toolLabel, providers);
  renderMethod(payload.methodology);
  byId('case-columns').replaceChildren(element('span', '', '样本 / 对话原话'), element('span', '', '预期工具'),
    ...providers.map((provider) => element('span', '', shortNames[provider] + ' · 选中工具')), element('span'));
  fillSelect('group-filter', [...grouped.keys()].map((group) => [group, group]));
  fillSelect('tool-filter', [...toolIds].map((id) => [id, toolLabel(id)]));
  const elements = rows.map((row) => ({ row, node: caseRow(row, toolLabel, providers) }));
  const empty = element('p', 'empty-list', '没有符合当前筛选条件的样本。');
  byId('case-list').replaceChildren(...elements.map(({ node }) => node), empty);
  const applyFilters = () => {
    const [search, group, tool, outcome] = filterIds.map((id) => byId(id).value);
    const query = search.trim().toLowerCase();
    let count = 0;
    for (const { row, node } of elements) {
      node.hidden = Boolean(
        (query && !row.query.includes(query))
        || (group && row.group !== group)
        || (tool && !row.expected.has(tool) && !providers.some((provider) => row.results[provider]?.tools.has(tool)))
        || !matchOutcome(row, outcome),
      );
      if (!node.hidden) count++;
    }
    empty.hidden = count > 0;
    byId('case-count').textContent = '显示 ' + integerFormat.format(count) + ' / ' + integerFormat.format(rows.length) + ' 条样本';
  };
  byId('search').oninput = applyFilters;
  for (const id of filterIds.slice(1)) byId(id).onchange = applyFilters;
  byId('filters').onsubmit = (event) => event.preventDefault();
  applyFilters();
  byId('report').hidden = false;
}

async function load() {
  byId('loading').hidden = false;
  byId('load-error').hidden = true;
  try {
    let response = await fetch('./tool-trigger-benchmark.json', { cache: 'no-store' });
    if (response.status === 404) {
      response = await fetch('./tool-trigger-benchmark-ark.json', { cache: 'no-store' });
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const payload = await response.json();
    if (!Array.isArray(payload?.cases) || !payload.cases.length) throw new Error('没有可展示的测试样本');
    render(payload);
  } catch (error) {
    byId('report').hidden = true;
    byId('load-error-message').textContent = '暂时无法读取评测结果。' + error.message;
    byId('load-error').hidden = false;
  } finally {
    byId('loading').hidden = true;
  }
}

byId('retry').onclick = load;
load();
