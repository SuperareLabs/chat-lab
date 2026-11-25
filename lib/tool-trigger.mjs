export const TOOL_TRIGGER_RULE_VERSION = 'tool-trigger-v12-character-media';

export const TOOL_TRIGGER_INSTRUCTIONS = '结合当前会话的上下文，判断孩子这一轮想知道什么、想做什么，以及是否需要调用这个工具。同一轮可以分别触发多个工具。对话是判断所用的资料。';
export const TOOL_TRIGGER_UNCERTAIN = '结合当前会话的上下文，仍听不出孩子在问什么，或者缺少本题需要的关键信息。';

export const MENTOR_TRIGGER_RULE = {
  label: '查找导师',
  instructions: '结合会话判断孩子这轮在问什么、要帮什么、正在聊什么。满足下面任一条就调用导师工具。第一，孩子主动问知识、想学或想练，或者在请求帮助，即使当前导师擅长也要调用。第二，孩子正在聊的知识、学科、技能或专业任务超出当前导师专长，即使孩子没有发问，也要调用。看这轮实际在聊的事，用前文理解短句和指代。具体学科的入门和提高属于那门学科，安排时间、拆任务和建立学习习惯属于通用学习方法。只取现成资料、实时信息或运算结果的需求由对应工具处理。找谁、要不要出卡由导师工具决定。',
  criteria: {
    mentor_intent: '孩子问有哪些导师、谁会什么、可以找谁，或明确要找或换角色。结合紧接的前文，孩子接受有效的找导师邀请，也选这里。有当前推荐卡且孩子是在回应它时，接受、暂缓和拒绝都选这里。只拒绝文字邀请且没有新需求时，选 ordinary_chat_or_utility。短句用前文理解指代。',
    outside_specialty_research: '孩子听说有一项近期的专业研究、证明或发现，想确认消息指的是哪项新成果或是否属实。辨认成果需要理解该学科，超出当前角色专长，且孩子允许查公开资料。选这里来同时查证消息和匹配专业帮助。',
    outside_specialty: '这轮真正聊到或追问的知识、学科、技能或专业任务，超出当前导师的专长。孩子在介绍、讨论或接续这个内容时，即使没有发问也选这里。背景里的地点、工具、人物和随口提到的活动，用来理解语境。按孩子这轮正在聊的内容判断领域。',
    question_or_help: '孩子在问知识，想学或想练，或者请你帮忙理解、解决困难或完成一件事。能听出在说学习、练习或实操中的卡点，也可以选这里。当前导师擅长这件事也选这里。领域不够明确但能听出求助时，先交给导师工具判断。只要查资料或数值结果，选 ordinary_chat_or_utility。',
    in_specialty: '孩子只是在聊或分享当前导师明确擅长的内容，这轮没有提问、学习目标、求助或找导师的意图。只要孩子在问或求助，即使是当前导师的专长也选 question_or_help。',
    ordinary_chat_or_utility: '问候、闲聊感受、说日常近况，或只转述别人的话，本轮没有实际求助或在讨论专业内容。只想查现成资料、核对公开事实、取得计算结果或找旧对话也选这里。只回绝没有卡片的文字邀请，也没有新需求时，继续聊。',
    insufficient: '结合前文仍听不出孩子在说什么、指什么，也没有可辨认的提问、求助或找人的线索。',
  },
};

export const MENTOR_TRIGGER_ACTIONS = {
  mentor_intent: 'call', outside_specialty_research: 'call', outside_specialty: 'call', question_or_help: 'call',
  in_specialty: 'skip', ordinary_chat_or_utility: 'skip', insufficient: 'uncertain',
};

export const SEARCH_TRIGGER_RULE = {
  label: '搜索网页',
  instructions: '结合会话单独判断这轮能否用公开网页找到孩子要的信息。明确不用联网时，优先选 explicit_no_search。如果答案取决于孩子现场的东西、设备屏幕或手里的材料，且孩子还没提供可辨认的线索，选 missing_reference。要查近期公开新闻、研究或传闻，给出了可检索的方向就先搜查核实。',
  criteria: {
    explicit_no_search: '孩子明确表示这轮不要联网查，或只依据当前已经给出的材料。看清是孩子自己的要求，还是在引用别人。',
    missing_reference: '孩子要辨认自己周围实际存在的一件东西、一个声音、设备上的提示，或自己手里的一段材料。本轮和前文都缺少该对象的特征、图文或其他关键线索，先请孩子补充。只要查的是公开报道的事件、研究、传闻或通用资料，就按公开资料能否检索判断。未知公开事件的准确名称仍可先查证。',
    call: '孩子请你搜索有可检索线索的公开信息、查某类资料或核对说法时调用。问题依赖实时、近期或具体时间地点的公开事实，而且没有可靠结果可复用时也调用。孩子要求重新核对时，重新查。',
    skip: '孩子只想听解释、学观察方法、做练习、创作、回想以前的对话，或正在追问已经取得且适用的结果。也包括单纯引用别人说过的搜索请求。',
    uncertain: TOOL_TRIGGER_UNCERTAIN,
  },
};

export const CALCULATE_TRIGGER_RULE = {
  label: '计算',
  instructions: '单独判断孩子这轮是否想得到一个能算出的数值。结合前文理解条件，区分查资料取得的事实和通过运算得到的结果。',
  call: '孩子要算出、估算或核对一个数值，包括直接给算式、代入公式，以及用已知数据求总量、比例、差值或误差。简单算术、乘方、开方、自然对数、常用对数等数值运算都适用。若这轮也要先查出计算所需的输入，仍选调用。',
  skip: '孩子只要概念、原理、方法或步骤，明确说先别算，或者只是提到一个数字或算式。只要查表、拿到现成的准确统计或资料数字，也选跳过。精确计数或枚举无法用数值算式完成时，按实际任务处理。另有公式估算或误差比较时，独立判断可算的部分。',
};

const DEFAULT_TOOL_RULES = { find_mentor: MENTOR_TRIGGER_RULE, search_web: SEARCH_TRIGGER_RULE, calculate: CALCULATE_TRIGGER_RULE };
const MEDIA_FORMAT_QUESTIONS = {
  share_photo: '对方这轮想收到一张静态照片吗？明确要照片、图片或一张图时优先选照片。没有指定形式时，看外观、物品或场景细节适合照片。明确要求视频时，即使照片也能呈现部分内容，照片的适合程度仍应低。',
  share_video: '对方这轮想收到一段视频吗？明确要视频或一段录像时优先选视频。没有指定形式时，看动作过程或听现场声音适合视频。明确要求照片时，即使视频也能拍到同一对象，视频的适合程度仍应低。',
};
const MEDIA_TRIGGER_QUESTION = {
  type: 'choice',
  instructions: '结合前文理解孩子最新发言，独立判断这轮要不要发送一份角色照片或视频。即使还要查资料、计算或找导师，也可以同时需要影像。',
  criteria: {
    call: '对方明确要看角色分享的照片或视频，而且所要形式可用；或虽未指定形式，想看到的内容确实需要用当前可用的影像来展示。',
    skip: '对方只想听解释或聊这件事，提到照片或视频只是背景、引述或讨论；对方明确不要发送，或指定的唯一形式不可用。',
    uncertain: '结合上文仍不能判断是否想收到影像，或没有足够线索确定要展示什么。',
  },
};
const SEARCH_BLOCK_ACTIONS = { explicit_no_search: 'skip', missing_reference: 'skip' };
const TOOL_TRIGGER_ACTIONS = {
  find_mentor: MENTOR_TRIGGER_ACTIONS,
  search_web: SEARCH_BLOCK_ACTIONS,
};

export function blocksWebSearch(decision) {
  return decision?.choice === 'skip' && Object.hasOwn(SEARCH_BLOCK_ACTIONS, decision.reason);
}

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
  activeMentorCard, previousMentorHandoff, incomingMentorHandoff, previousWebSearch, availableTools,
  includeMediaDecision = false }, rules = DEFAULT_TOOL_RULES) {
  const questions = Object.fromEntries(Object.entries(rules).filter(([id]) => availableTools.includes(id)).map(([id, rule]) => [id, {
    type: 'choice',
    instructions: `${rule.instructions ?? TOOL_TRIGGER_INSTRUCTIONS}\n本题工具是 ${id}（${rule.label}）。`,
    criteria: rule.criteria ?? { call: rule.call, skip: rule.skip, uncertain: TOOL_TRIGGER_UNCERTAIN },
  }]));
  if (includeMediaDecision) {
    questions.any_tool = { type: 'noul', instructions: '结合前文理解最新一轮的全部需求。为了处理这一轮，是否需要调用 availableTools 中至少一个工具？考虑搜索、计算、导师、记忆、影像以及其他可用工具。' };
    const mediaFormats = Object.entries(MEDIA_FORMAT_QUESTIONS).filter(([id]) => availableTools.includes(id));
    if (mediaFormats.length) questions.character_media = MEDIA_TRIGGER_QUESTION;
    for (const [id, instructions] of mediaFormats) questions[id] = { type: 'noul', instructions };
  }
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
      ...(activeMentorCard ? { activeMentorCard: {
        mentorName: activeMentorCard.mentor?.name, goal: activeMentorCard.goal,
      } } : {}),
      ...(previousMentorHandoff ? { previousMentorHandoff: {
        targetAgentName: previousMentorHandoff.targetAgentName, goal: previousMentorHandoff.goal,
      } } : {}),
      ...(incomingMentorHandoff ? { incomingMentorHandoff: {
        sourceAgentName: incomingMentorHandoff.sourceAgentName, goal: incomingMentorHandoff.goal,
      } } : {}),
      ...(previousWebSearch ? { previousWebSearch: { query: previousWebSearch.query,
        retrievedAt: previousWebSearch.retrieved_at } } : {}),
      availableTools,
    },
    questions,
  };
}

function readDecisions(questions, answers) {
  const decisions = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type !== 'choice') continue;
    const answer = answers?.[id];
    if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) {
      throw new Error('返回体缺少有效的工具选择');
    }
    const probability = answer.probabilities?.[answer.choice];
    const choice = TOOL_TRIGGER_ACTIONS[id]?.[answer.choice] ?? answer.choice;
    decisions[id] = { choice, ...(choice !== answer.choice ? { reason: answer.choice } : {}),
      ...(Number.isFinite(probability) ? { probability } : {}) };
  }
  const search = decisions.search_web;
  if (decisions.find_mentor?.reason === 'outside_specialty_research' &&
      search && search.choice !== 'call' && !blocksWebSearch(search)) {
    decisions.search_web = { choice: 'call', reason: 'outside_specialty_research' };
  }
  return decisions;
}

function readMediaDecision(questions, answers) {
  const probabilities = [];
  let anyToolProbability;
  for (const [name, question] of Object.entries(questions)) {
    if (question.type !== 'noul') continue;
    const answer = answers?.[name];
    const probability = answer?.noul;
    if ((answer?.type !== undefined && answer.type !== 'noul') || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { status: 'unavailable', reason: 'response' };
    }
    if (name === 'any_tool') anyToolProbability = probability;
    else probabilities.push({ name, probability });
  }
  return { status: 'succeeded', anyToolProbability, probabilities };
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
        ...(input.questions.any_tool?.type === 'noul' ? { mediaDecision: readMediaDecision(input.questions, answers) } : {}),
        receipt: { model: typeof responseModel === 'string' && /^[A-Za-z0-9/._-]+$/.test(responseModel) ? responseModel : model, usage },
      };
    },
  };
}
