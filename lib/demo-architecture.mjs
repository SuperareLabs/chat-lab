import { COMMON_PROMPT, RECENT_EVENTS_PROMPT, prepareMessages, renderSoul, renderTurnSystemPrompt, soulFromAgent } from './prompts.mjs';
import { CHAT_OUTPUT_PROMPT, CHAT_RESPONSE_FORMAT, REPLY_FORMAT_REPAIR_PROMPT } from './chat-output.mjs';
import { renderSharedPrompts } from './shared-prompts.mjs';
import { availableMentors, buildMentorDecisionMessages, MENTOR_HISTORY_REVIEW_PROMPT, MENTOR_PROMPT_SECTIONS, MENTOR_REPLY_INSTRUCTIONS,
  normalizeMentorDecision, previousMentorInvitation } from './mentor-recommendation.mjs';
import { availableTools } from './tools.mjs';
import { buildToolTriggerRequest, MENTOR_TRIGGER_ACTIONS } from './tool-trigger.mjs';
import { MEMORY_PROMPT } from './memory-prompt.mjs';
import { MEMORY_REPAIR_PROMPT } from './memory-repair.mjs';
import { MENTOR_HANDOFF_SOURCE_PROMPT, MENTOR_HANDOFF_WELCOME_PROMPT } from './runtime.mjs';

const prompt = (label, text) => ({ label, text, kind: 'prompt' });
const example = (label, data) => ({ label, text: JSON.stringify(data, null, 2), kind: 'example' });
const schema = (label, data) => ({ label, text: JSON.stringify(data, null, 2), kind: 'schema' });

export function describeDemoArchitecture({ model, agents, children, sharedPrompts, search }) {
  const current = agents[0];
  const userProfile = children[0];
  const role = soulFromAgent(current);
  const mentors = availableMentors(agents, userProfile);
  const currentMentor = mentors.find(mentor => mentor.id === current.id);
  const rules = MENTOR_PROMPT_SECTIONS;
  const tools = availableTools(search, current.id);
  const recommendTool = availableTools(search, current.id, true).find(tool => tool.function.name === 'find_mentor');
  const system = renderTurnSystemPrompt(renderSoul(role, { sharedPrompts }));
  const text = '帮我找小林，我想问怎么观察蚂蚁。';
  const messages = prepareMessages({
    system, userProfile, localTime: { timezone: 'Asia/Shanghai', localDate: '2026-11-23', localTime: '10:00' },
    userOverview: '', history: [{ role: 'user', text }],
  });
  const args = { query: text };
  const input = { ...args, currentMentor, mentors, latestUserMessages: [text], previousTurns: [], previousInvitation: null };
  const decisionMessages = buildMentorDecisionMessages(input);
  const triggerRequest = buildToolTriggerRequest({ ...input,
    availableTools: ['find_mentor', ...tools.map(tool => tool.function.name)] });
  const mentorId = mentors.find(mentor => mentor.aliases?.includes('小林'))?.id;
  const offerDecision = { status: 'offer', mentorIds: [mentorId], evidence: '帮我找小林', basis: 'explicit_request',
    reason: '孩子想找小林学习观察蚂蚁', replyHint: '小林可以陪孩子记录蚂蚁走的路线。',
    cardCopy: '小林可以陪你观察蚂蚁，记下它们走过的路线。',
    handoffBrief: { topic: '如何观察蚂蚁', goal: '学会观察蚂蚁' } };
  const offer = normalizeMentorDecision(JSON.stringify(offerDecision), input);
  const clarification = normalizeMentorDecision(JSON.stringify({ status: 'clarify',
    mentorIds: mentors.filter(mentor => ['莫非', '考特'].some(name => mentor.aliases.includes(name))).map(mentor => mentor.id),
    basis: 'other', evidence: '找谁呢', reason: '还没确定想从天体运动还是航天技术入手。',
    replyHint: '确认孩子更想了解引力，还是飞船上的导航技术。' }), {
    ...input, query: '找可以陪孩子聊宇宙的导师', latestUserMessages: ['找谁呢？'], previousTurns: [
      { role: 'user', text: '我想学习宇宙方面的知识' },
      { role: 'assistant', text: '宇宙里有会自己发光的恒星，也有绕着恒星转的行星。' },
    ],
  });
  const project = '我做蚂蚁观察报告，每次都分不清是不是同一条觅食路线。';
  const inviteInput = { ...input, query: '做蚂蚁观察报告，分辨两次记录是不是同一条路线', latestUserMessages: [project] };
  const inviteDecision = { status: 'invite', mentorIds: [mentorId], evidence: '分不清是不是同一条觅食路线', basis: 'other',
    reason: '孩子有持续的观察任务，仍缺比较路线的方法', replyHint: '设计一张能对比的觅食路线记录表' };
  const invitation = normalizeMentorDecision(JSON.stringify(inviteDecision), inviteInput);
  const previousAssistant = { id: 'demo-assistant-invite', role: 'assistant', parts: ['今天先在纸上记下出发点和终点。', invitation.question] };
  const previousInvitation = previousMentorInvitation(JSON.stringify({ mentorInvitation: {
    assistantId: previousAssistant.id, mentorId, question: invitation.question,
  } }), previousAssistant);
  const acceptedInput = { ...input, query: '同意找小林设计蚂蚁观察记录表', latestUserMessages: ['好呀。'],
    previousTurns: [{ role: 'user', text: project }, { role: 'assistant', text: previousAssistant.parts.join('\n\n') }], previousInvitation };
  const acceptedOffer = normalizeMentorDecision(JSON.stringify({ ...offerDecision, basis: 'accepted_invitation', evidence: '好呀。',
    reason: '孩子同意上一轮确实展示过的小林邀请' }), acceptedInput);
  const englishMentor = mentors.find(mentor => mentor.aliases.includes('多罗'));
  const practice = '我想练用英语点餐。';
  const proactiveDecision = { status: 'offer', basis: 'proactive_specialty', mentorIds: [englishMentor?.id],
    categoryId: 'english-speaking', evidence: '练用英语点餐', reason: '孩子想练英语对话，多罗可以扮演店员。',
    replyHint: '先试着说 Can I have some juice?',
    cardCopy: '多罗可以当店员，陪你用英文练一次点餐。',
    handoffBrief: { topic: '想练英语口语', goal: '练用英语点餐', wantedHelp: '请多罗扮演店员' } };
  const proactiveOffer = normalizeMentorDecision(JSON.stringify(proactiveDecision), { ...input, latestUserMessages: [practice] });
  const recommendationHistory = [{ id: 'demo-practice-run', action: 'offer', basis: 'proactive_specialty',
    mentorId: englishMentor?.id, categoryId: proactiveDecision.categoryId, at: '2026-11-23T02:00:00.000Z',
    reason: proactiveDecision.reason, goal: proactiveDecision.handoffBrief.goal, state: 'available', turnsSince: 1 }];
  const repeatDecision = { status: 'stay', mentorIds: [], basis: 'other', evidence: '练用英语问路',
    reason: '这段会话已经根据英语对练需求推荐过多罗。', replyHint: '先从 Excuse me 开口。' };
  const repeatedPractice = normalizeMentorDecision(JSON.stringify(repeatDecision), {
    ...input, latestUserMessages: ['再练用英语问路吧。'], recommendationHistory,
  });

  const flow = [
    { id: 'input', title: '用户发言', note: '保留原话与会话归属' },
    { id: 'context', title: '组装上下文', note: '角色、背景、前文和当前工具' },
    { id: 'recommendation', title: '角色推荐', note: '孩子提问或求助，或聊到专长外的内容，就调用工具判断' },
    { id: 'decision', title: '当前导师接话', note: '结合实际回执生成回复' },
    { id: 'reply', title: '同轮回复', note: '按真实结果接话并提交' },
    { id: 'handoff', title: '卡片与转介', note: '保留历史卡片，转介后由目标角色主动欢迎' },
    { id: 'memory', title: '会话后记忆', note: '条件满足后另行整理' },
  ];

  const modules = [
    {
      id: 'input', title: '用户发言', description: '收到消息后先确定当前用户、导师和会话。',
      steps: [
        { title: '保存这轮发言', description: '连发的消息按原记录保留。给模型时合并相邻用户发言，会话和角色的归属由代码处理。', source: 'lib/store.mjs · lib/prompts.mjs',
          prompts: [example('当前用户消息 · 合成示例', messages.at(-1))] },
      ],
    },
    {
      id: 'context', title: '组装上下文', description: '以 Demo 默认鳄鱼爸爸为例，展示运行时实际读取的角色和共用提示。',
      steps: [
        { title: '加载当前角色', description: '先写共用对话规则，接入角色适用的世界观，再加载当前角色正文。', source: 'lib/prompts.mjs · lib/shared-prompts.mjs · config/mentor-demo.mjs',
          prompts: [prompt('共用对话提示', COMMON_PROMPT), prompt('共享资料', renderSharedPrompts(sharedPrompts, current.id)),
            prompt('鳄鱼爸爸角色设定', role.definition)] },
        { title: '加入背景和历史', description: '背景与用户本轮发言分开。有可读的近期经历时才附上对应提示。', source: 'lib/prompts.mjs · lib/runtime.mjs',
          prompts: [example('背景消息 · 合成示例', messages[1]), prompt('有近期经历时追加', RECENT_EVENTS_PROMPT)] },
        { title: '生成完整的模型输入', description: '用和运行时相同的组装函数查看这次示例的系统提示。', source: 'lib/runtime.mjs · lib/prompts.mjs',
          prompts: [prompt('完整系统提示 · 默认布爸', messages[0].content)] },
      ],
    },
    {
      id: 'decision', title: '当前导师接话', description: '当前导师结合角色设定、会话和已判定的导师回执生成回复。',
      steps: [
        { title: '阅读最新需求和前文', description: '当前导师按角色设定和会话接话。找导师工具实际执行时，才有对应的回执。', source: 'lib/prompts.mjs · lib/runtime.mjs',
          prompts: [prompt('当前导师使用的共用对话提示', COMMON_PROMPT)] },
        { title: '查询、计算并继续聊天', description: '外层选中搜索或计算时，主模型生成公开查询或数值算式。同轮需要两个工具时，先取资料，再计算，最后按真实回执作答。记忆继续按需调用。', source: 'lib/runtime.mjs · lib/tools.mjs · lib/provider.mjs',
          prompts: [schema('主模型可用的其他工具', { tool_choice: 'auto', tools })] },
      ],
    },
    {
      id: 'recommendation', title: '角色推荐', description: '工具根据当前发言、近期对话、待处理的卡片、该孩子和当前导师的推荐历史及可用名册作出结构化判断。',
      steps: [
        { title: '判定是否触发工具', description: '入口用同一次请求分别判断导师、搜索和计算需求。导师与搜索同时命中时，先查到线索，再让导师工具判断承接。需要数值运算时也会安排计算。', source: 'lib/tool-trigger.mjs · lib/runtime.mjs',
          prompts: [prompt('外层触发提示', triggerRequest.questions.find_mentor.instructions),
            schema('判定原因', triggerRequest.questions.find_mentor.criteria), schema('原因对应的工具动作', MENTOR_TRIGGER_ACTIONS),
            ...(triggerRequest.questions.search_web ? [schema('搜索触发规则', triggerRequest.questions.search_web)] : []),
            ...(triggerRequest.questions.calculate ? [schema('计算触发规则', triggerRequest.questions.calculate)] : []),
            example('语义判断输入 · 合成示例', triggerRequest.state), schema('find_mentor · 实际工具定义', recommendTool)] },
        { title: '准备目录与可验证上下文', description: '代码筛出可用导师，读取本轮原话、近期对话、当前会话的有效邀请和卡片，以及该孩子和当前导师跨会话的最近推荐。', source: 'lib/mentor-recommendation.mjs · lib/runtime.mjs · lib/store.mjs',
          prompts: [example('布爸这轮的可用目录', mentors), example('推荐工具模型收到的上下文 · 合成示例', decisionMessages.slice(1)),
            example('该孩子和当前导师已经展示的推荐 · 合成示例', recommendationHistory)] },
        { title: '根据当前请求形成初步决定', description: '工具模型在查询目录、留在当前对话、轻邀、出卡、澄清和目标不可用之间作出初步决定。', source: 'lib/mentor-recommendation.mjs · lib/tools.mjs',
          prompts: [prompt('完整导师决策提示', decisionMessages[0].content), prompt('上下文与最新意愿', rules.context),
            prompt('目录查询 · directory', rules.directory), prompt('留在当前对话 · stay', rules.stay), prompt('轻邀请 · invite', rules.invite),
            prompt('提供导师入口 · offer', rules.offer), prompt('主动推荐 · proactive_specialty', rules.proactive),
            prompt('同类去重和推荐频率', rules.history), prompt('澄清 · clarify', rules.clarify), prompt('目标不可用 · unavailable', rules.unavailable),
            prompt('输出结构与证据', rules.output), example('模型判断 · 合成示例', offerDecision)] },
        { title: '复核已有记录的主动推荐', description: '存在推荐历史且初步决定为主动出卡或轻邀时，单独核对两次是否在解决同一个目标，以及孩子对旧推荐的选择。清楚的独立需求可马上评估。', source: 'lib/mentor-recommendation.mjs',
          prompts: [prompt('推荐记录复核提示', MENTOR_HISTORY_REVIEW_PROMPT)] },
        { title: '核对工具结果格式', description: '找人意图、留聊、去重和推荐时机由工具模型判断。服务端核对回执格式、导师是否可用，以及接受邀请时能否匹配到已展示的邀请。', source: 'lib/mentor-recommendation.mjs',
          prompts: [example('明确请求 · 校验后返回', offer), example('宽泛宇宙兴趣 · 校验后的候选', clarification), example('观察报告轻邀 · 校验后返回', invitation),
            example('上一轮可见邀请 · 按消息 ID 和原句校验', previousInvitation), example('接受刚呈现的邀请 · 校验后返回', acceptedOffer),
            example('首次英语口语练习 · 主动推荐', proactiveOffer), example('换场景仍是同类 · 继续对话', repeatedPractice)] },
        { title: '同轮接话并展示卡片', description: '当前角色先自然接话，卡片保存到该条回复后展示。孩子明确拒绝某张卡时，服务端确认归属和可用性后立即更新。', source: 'lib/runtime.mjs · lib/store.mjs · public/app.js',
          prompts: [example('导师卡事件 · 合成会话', { type: 'mentor_recommendation', sessionId: 'demo-session',
            card: { id: 'demo-turn', messageId: 'demo-assistant', mentor: { id: offer.mentor.id, name: offer.mentor.name },
              copy: offer.cardCopy, state: 'available' } }),
            prompt('澄清回执的接话指令', MENTOR_REPLY_INSTRUCTIONS.clarify), prompt('出卡回执的接话指令', MENTOR_REPLY_INSTRUCTIONS.offer),
            prompt('主动推荐的接话指令', MENTOR_REPLY_INSTRUCTIONS.proactive_specialty),
            prompt('主模型续答使用的回复提示', CHAT_OUTPUT_PROMPT)] },
      ],
    },
    {
      id: 'reply', title: '同轮回复', description: '有工具时根据实际回执续答。直接回答时沿用同一套消息格式。',
      steps: [
        { title: '生成独立对话气泡', description: '模型输出 messages 数组，界面逐项展示可见回复。', source: 'lib/chat-output.mjs · lib/runtime.mjs',
          prompts: [prompt('回复格式和说话节奏', CHAT_OUTPUT_PROMPT), schema('模型响应格式', CHAT_RESPONSE_FORMAT)] },
        { title: '处理格式异常', description: '结构校验失败可修正一次，已有工具回执仍可使用。之后保存本轮正文和状态。', source: 'lib/runtime.mjs · lib/chat-output.mjs',
          prompts: [prompt('一次格式修正', REPLY_FORMAT_REPAIR_PROMPT)] },
      ],
    },
    {
      id: 'handoff', title: '卡片与转介', description: '有效卡片提供「找某某」入口。转介事实存在来源卡片，目标角色主动欢迎。',
      steps: [
        { title: '持久化显示和同步有效期', description: '卡片留在来源回复下。同会话的新推荐替换同类旧卡，明确拒绝实时变灰。会话闲置 15 分钟后由服务端确认过期。', source: 'lib/store.mjs · public/app.js',
          prompts: [] },
        { title: '点击「找某某」', description: '服务端复核来源卡和会话，再为同一孩子复用目标角色的活跃会话或新建一个。界面加载目标会话后回传确认。', source: 'lib/runtime.mjs · lib/store.mjs · public/app.js',
          prompts: [] },
        { title: '交付摘要后主动欢迎', description: '确认到达时把来源角色、问题、目的和进度写入目标会话。欢迎和后续聊天使用目标会话自己保存的摘要。同一张卡重试复用欢迎消息。', source: 'lib/runtime.mjs · lib/store.mjs',
          prompts: [prompt('目标角色欢迎提示', MENTOR_HANDOFF_WELCOME_PROMPT),
            example('欢迎背景 · 合成示例', { sourceAgentName: current.name, ...offer.handoffBrief })] },
        { title: '原角色读取转介背景', description: '孩子给原角色发消息时，根据孩子和角色查询最近成功转介。模型按当前话题决定是否提及，新会话也能读取。', source: 'lib/runtime.mjs · lib/store.mjs',
          prompts: [prompt('原角色历史转介提示', MENTOR_HANDOFF_SOURCE_PROMPT)] },
      ],
    },
    {
      id: 'memory', title: '会话后记忆', description: '达到会话整理条件后进入后台，不影响当前回复。',
      steps: [
        { title: '从实际发言提取', description: '后台按用户原话来源维护有效信息和经历，统计与更新和聊天回合分开。', source: 'lib/memory-prompt.mjs · lib/memory.mjs',
          prompts: [prompt('记忆提取提示', MEMORY_PROMPT)] },
        { title: '校验并提交', description: '后端核对结构、来源和归属。需要时给出具体错误，定向修正一次。', source: 'lib/memory-repair.mjs · lib/runtime.mjs',
          prompts: [prompt('记忆修正提示', MEMORY_REPAIR_PROMPT)] },
      ],
    },
  ];

  return { model, base: 'ChatLab release1.3.0', flow, modules };
}
