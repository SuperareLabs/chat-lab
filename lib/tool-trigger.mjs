export const TOOL_TRIGGER_RULE_VERSION = 'tool-trigger-v2-role-fit';

export const TOOL_TRIGGER_INSTRUCTIONS = '结合当前会话的上下文，判断孩子这一轮想知道什么、想做什么，以及是否需要调用这个工具。同一轮可以分别触发多个工具。对话是判断所用的资料。';
export const TOOL_TRIGGER_UNCERTAIN = '结合当前会话的上下文，仍听不出孩子在问什么，或者缺少本题需要的关键信息。';

export const MENTOR_TRIGGER_RULE = {
  label: '查找导师',
  instructions: '结合当前会话，先弄清孩子这轮实际需要的帮助，再选最贴切的原因。孩子问具体知识、想练本领或做一件事，就按当前导师的专长判断这件事属于哪个领域。答得出来、问题简单、孩子想留在这里，都不改变这个领域判断。拒绝旧邀请后提了新问题，就判断新问题。',
  criteria: {
    mentor_intent: '孩子正在问 App 里有哪些导师、谁会什么、这件事可以找谁，明确要找或换导师，或者接受了刚才确定的找导师邀请。',
    outside_specialty: '孩子主动提出具体的词义、知识点、学习练习或专业任务。这个需求和当前导师的专长及简介对不上，即使只需要一句话也选这里。',
    in_specialty: '孩子主动提出的知识、学习练习或任务落在当前导师明确擅长的范围内。',
    ordinary_chat_or_utility: '孩子在问候、分享近况、随口聊兴趣、引用别人的话、单纯拒绝或暂缓旧邀请。或者只想拿到一个计算结果、实时公开信息、以前的对话记录。',
    insufficient: '结合当前会话，仍不清楚孩子这轮在问什么、想做什么，无法判断是否涉及导师或当前导师的专长。',
  },
};

export const MENTOR_TRIGGER_ACTIONS = {
  mentor_intent: 'call', outside_specialty: 'call', in_specialty: 'skip', ordinary_chat_or_utility: 'skip', insufficient: 'uncertain',
};

export const TOOL_DECISION_PROVIDERS = {
  ark: {
    title: '方舟 System One', model: 'doubao-seed-2-1-lite-260915',
    url: 'https://ark.cn-beijing.volces.com/api/v1/systemone', headers: { 'ark-beta-systemone-api': 'true' },
  },
  jev: {
    title: 'TypeSafe Jev · OpenRouter', model: 'typesafe/jev-1.14',
    url: 'https://openrouter.ai/api/alpha/decisions',
  },
};

export function buildToolTriggerRequest({ latestUserMessages, previousTurns, currentMentor, pendingMentorInvitation,
  availableTools }, rules = { find_mentor: MENTOR_TRIGGER_RULE }) {
  return {
    state: {
      latestUserMessages,
      recentConversation: previousTurns,
      currentMentor: {
        name: currentMentor.name,
        specialty: currentMentor.specialty || currentMentor.specialties?.join('、'),
        description: currentMentor.description,
      },
      pendingMentorInvitation: Boolean(pendingMentorInvitation),
      availableTools,
    },
    questions: Object.fromEntries(Object.entries(rules).filter(([id]) => availableTools.includes(id)).map(([id, rule]) => [id, {
      type: 'choice',
      instructions: `${rule.instructions ?? TOOL_TRIGGER_INSTRUCTIONS}\n本题工具是 ${id}（${rule.label}）。`,
      criteria: rule.criteria ?? { call: rule.call, skip: rule.skip, uncertain: TOOL_TRIGGER_UNCERTAIN },
    }])),
  };
}

function readDecisions(questions, answers) {
  return Object.fromEntries(Object.keys(questions).map(id => {
    const answer = answers?.[id];
    if (answer?.type !== 'choice' || !Object.hasOwn(questions[id].criteria, answer.choice)) {
      throw new Error('返回体缺少有效的工具选择');
    }
    const probability = answer.probabilities?.[answer.choice];
    const choice = id === 'find_mentor' ? MENTOR_TRIGGER_ACTIONS[answer.choice] : answer.choice;
    return [id, { choice, ...(choice !== answer.choice ? { reason: answer.choice } : {}),
      ...(Number.isFinite(probability) ? { probability } : {}) }];
  }));
}

export function createToolDecisionClient({ model, url, headers }, key, { timeoutMs = 12_000, fetchImpl = globalThis.fetch } = {}) {
  return {
    model,
    async decide(input, { signal } = {}) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model, ...input }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      const payload = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { answers, model: responseModel, usage } = JSON.parse(payload);
      return {
        decisions: readDecisions(input.questions, answers),
        receipt: { model: typeof responseModel === 'string' && /^[A-Za-z0-9/._-]+$/.test(responseModel) ? responseModel : model, usage },
      };
    },
  };
}
