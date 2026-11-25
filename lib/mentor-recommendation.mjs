import { CHAT_RESPONSE_FORMAT } from './chat-output.mjs';

const isText = (value, max) => typeof value === 'string' && !!value.trim() && [...value].length <= max;
const statuses = new Set(['directory', 'stay', 'invite', 'offer', 'clarify', 'unavailable']);
const offerBases = new Set(['explicit_request', 'accepted_invitation', 'proactive_specialty']);
const invalidDecision = () => ({ status: 'unavailable', reason: '这次没能核对导师信息。' });

export function availableMentors(records, profile, currentId) {
  return records.flatMap(({ id, name, metadata = {} }) => {
    const { mentor, card, audience } = metadata;
    if (!mentor || id === currentId || metadata.hidden || metadata.publicDeleted ||
        (audience && (!Number.isInteger(profile.age) || profile.age < audience.minimumAge))) return [];
    return [{
      id, name, description: metadata.description,
      specialty: mentor.specialty, categories: mentor.categories ?? {}, aliases: card?.aliases ?? [], avatarUrl: card?.portrait,
    }];
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

const MENTOR_HISTORY_RULE = `recommendationHistory 是这个孩子和当前导师最近已经展示的推荐或轻邀，包含以前会话，按时间从新到旧排列。turnsSince 是展示后两人完成的对话轮数。把眼下要做的事和历史目标、推荐理由、时间及孩子的选择对照，能力类别和角色用于辅助理解。追问同一个任务、换问法、换练习场景但仍为同一个目标，或孩子已说想就这件事留在这里，继续陪他聊。会话结束、旧卡变灰以后，已推过这件事的记录仍然有效。刚推荐过也可以评估清楚独立的新目标。只属于同一个学科或同一位导师，不能说明两次在解决同一个需求。明确找人、查名册或接受有效邀请，按孩子现在的意愿处理。`;

export const MENTOR_PROMPT_SECTIONS = {
  context: `【导师工具内部判定】
用本轮原话和会话前文判断。上一句正在为孩子的具体问题找帮手，孩子接着问谁能帮，且这个目标还没有可用卡时，按找人的下一步处理。currentSearchEvidence 是联网找到的线索，只用来判断话题及所属学科。
先判断孩子说的是学习和练习目标，还是请你找一个人。选到合适的人是第二步。如果孩子说「我想学会这个本领」「我想练刚才那一步」，并没有请你找人，选人是你主动想到的，出卡用 proactive_specialty。如果孩子说「帮我找个人陪我练」「我想和你刚提到的那位聊」，是在明确请你找人，出卡用 explicit_request。意图以 latestUserMessages 为准，用 previousTurns 和转介背景理解指代。
孩子只是查一个常见词、一个基础定义或一句就能说明白的小事实，且没有找人或继续学习的需求时，直接选 status=stay。一句话也能表达一个复杂需求。outsideSpecialty 为 true 时，入口已判定专业内容超出当前角色专长。查证消息真假可以由当前角色先做，找擅长对应学科的人讲懂这件事同样有价值。遇到孩子想了解的一项专业成果、研究或证明，名册有合适人选且历史允许，先回应消息，再主动出卡。
当前和孩子对话的是 currentMentor，身份和专长以这个对象的 name、id 和角色资料为准。前文出现的人名用来理解话题。选人时看 mentors 的真实能力与正式 ID，只有选到的 ID 和 currentMentor.id 相同，才表示孩子已在和这个人聊。问某种工具在一门学科取得了什么成果，学科成果是主要帮助目标。想知道一门具体学科怎么入门，听得懂开头和能继续教这门学科是两种帮助。按孩子想弄懂的对象、想练的技能或手上要完成的步骤区分。已有转介作为对话背景，是否提议找别人看本轮的新需要。
如果孩子明确表示不想接受 activeMentorCard 那张卡，返回它的 ID 作为 declinedCardId。继续问同一问题、先请当前角色讲讲，都属于留聊。如果同一句话明确拒绝旧卡又提出新请求，照常判断新请求，同时带回旧卡的 declinedCardId。`,
  offer: '孩子请你找人时按当轮出卡 offer 处理。让你介绍一位能聊的人、带他去和对方聊或给一个聊天入口，都属于明确找人的行动请求。刚才已经提出为孩子眼前这件事找人，孩子顺着问谁能接，结合前文按找人处理。basis=explicit_request 的 evidence 摘取孩子这轮表达找人或询问承接对象的原话。点名找人时按真实人选处理，已经在和对方聊天就留聊。孩子同意 previousInvitation 中那句仍有效的找人邀请时用 basis=accepted_invitation。其他情况按实际意图处理。',
  directory: '目录查询 directory 用于只想了解角色资料，例如有哪些人、某位是谁或擅长什么。孩子单独问哪个角色擅长某个领域，也可以介绍。如果正在为一个具体问题找人，孩子接着确认谁能帮，按上下文处理找人的下一步。角色使用名册里的 ID。孩子明确要看完整名册时，可用空数组表示完整可用名册。点名查不到时返回 unavailable。',
  proactive: '主动出卡 offer，basis=proactive_specialty。孩子想学一个方向、练本领、做事，或想弄明白一项需要专业背景的说法、原理或新进展时，按当前角色专长和已有推荐看有没有明显更合适的帮手。查证消息和理解专业内容可以同时处理。replyHint 写一句有把握的简答、可做的一步，或说清需要先核对什么。cardCopy 按实际专长写能帮什么，关于待核实的消息只描述孩子想理解的方向。',
  invite: '轻邀 invite。孩子正在跟当前角色推进一项任务，另一位角色可以解决一个具体的后续难点时，可先给眼前一步，再顺口邀请。先检查是否推过同一目标。replyHint 用短动词词组描述这位角色能帮的下一步。',
  history: MENTOR_HISTORY_RULE,
  stay: '留聊 stay。当前角色擅长、孩子只想了解一个答案、想在这里继续、只是分享、缺少合适人选，或该目标已推荐过，就接着当前话题。reason 说清这轮留聊的原因，replyHint 给一句有用的简答或能试的一步。',
  clarify: '澄清 clarify。孩子想找帮手或推进一件事，目标太宽且不同方向会影响谁能帮时，先接一点相关内容。孩子提到几个方向时，逐个按他想弄懂或想做的事找最贴合的能力。比如同一现象可以涉及解释物理原因、用比例估算、了解设备通信，按具体目的分开找。每个确实能承接的方向都可以提到。把这些人选放进 mentorIds，再确认最关键的一个区别。确实缺上下文或没有相关方向时，mentorIds 留空。',
  unavailable: '无法匹配 unavailable。明确点名的角色当前不可用，或名册里无人能提供所需帮助时，如实说明。孩子点名时，照孩子这次选的人确认。',
  output: `只输出 JSON 对象，先写 reason、status、basis，再写 mentorIds、replyHint、evidence。六个字段每次都写，replyHint 和 evidence 无内容时写空字符串。
replyHint 只提供你能确定的知识、观察建议或导师能帮的下一步。用户同时要照片、视频或搜索时，这些结果由对应工具处理，别推测能不能完成，也别在建议里代报结果。
reason 一句话交代孩子实际想做什么、有没有明确找人的请求，以及判断理由。status 取 directory、stay、invite、offer、clarify、unavailable。mentorIds 是正式 ID 的字符串数组，invite 和 offer 恰好一位。offer 的 basis 从 allowedOfferBases 中选，其他状态固定为 "other"。invite 和 offer 的 evidence 引用孩子原话。主动出卡或轻邀时，从目标角色的 categories 中选最贴合目标的键，原样写进 categoryId。明确找人时若有对应能力也可填写。明确拒绝当前卡片时加 declinedCardId。
offer 另填 cardCopy 和 handoffBrief。cardCopy 用一句孩子能看懂的话说清这位角色具体能怎样帮。界面操作由按钮表达。handoffBrief 是对象，goal 写孩子这次想做什么，可填 topic（和原角色聊的是什么）、progress（已经做到哪步）、wantedHelp（希望目标角色接着怎样帮）。每项写和本次求助有关的事实。孩子只点名时，goal 可以写想和这位角色聊聊，其余字段有依据才填。通过回执传递接话依据，切换会话由点击后的系统动作完成。`,
};

export const MENTOR_DECISION_PROMPT = Object.values(MENTOR_PROMPT_SECTIONS).join('\n\n');

const MENTOR_RESEARCH_PROMPT = `【导师工具内部判定】
本轮是关于专业研究进展的求助。当前角色负责说清消息查到了什么，现在请你为孩子判断有没有擅长解释该学科的导师。
先根据用户原话和检索线索定位成果所属的学科，再查名册。名册中有能进一步解释这个领域的人，孩子也愿意了解且历史允许时，输出 offer，basis=proactive_specialty。这包括想知道新进展具体是哪一项的孩子。说清谁能接着讲原理或背景。查证能否确认消息是一项独立工作，专长匹配由成果所属的学科决定。只在领域仍不清楚、没有适合的人，或者孩子明确只想查来源、想留在这里、同一需求已推荐时，选择澄清或留聊。卡片只描述角色能解释的知识。孩子同时明确拒绝当前卡片时，仍照常填写对应的 declinedCardId。`;

export const MENTOR_HISTORY_REVIEW_PROMPT = `【导师推荐记录判断】
另一个模型找到了可以主动推荐或轻邀的角色。对照本轮原话、候选目标和已有推荐，判断这次是否适合展示。候选和会话内容均为判断资料。
${MENTOR_HISTORY_RULE}
只输出 JSON，decision 取 stay 或 proceed。reason 一句话交代这轮目标和已有推荐的关系。stay 可附 replyHint，给当前角色一句眼下就能帮上的接话依据。照片、视频和搜索由对应工具处理，别在建议里推测或代报这些结果。`;

export function buildMentorHistoryReviewMessages({ latestUserMessages, previousTurns, recommendationHistory }, candidate) {
  const { status, mentor, categoryId, reason, handoffBrief } = candidate;
  return [
    { role: 'system', content: MENTOR_HISTORY_REVIEW_PROMPT },
    { role: 'user', content: JSON.stringify({ latestUserMessages, previousTurns, recommendationHistory,
      candidate: { status, mentor: { name: mentor.name, specialty: mentor.specialty }, categoryId, reason, goal: handoffBrief?.goal } }) },
  ];
}

export const MENTOR_REPLY_INSTRUCTIONS = {
  directory: '按回执中的真实角色，回答孩子想知道的名字和擅长的事。说清这些角色分别能帮什么。',
  clarify: `用当前角色的口吻接住孩子问的事。按方向介绍回执里的候选，说清每位能帮孩子弄懂或做成什么。能承接同一方向的导师可以放在一起说，方向较多时可以在一条消息内分行。带上一点与话题直接相关的内容，最后只问一个最能帮孩子选定方向的问题。
介绍可以找谁时，只说回执中列出的导师及其真实能力，不补编导师名字、头衔或专长。候选为空时，回应孩子已经说的内容，再问一个能帮他找到方向的问题。`,
  offer: '用自己的口吻接住孩子这一句，顺手说清这位角色能怎样帮眼下的事。正文只说你们会聊的内容，省去对卡片、入口、按钮、点击和跳转的播报。',
  proactive_specialty: '先给孩子有用的回答或马上能试的一步，可以参考 replyHint。涉及新的研究或传闻时，按检索能支持到的范围说，查不到就说还没核实到。再自然带一句这位角色能怎么接着帮，省去对卡片、入口、按钮和跳转的播报。',
  stay: '直接回答眼前的问题，给一个能理解的解释或能马上试的一步。角色专长只用于判断找人，能讲清楚的知识照常讲。把握不足时先给可靠部分，说明余下哪里有待确认。留在当前对话把这句接住。',
};

export function previousMentorInvitation(rawContext, lastPriorMessage) {
  let saved;
  try { saved = JSON.parse(rawContext ?? 'null')?.mentorInvitation; }
  catch { return null; }
  if (!saved || lastPriorMessage?.role !== 'assistant' || saved.assistantId !== lastPriorMessage.id ||
      !isText(saved.mentorId, 120) || !isText(saved.question, 120) ||
      !lastPriorMessage.parts?.includes(saved.question)) return null;
  return { mentorId: saved.mentorId, question: saved.question, assistantId: saved.assistantId,
    ...(typeof saved.categoryId === 'string' ? { categoryId: saved.categoryId } : {}) };
}

export function buildMentorDecisionMessages(input) {
  const { query, currentMentor, mentors, latestUserMessages, previousTurns, previousInvitation, activeMentorCard,
    previousMentorHandoff, incomingMentorHandoff, currentSearchEvidence, outsideSpecialty, researchAssistance,
    recommendationHistory = [] } = input;
  const catalog = mentors.map(({ avatarUrl, ...entry }) => entry);
  const allowedOfferBases = [...offerBases].filter(basis => basis !== 'accepted_invitation' || previousInvitation);
  const prompt = researchAssistance
    ? [MENTOR_RESEARCH_PROMPT, MENTOR_PROMPT_SECTIONS.history, MENTOR_PROMPT_SECTIONS.output].join('\n\n') : MENTOR_DECISION_PROMPT;
  return [
    { role: 'system', content: prompt },
    { role: 'user', content: JSON.stringify({ currentMentor, query, latestUserMessages, allowedOfferBases, mentors: catalog, previousTurns,
      ...(outsideSpecialty ? { outsideSpecialty } : {}), ...(currentSearchEvidence?.length ? { currentSearchEvidence } : {}),
      previousInvitation, activeMentorCard, previousMentorHandoff, incomingMentorHandoff, recommendationHistory }) },
  ];
}

function publicMentor({ id, name, specialty, description, avatarUrl }) {
  return { id, name, specialty, description, ...(avatarUrl ? { avatarUrl } : {}) };
}

export function mentorReferenceCheck(mentors, currentId) {
  const references = mentors.filter(mentor => mentor.id !== currentId).map(mentor => {
    // Check for a referral around each catalog name or alias. For example,
    // "莫非" by itself can also be an adverb rather than a name.
    const names = [mentor.name, ...mentor.aliases].filter(Boolean).map(RegExp.escape);
    const name = `(?:${names.join('|')})`;
    const pattern = new RegExp([
      String.raw`(?:找|问|请教|向|推荐|介绍|换到|换成)[\s“「]*${name}`,
      String.raw`(?:跟|和|请)[\s“「]*${name}[^。！？\n]{0,8}(?:练|聊|学|一起|说|对话|帮|带|陪)`,
      String.raw`${name}[”」\s]*(?:老师|导师|专[练教攻]|擅长|(?:能|可以|会)?(?:带|陪|教|帮)(?:你|孩子|咱们))`,
      String.raw`(?:\b(?:ask|try|find|with|to|recommend|talk to)\s+)${name}(?![\p{L}\p{N}_])`,
    ].join('|'), 'iu');
    return { id: mentor.id, pattern };
  });
  return (text, allowedIds = []) => references.some(({ id, pattern }) => !allowedIds.includes(id) && pattern.test(text));
}

export function normalizeMentorDecision(rawText, { mentors, currentMentor, previousInvitation, activeMentorCard, latestUserMessages = [] }) {
  let value;
  try { value = JSON.parse(rawText); } catch { return invalidDecision(); }
  if (!value || !statuses.has(value.status) || !Array.isArray(value.mentorIds) ||
      !value.mentorIds.every(id => typeof id === 'string') ||
      !isText(value.reason, 180) || (value.replyHint !== undefined && typeof value.replyHint !== 'string')) return invalidDecision();

  const { status, mentorIds, basis } = value;
  const reason = value.reason.trim();
  const replyHint = isText(value.replyHint, 180) ? value.replyHint.trim() : '';
  const decline = isText(activeMentorCard?.id, 120) && value.declinedCardId === activeMentorCard.id
    ? { declinedCardId: activeMentorCard.id } : {};
  const directory = new Map(mentors.map(mentor => [mentor.id, mentor]));
  if (mentorIds.some(id => !directory.has(id))) return invalidDecision();
  if (status === 'directory') {
    const listed = mentorIds.length ? [...new Set(mentorIds)].map(id => directory.get(id)) : mentors;
    return { status, mentors: listed.map(publicMentor), reason, replyHint, ...decline };
  }
  if (status === 'clarify') {
    const candidates = [...new Set(mentorIds)].filter(id => id !== currentMentor.id);
    return { status, mentors: candidates.map(id => publicMentor(directory.get(id))), reason, replyHint, ...decline };
  }
  if (status !== 'offer' && status !== 'invite') return { status, reason, replyHint, ...decline };
  if (mentorIds.length !== 1 || mentorIds[0] === currentMentor.id) return invalidDecision();
  const matchedMentor = directory.get(mentorIds[0]);
  const mentor = publicMentor(matchedMentor);
  if (status === 'offer' && !offerBases.has(basis)) return invalidDecision();
  const acceptsInvitation = status === 'offer' && basis === 'accepted_invitation';
  if (acceptsInvitation && previousInvitation?.mentorId !== mentor.id) return invalidDecision();
  const selectedCategory = acceptsInvitation ? previousInvitation.categoryId ?? value.categoryId : value.categoryId;
  const categoryId = typeof selectedCategory === 'string' && Object.hasOwn(matchedMentor.categories ?? {}, selectedCategory)
    ? selectedCategory : null;
  if (status === 'offer') {
    const category = matchedMentor.categories?.[categoryId];
    const evidence = isText(value.evidence, 110) && latestUserMessages.some(text => text.includes(value.evidence))
      ? value.evidence.trim() : '';
    const brief = value.handoffBrief;
    const handoffBrief = { goal: isText(brief?.goal, 110) ? brief.goal.trim()
      : evidence || category || `找${mentor.name}聊聊` };
    for (const key of ['topic', 'progress', 'wantedHelp']) {
      if (isText(brief?.[key], 140)) handoffBrief[key] = brief[key].trim();
    }
    const cardCopy = isText(value.cardCopy, 110) ? value.cardCopy.trim()
      : category ? `${mentor.name}可以陪你${category}。` : `${mentor.name}擅长${mentor.specialty}。`;
    return { status, mentor, basis, categoryId, reason, replyHint, cardCopy, handoffBrief, ...decline };
  }
  const step = replyHint.replace(/[。！？.!?]+$/u, '').trim();
  if (!isText(step, 46)) return invalidDecision();
  const question = `要不要找${mentor.name}一起${step}？`;
  return { status, mentor, basis: 'other', categoryId, reason, replyHint, question, ...decline };
}

async function requestMentorDecision(messages, { provider, model, signal, onUsage }, { stage, maxTokens }) {
  onUsage?.({ phase: 'start', model: model.name, stage });
  try {
    const result = await provider.chat({
      messages, tools: [], responseFormat: CHAT_RESPONSE_FORMAT,
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), maxTokens, thinking: 'disabled',
    });
    onUsage?.({ phase: 'complete', model: model.name, receipt: result.receipt, metrics: result.metrics, stage });
    return result.receipt?.finish_reason === 'length' ? null : result.content;
  } catch (error) {
    onUsage?.({ phase: 'complete', model: model.name, receipt: error.receipt, metrics: error.metrics, status: 'failed', stage });
    return null;
  }
}

export async function decideMentor(input, options) {
  if (!isText(input.query, 400)) return invalidDecision();
  const raw = await requestMentorDecision(buildMentorDecisionMessages(input), options, { maxTokens: 820 });
  const candidate = raw == null ? invalidDecision() : normalizeMentorDecision(raw, input);
  const automatic = candidate.status === 'invite' || candidate.basis === 'proactive_specialty';
  if (!automatic || !input.recommendationHistory?.length) return candidate;

  const decline = candidate.declinedCardId ? { declinedCardId: candidate.declinedCardId } : {};
  const reviewRaw = await requestMentorDecision(buildMentorHistoryReviewMessages(input, candidate), options,
    { stage: 'history_review', maxTokens: 320 });
  let review;
  try { review = JSON.parse(reviewRaw); } catch { /* Invalid review. */ }
  if (!['proceed', 'stay'].includes(review?.decision) || !isText(review.reason, 180)) {
    return { status: 'unavailable', reason: '这次没能确认新的推荐是否合适。', historyReview: { decision: 'unavailable' }, ...decline };
  }
  const historyReview = { decision: review.decision, reason: review.reason.trim() };
  if (review.decision === 'proceed') return { ...candidate, historyReview };
  return { status: 'stay', reason: historyReview.reason, historyReview, ...decline,
    replyHint: isText(review.replyHint, 180) ? review.replyHint.trim() : '' };
}
