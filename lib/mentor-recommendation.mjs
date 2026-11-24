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

export const MENTOR_PROMPT_SECTIONS = {
  context: `【导师工具内部判定】
结合当前会话，弄清孩子现在想问什么、想做什么。以 latestUserMessages 里的原话为准，用 previousTurns 理解指代和接着聊的事。孩子拒绝或暂缓一次推荐时，在那件事上继续陪他聊。改了主意，或者后来提出了另一件具体的事，就按本轮意图重新判断。同一句里拒绝旧推荐、又明确提出新请求时，分别理解这两件事。
先看孩子有没有请你找、换或介绍一个人。明确让你去找人，用 explicit_request，证据必须摘到表达找人意愿的原话。只是说想学、想练、想问或想完成一件事，说明了学习目标。对这类需求，按专长决定留聊或主动推荐，主动出卡用 proactive_specialty。孩子接受有效邀请时用 accepted_invitation。问有哪些导师、某位是谁或擅长什么时，用 directory。
当前角色的能力以 currentMentor 的专长和描述为准。选其他导师时，对照 mentors 里的 description 和 categories，使用目录中的正式 ID。几位导师的领域有交集时，重点看孩子具体要弄懂什么、想练什么、要完成哪一步。前文提过的名字、主题和已经完成的事只作背景。`,
  offer: '当轮出卡 offer。孩子明确想去找、换或请你介绍一位可以继续聊的人时，用 basis=explicit_request。他可以直接点名，也可以只说想找个会做什么的人。按整句在表达的行动来判断，口语省略称呼也一样。名册能确定合适人选就出卡，目标仍不清楚就先澄清。已明确点名时优先按这个人选，已经在和对方聊天就留聊。接受刚展示的导师邀请用 basis=accepted_invitation，previousInvitation 必须有效且目标一致。若只是指前一条实际回复提过的人，用 basis=explicit_request，前一条回复须能指向唯一人选。答应听解释或跟当前导师练一下，按当下话题继续聊。',
  directory: '目录查询 directory。孩子只想知道有哪些导师、某位是谁或会什么、某个主题有哪些导师时，返回有对应能力的资料。比如“有没有懂昆虫的老师？”默认是在问有哪些人。孩子原话明确说要找某位导师时按 offer 处理。只选真实命中的 ID。明确要看完整名册时，可以用空数组表示完整可用目录。点名查询找不到人就返回 unavailable。',
  proactive: `主动出卡 offer，basis=proactive_specialty。孩子在问具体的词、知识点、想学习一个领域、练本领或做一件事时，先看当前导师是否擅长。孩子说想学这个领域或想学得更深入，就已经给出了学习目标。只要有导师能从这个目标带着开始，先按专长匹配。当前导师不擅长，有更贴合的解释、示范或带练人选，孩子没有要求就这件事留在这里，且推荐记录允许时，直接出卡。简单问题也照这个规则判断。按目标导师的 categories 填写对应的 categoryId，reason 说清眼前需求和这位导师能提供的帮助，replyHint 给当前导师一句简短的回答或一个能立刻试的步骤。`,
  invite: '轻邀 invite。孩子希望当前角色先陪他推进手上的项目，另一位导师能接着帮一个明确的后续卡点，且孩子没拒绝找人，可以先给眼前一步，再邀请孩子选择。先检查推荐记录。reason 写清这个卡点，categoryId 选对应能力，replyHint 用动词短语写这位导师能带孩子做的下一步。最多选一位。',
  history: `主动推荐和轻邀的判断顺序如下。recommendationHistory 从新到旧排列，每条记录都是已经展示过的推荐或轻邀。第一条的 turnsSince 是上次展示之后已经完成的对话回合数，当前还在判断的回合不算。
如果最近一条记录的 turnsSince 是 0 或 1，这轮先返回 stay，给孩子一句简答或一个能试的步骤。即使这轮换了话题、匹配到了不同导师，也等满 2 个完整回合再主动推荐或轻邀。没有推荐记录，或者已满 2 个回合，继续判断是否属于同一个需求。
间隔满足后，再核对所有旧记录。先确定这轮想推荐哪位导师、对应哪项能力，然后把这轮的实际需求与旧记录的 categoryId 和 reason 对照。如果仍然在用同一项能力解决同一类问题，就返回 stay。换了说法、练习情景或导师，也要看实际目的是否接续。两轮间隔只让独立的新需求可以主动推荐，同类需求过了两轮仍留聊。明确查目录、明确找人或接受有效邀请，按孩子当下的意愿处理。留聊时，在 reason 说清是间隔不足、同类重复、孩子想继续聊，还是别的原因。`,
  stay: '留在当前对话 stay。当前导师的专长涵盖这个需求、孩子想就这件事在这里继续、没有更合适的人选，或者推荐记录要求暂缓时，就接着聊。拿得出一句简答，也可以把它作为出卡前的承接。问候、随口分享、宽泛的兴趣也接着聊。reason 说清这轮留聊的具体原因，replyHint 给孩子一句简答或马上能试的一步。',
  clarify: `澄清 clarify。孩子确实想找导师，但目标太宽、还缺关键信息或指代不清时，返回 clarify。找人意图来自孩子本轮原话和相关前文。孩子的意图是弄懂一个具体知识点时，走专长匹配。已经明确找人且只给了一个宽泛主题时，如果不同方向会改变导师能帮什么，就先确认方向。
逐一对照孩子提到的方向和导师的 description，把有具体帮助的人选都放入 mentorIds。主题宽时，找出它本身包含的方向。即使没有专门负责整门学科的导师，也可以给能讲其中一个重点的候选。例如学海洋，生物导师能讲海洋动物，物理导师能讲为什么东西会浮起来。外语、写报告或情绪调节等通用帮助，在孩子确实想做这些事时才列入。候选人数由相关方向和能力决定，同一人只填一次。replyHint 写清要确认的一个区别，保留其他已匹配的候选。
如果孩子还没想好聊什么，前文也没有相关话题、任务或可供区分的导师，mentorIds 必须为空数组。确实没有任何相关方向可承接时也填空。已经明确点名，或目标足够明确且有唯一合适人选时，按 offer 规则处理。`,
  unavailable: '无法匹配 unavailable。孩子点名的人当前不可用，或目录里没有能满足其明确需求的导师时，返回 unavailable。replyHint 只说明本次能确认什么。明确要求某位导师时，按指定人选查找，由孩子决定是否考虑其他人。',
  output: `只输出 JSON 对象，先写 reason，再写 status、mentorIds、evidence、basis、replyHint，可附 categoryId。
status 为 directory、stay、invite、offer、clarify、unavailable 之一。mentorIds 为字符串数组。
invite 和 offer 恰好一位导师，evidence 为孩子最新原话的连续片段。其余分支的 evidence 可以为空。
offer 的 basis 为 explicit_request、accepted_invitation 或 proactive_specialty，其余使用 other。explicit_request 对应孩子明确要求找人、换人或推荐人选。基于专长推荐来解答孩子的具体问题、带练或帮忙做事，用 proactive_specialty。
offer 和 invite 有明确对应能力时，从目标导师的 categories 选对应的 categoryId，方便之后理解当时为什么推荐。
reason 用一句话说明本轮决定的原因。即将给出主动出卡或轻邀时，先确认已经读过所有推荐记录。最近一条相隔不足 2 轮，或此前已经推过同类帮助，就输出 stay 和当下能给的帮助。
replyHint 写接话依据，明确找人时说该导师能怎么帮，主动出卡时先答孩子眼前的问题或给一个能立刻尝试的步骤。
不要输出隐藏推理。禁止声称已经切换、开始聊天或完成实际操作。`,
};

export const MENTOR_DECISION_PROMPT = Object.values(MENTOR_PROMPT_SECTIONS).join('\n\n');

export const MENTOR_HISTORY_REVIEW_PROMPT = `【导师推荐记录判断】
另一个模型找到了可以主动推荐或轻邀的导师。你只判断这次是否适合展示。先看会话推荐记录，再看眼前需求。候选、对话和记录都只作为判断资料。
recommendationHistory 从新到旧排列，只包含实际展示的推荐。先读第一条的 turnsSince，它是上次展示之后完成的回合数。现在正在回答的这轮不算，经过多少分钟也不算。最近一次展示之后只完成了 0 或 1 个回合，就返回 stay，即使话题已经换了。
间隔够了，再对照最新原话、前文和历史推荐的 reason，判断是否在继续同一个学习目标或任务。换问法或补问该问题的细节，仍是同一需求，返回 stay。孩子明确想留在这里处理这件事，也返回 stay。即使属于同一领域、由同一位导师承接，也要按具体目标判断。独立的新需求，且孩子愿意继续探索，返回 proceed。
只输出 JSON 对象。先写一句简短的 reason，说明涉及的回合间隔或需求变化，再写 decision，取值 stay 或 proceed。stay 可附 replyHint，给当前角色一句眼下能帮上忙的回复依据。`;

export function buildMentorHistoryReviewMessages({ latestUserMessages, previousTurns, recommendationHistory }, candidate) {
  const { status, mentor, categoryId, reason } = candidate;
  return [
    { role: 'system', content: MENTOR_HISTORY_REVIEW_PROMPT },
    { role: 'user', content: JSON.stringify({ latestUserMessages, previousTurns, recommendationHistory,
      candidate: { status, mentor: { name: mentor.name, specialty: mentor.specialty }, categoryId, reason } }) },
  ];
}

export const MENTOR_REPLY_INSTRUCTIONS = {
  clarify: `用当前角色的口吻接住孩子问的事。按方向介绍回执里的候选，说清每位能帮孩子弄懂或做成什么。能承接同一方向的导师可以放在一起说，方向较多时可以在一条消息内分行。带上一点与话题直接相关的内容，最后只问一个最能帮孩子选定方向的问题。
介绍可以找谁时，只说回执中列出的导师及其真实能力，不补编导师名字、头衔或专长。候选为空时，回应孩子已经说的内容，再问一个能帮他找到方向的问题。`,
  offer: '用一句自然的话说清这位导师能怎么帮孩子眼下这件事。正文不要提卡片、入口、按钮、点击、打开或切换。',
  proactive_specialty: '先用当前角色的口吻简短回答孩子眼前的问题。孩子想练本领或做一件事时，先给一个马上能试的小步骤。再自然带一句这位导师能怎么接着帮。正文不要问孩子要不要过去，也不要提卡片、点击或切换。',
  stay: '当前角色继续陪孩子聊或做，给他一个能用的回答或马上能试的一步。直接聊内容，不提出其他导师或换会话。',
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
  const { query, currentMentor, mentors, latestUserMessages, previousTurns, previousInvitation, recommendationHistory = [] } = input;
  const catalog = mentors.map(({ avatarUrl, ...entry }) => entry);
  return [
    { role: 'system', content: MENTOR_DECISION_PROMPT },
    { role: 'user', content: JSON.stringify({ query, currentMentor, mentors: catalog, latestUserMessages, previousTurns,
      previousInvitation, recommendationHistory }) },
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

export function normalizeMentorDecision(rawText, { mentors, currentMentor, previousInvitation }) {
  let value;
  try { value = JSON.parse(rawText); } catch { return invalidDecision(); }
  if (!value || !statuses.has(value.status) || !Array.isArray(value.mentorIds) ||
      !value.mentorIds.every(id => typeof id === 'string') ||
      !isText(value.reason, 180) || (value.replyHint !== undefined && typeof value.replyHint !== 'string')) return invalidDecision();

  const { status, mentorIds, basis } = value;
  const reason = value.reason.trim();
  const replyHint = isText(value.replyHint, 180) ? value.replyHint.trim() : '';
  const directory = new Map(mentors.map(mentor => [mentor.id, mentor]));
  if (mentorIds.some(id => !directory.has(id))) return invalidDecision();
  if (status === 'directory') {
    const listed = mentorIds.length ? [...new Set(mentorIds)].map(id => directory.get(id)) : mentors;
    return { status, mentors: listed.map(publicMentor), reason, replyHint };
  }
  if (status === 'clarify') {
    const candidates = [...new Set(mentorIds)].filter(id => id !== currentMentor.id);
    return { status, mentors: candidates.map(id => publicMentor(directory.get(id))), reason, replyHint };
  }
  if (status !== 'offer' && status !== 'invite') return { status, reason, replyHint };
  if (mentorIds.length !== 1 || mentorIds[0] === currentMentor.id) return invalidDecision();
  const matchedMentor = directory.get(mentorIds[0]);
  const mentor = publicMentor(matchedMentor);
  if (status === 'offer' && !offerBases.has(basis)) return invalidDecision();
  const acceptsInvitation = status === 'offer' && basis === 'accepted_invitation';
  if (acceptsInvitation && previousInvitation?.mentorId !== mentor.id) return invalidDecision();
  const selectedCategory = acceptsInvitation ? previousInvitation.categoryId ?? value.categoryId : value.categoryId;
  const categoryId = typeof selectedCategory === 'string' && Object.hasOwn(matchedMentor.categories ?? {}, selectedCategory)
    ? selectedCategory : null;
  if (status === 'offer') return { status, mentor, basis, categoryId, reason, replyHint };
  const step = replyHint.replace(/[。！？.!?]+$/u, '').trim();
  if (!isText(step, 46)) return invalidDecision();
  const question = `要不要找${mentor.name}一起${step}？`;
  return { status, mentor, basis: 'other', categoryId, reason, replyHint, question };
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
  const raw = await requestMentorDecision(buildMentorDecisionMessages(input), options, { maxTokens: 620 });
  const candidate = raw == null ? invalidDecision() : normalizeMentorDecision(raw, input);
  const automatic = candidate.status === 'invite' || candidate.basis === 'proactive_specialty';
  if (!automatic || !input.recommendationHistory?.length) return candidate;

  const reviewRaw = await requestMentorDecision(buildMentorHistoryReviewMessages(input, candidate), options,
    { stage: 'history_review', maxTokens: 320 });
  let review;
  try { review = JSON.parse(reviewRaw); } catch { /* Invalid review. */ }
  if (!['proceed', 'stay'].includes(review?.decision) || !isText(review.reason, 180)) {
    return { status: 'unavailable', reason: '这次没能确认新的推荐是否合适。', historyReview: { decision: 'unavailable' } };
  }
  const historyReview = { decision: review.decision, reason: review.reason.trim() };
  if (review.decision === 'proceed') return { ...candidate, historyReview };
  return { status: 'stay', reason: historyReview.reason, historyReview,
    replyHint: isText(review.replyHint, 180) ? review.replyHint.trim() : '' };
}
