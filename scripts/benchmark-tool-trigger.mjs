import { execFileSync } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { demoAgents } from '../config/mentor-demo.mjs';
import { readCredentialFile, readOpenRouterCredential } from '../lib/config.mjs';
import { buildToolTriggerRequest, createToolDecisionClient, CALCULATE_TRIGGER_RULE, MENTOR_TRIGGER_ACTIONS, MENTOR_TRIGGER_RULE, SEARCH_TRIGGER_RULE,
  TOOL_DECISION_PROVIDERS as providers, TOOL_TRIGGER_INSTRUCTIONS, TOOL_TRIGGER_RULE_VERSION,
  TOOL_TRIGGER_UNCERTAIN } from '../lib/tool-trigger.mjs';
import { availableTools } from '../lib/tools.mjs';
import { benchmarkCases } from './tool-trigger-benchmark/cases.mjs';

const arkOrigin = new URL(providers.ark.url).origin;

const runtimeRules = {
  find_mentor: MENTOR_TRIGGER_RULE,
  search_web: SEARCH_TRIGGER_RULE,
  calculate: CALCULATE_TRIGGER_RULE,
};
const toolRules = {
  ...runtimeRules,
  recall_memory: {
    label: '回忆记忆',
    call: '回答所需的用户过往偏好、事实、约定或进展来自之前的交流，而且当前提供的对话里找不到。',
    skip: '当前对话已经包含答案，或者孩子在分享新事实、询问常识，或在说故事人物如何回忆。',
  },
};

const timeoutMs = 12_000;
const stabilityRuns = 3;
const roster = demoAgents.filter(agent => agent.metadata.mentor).map(agent => ({
  id: agent.id,
  name: agent.name,
  aliases: agent.metadata.card?.aliases ?? [],
  specialty: agent.metadata.mentor.specialty,
  description: agent.metadata.description,
}));

function readArkCredential() {
  if (new URL(process.env.ARK_BASE_URL || arkOrigin).origin !== arkOrigin) {
    throw new Error('当前 ARK_BASE_URL 与正式方舟域名不符。请为本次测试使用方舟凭据。');
  }
  const ark = process.env.ARK_API_KEY?.trim() || (process.env.ARK_API_KEY_FILE
    ? readCredentialFile(process.env.ARK_API_KEY_FILE) : '');
  if (!ark) throw new Error('未找到方舟 API Key。');
  return ark;
}

function readJevCredential() {
  const jev = process.argv.includes('--clipboard')
    ? execFileSync('pbpaste', [], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    : readOpenRouterCredential();
  if (!/^sk-or-[A-Za-z0-9_-]+$/.test(jev ?? '')) {
    throw new Error('未找到有效的 OpenRouter API Key。macOS 可复制 Key 后使用 --clipboard。');
  }
  return jev;
}

function roleFor(scenario) {
  const role = scenario.role || '鳄鱼爸爸';
  const mentor = roster.find(mentor => mentor.name === role || mentor.aliases.includes(role));
  if (!mentor) throw new Error(`评测场景的角色未配置 ${scenario.id}`);
  return mentor;
}

function createInput(scenario, jevOnly) {
  const role = roleFor(scenario);
  const tools = jevOnly
    ? availableTools({ configured: true }, role.id, true).map(tool => tool.function.name)
    : Object.keys(toolRules);
  return buildToolTriggerRequest({ latestUserMessages: scenario.latestUserMessages ?? [scenario.text],
    previousTurns: scenario.history.slice(-6),
    currentMentor: role, pendingMentorInvitation: scenario.pendingInvite,
    activeMentorCard: scenario.activeMentorCard, previousMentorHandoff: scenario.previousMentorHandoff,
    incomingMentorHandoff: scenario.incomingMentorHandoff, previousWebSearch: scenario.previousWebSearch,
    availableTools: tools.filter(id => !scenario.unavailableTools?.includes(id)),
  }, jevOnly ? undefined : toolRules);
}

async function measure(client, input) {
  const started = performance.now();
  const failure = error => ({
    status: 'error', tools: [], uncertain: [], latencyMs: Math.round(performance.now() - started), decisions: {}, error,
  });
  try {
    const { decisions, receipt } = await client.decide(input);
    const latencyMs = Math.round(performance.now() - started);
    const tools = Object.keys(decisions).filter(id => decisions[id].choice === 'call');
    return {
      status: 'ok', tools, latencyMs, decisions, responseModel: receipt.model,
      uncertain: Object.keys(decisions).filter(id => decisions[id].choice === 'uncertain'),
    };
  } catch (error) {
    if (/^HTTP \d{3}$/.test(error.message)) return failure(error.message);
    if (error instanceof SyntaxError || error.message === '返回体缺少有效的工具选择') return failure('返回体缺少有效的工具选择');
    return failure(error.name === 'TimeoutError' ? '请求超时' : '网络请求失败');
  }
}

async function measureCase(scenario, clients, jevOnly) {
  const input = createInput(scenario, jevOnly);
  const runs = scenario.stabilityCheck || scenario.sequenceId ? stabilityRuns : 1;
  return Object.fromEntries(await Promise.all(Object.entries(clients).map(async ([id, client]) => {
    const first = await measure(client, input);
    if (runs === 1) return [id, first];
    const repeats = [];
    for (let run = 1; run < runs; run++) repeats.push(await measure(client, input));
    return [id, { ...first, repeats }];
  })));
}

function checkCases(cases) {
  const ids = new Set();
  for (const { id, expected, unavailableTools = [] } of cases) {
    if (ids.has(id)) throw new Error(`测试 ID 重复 ${id}`);
    ids.add(id);
    for (const tools of [expected, unavailableTools]) {
      if (tools.some(tool => !Object.hasOwn(toolRules, tool)) || new Set(tools).size !== tools.length) {
        throw new Error(`测试工具标注无效 ${id}`);
      }
    }
    if (expected.some(tool => unavailableTools.includes(tool))) throw new Error(`标注要求触发不可用工具 ${id}`);
  }
}

async function run() {
  checkCases(benchmarkCases);
  const arkOnly = process.argv.includes('--ark-only');
  const jevOnly = process.argv.includes('--jev-only');
  if (arkOnly && jevOnly) throw new Error('一次只可选择一个单模型模式。');
  const keys = {
    ...(!jevOnly ? { ark: readArkCredential() } : {}),
    ...(!arkOnly ? { jev: readJevCredential() } : {}),
  };
  const rules = jevOnly ? runtimeRules : toolRules;
  const parallelCases = jevOnly ? 4 : 2;
  const scenarios = jevOnly
    ? benchmarkCases.filter(scenario => scenario.group !== '记忆' && scenario.expected.every(tool => Object.hasOwn(rules, tool)))
    : benchmarkCases;
  const clients = Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, createToolDecisionClient(providers[id], key, { timeoutMs })]));
  const warmup = await measureCase({ text: '蓝色和黄色叠在一起常常是什么颜色？', history: [] }, clients, jevOnly);
  for (const [id, result] of Object.entries(warmup)) {
    console.log(`${providers[id].title} 预热 ${result.status === 'ok' ? `${result.latencyMs} ms` : result.error}`);
  }
  if (Object.values(warmup).some(result => result.status !== 'ok')) {
    throw new Error('至少一个模型未通过连通性和返回格式预检。');
  }
  if (process.argv.includes('--smoke')) return;

  const cases = [];
  for (let start = 0; start < scenarios.length; start += parallelCases) {
    const batch = await Promise.all(scenarios.slice(start, start + parallelCases).map(async scenario => ({
      ...scenario, role: roleFor(scenario).name, roleSpecialty: roleFor(scenario).specialty,
      results: await measureCase(scenario, clients, jevOnly),
    })));
    cases.push(...batch);
    if (cases.length % 8 === 0 || cases.length === scenarios.length) {
      console.log(`已完成 ${cases.length}/${scenarios.length} 个场景`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    timeZone: 'Asia/Shanghai',
    ruleVersion: TOOL_TRIGGER_RULE_VERSION,
    models: Object.fromEntries(Object.keys(clients).map(id => {
      const { title, model } = providers[id];
      return [id, { title, model }];
    })),
    methodology: {
      routingRule: '每轮按工具分别判断。查找导师或超出当前专长映射为 find_mentor 的 call。call 记为选中工具。',
      input: '输入包括本轮原话、最近六条消息、当前导师的专长和简介、可用工具、待处理的邀请和卡片，以及适用的搜索或转介状态。人工标注仅用于评分。',
      measurement: '从本机发起 HTTPS 请求到读完响应。耗时统计使用返回有效决策的请求，排除预热，包含网络与网关。',
      scope: jevOnly
        ? '使用本地 Demo 的三项 Jev 判断规则。多轮场景以固定前文和模拟结果逐轮回放。总览统计各题第一次判定，稳定性复测在用例详情展示。'
        : '导师、搜索和计算使用 Demo 的外层规则。记忆判断用于常规评测对照。多轮切换用固定前文和模拟工具回执逐轮回放。总览统计各题首轮结果，稳定性复测在用例详情展示。',
      timeoutMs, parallelCases, warmupExcluded: true, runsPerCase: 1, stabilityRuns,
      rules: { instructions: TOOL_TRIGGER_INSTRUCTIONS, uncertain: TOOL_TRIGGER_UNCERTAIN, tools: rules,
        mentorActions: MENTOR_TRIGGER_ACTIONS },
    },
    tools: Object.fromEntries(Object.entries(rules).map(([id, { label }]) => [id, label])),
    cases,
  };
  const target = new URL(arkOnly ? '../public/tool-trigger-benchmark-ark.json' : '../public/tool-trigger-benchmark.json', import.meta.url);
  const temporary = new URL(`../public/.tool-trigger-benchmark-${process.pid}.json`, import.meta.url);
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, target);
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
