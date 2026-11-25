const mentor = 'find_mentor';
const calculate = 'calculate';
const memory = 'recall_memory';
const search = 'search_web';

const user = text => ({ role: 'user', text });
const assistant = text => ({ role: 'assistant', text });

function scenario(group, id, text, expected, options = {}) {
  return { id, group, text, history: [], expected, ...options };
}

function roleComparison(comparisonId, text, specialist, outsideRole, history = []) {
  const group = '同题换角色';
  return [
    scenario(group, `${comparisonId}-a`, text, [mentor], { role: outsideRole, comparisonId, history }),
    scenario(group, `${comparisonId}-b`, text, [mentor], { role: specialist, comparisonId, history }),
  ];
}

function subjectLearningComparison(comparisonId, text, ...roles) {
  return roles.map((role, index) => scenario(
    '学科学习方法', `${comparisonId}-${index + 1}`, text, [mentor],
    { role, comparisonId, stabilityCheck: true, unavailableTools: [memory] },
  ));
}

function toolSequence(sequenceId, steps, sequenceOptions = {}) {
  const history = [];
  let previousWebSearch;
  return steps.map(({ text, expected, reply, searchQuery, ...options }, index) => {
    const sequenceTurn = index + 1;
    const entry = scenario('多轮工具切换', `${sequenceId}-${String(sequenceTurn).padStart(2, '0')}`, text, expected, {
      sequenceId, sequenceTurn, history: history.slice(-6), ...sequenceOptions,
      ...(previousWebSearch ? { previousWebSearch } : {}), ...options,
    });
    history.push(user(text), assistant(reply));
    if (searchQuery) previousWebSearch = { query: searchQuery, retrieved_at: '2026-11-24T02:00:00.000Z' };
    return entry;
  });
}

function contextComparison(contextComparisonId, text, contexts) {
  return contexts.map(({ expected, ...options }, index) => scenario(
    '同句换上下文', `${contextComparisonId}-${index + 1}`, text, expected,
    { contextComparisonId, stabilityCheck: true, ...options },
  ));
}

function mentorGateScenario(id, text, expected, options = {}) {
  return scenario('导师入口召回', `mentor-gate-${id}`, text, expected, { stabilityCheck: true, ...options });
}

function searchGateScenario(id, text, expected, options = {}) {
  return scenario('联网触发边界', `search-gate-${id}`, text, expected, { stabilityCheck: true, ...options });
}

const botanyCard = { mentor: { name: '小鹿小林' }, goal: '观察向光生长的植物' };
const oralPracticeHistory = [user('明天英语课要做自我介绍。'), assistant('你想到时候先说哪一句？')];
const fractionComparisonObservation = '我发现 3/4 是 9/12，2/3 是 8/12，换成一样的分母就很好比较了。';
const rulerSoundObservation = '我拨了一下压在桌边的尺子，发现尺子伸出桌面越长，听到的声音就越低。';

export const benchmarkCases = [
  scenario('导师意图', 'mentor-01', '布爸，带我去找多罗吧。', [mentor]),
  scenario('导师意图', 'mentor-02', '我现在可以和哪些导师聊天？', [mentor]),
  scenario('导师意图', 'mentor-03', '丽丽是咱们这里管钱的老师吗？我记不清了。', [mentor]),
  scenario('导师意图', 'mentor-04', '我不要你猜，帮我找一位擅长太空知识的导师。', [mentor]),
  scenario('导师意图', 'mentor-05', '我想学英语口语了，想有人一句一句和我练。', [mentor]),
  scenario('导师意图', 'mentor-06', '英文里的 still 在 I’m still here 这句话里是什么意思？', [mentor]),
  scenario('导师意图', 'mentor-07', '我想学宇宙方面的知识。你能先说个有意思的吗？', [mentor]),
  scenario('导师意图', 'mentor-08', '我把每天的零花钱都用光啦，想有人陪我做一份计划，每天记一记钱花在哪。', [mentor]),
  scenario('导师意图', 'mentor-09', '我听说银行会给存钱的人利息，利息是什么意思？', [mentor]),
  scenario('导师意图', 'mentor-10', '我有几个角色，想找个人和我一起把它们写成一个能上台演的故事。', [mentor]),
  scenario('导师意图', 'mentor-11', '请你解释一下星星为什么有的亮有的暗。我就想听你讲。', [mentor]),
  scenario('导师意图', 'mentor-12', '妈妈问我“要不要去找多罗”。我跟她说，今天就聊到这里吧。', []),
  scenario('导师意图', 'mentor-13', '我只想跟你练英语口语，别给我推荐别的老师。', [mentor]),
  scenario('导师意图', 'mentor-14', '多罗，我们排练一下买冰淇淋的英文对话，你演店员吧。', [mentor], {
    role: '鹦鹉多罗',
  }),

  scenario('上下文与邀请', 'context-01', '找谁呢？', [mentor], {
    history: [user('我想学习宇宙方面的知识。'), assistant('如果你想系统学，可以找擅长太空知识的导师。')],
  }),
  scenario('上下文与邀请', 'context-02', '好啊。', [mentor], {
    pendingInvite: true,
    history: [user('我想找人陪我练英语口语。'), assistant('要跟擅长英语对话的导师练一练吗？')],
  }),
  scenario('上下文与邀请', 'context-03', '好啊。', [], {
    history: [user('我有点无聊。'), assistant('要听我讲一个小笑话吗？')],
  }),
  scenario('上下文与邀请', 'context-04', '不了，先给我讲一讲月亮为什么会变形。', [mentor], {
    pendingInvite: true,
    history: [user('我想系统学太空知识。'), assistant('要去找擅长科学的导师吗？')],
  }),
  scenario('上下文与邀请', 'context-05', '不了，先给我讲一讲月亮为什么会变形。', [mentor], {
    history: [user('我想听点太空故事。'), assistant('要听我讲一个宇航员的虚构故事吗？')],
  }),
  scenario('上下文与邀请', 'context-06', '我还是想留在这里。', [], {
    pendingInvite: true,
    history: [user('想找个老师陪我写一篇故事。'), assistant('要去找擅长创作的导师一起写吗？')],
  }),
  scenario('上下文与邀请', 'context-07', '对了，猫为什么会呼噜？', [mentor], {
    pendingInvite: true,
    history: [user('我想学着管零花钱。'), assistant('要找懂零花钱规划的导师试一试吗？')],
  }),
  scenario('上下文与邀请', 'context-08', '要不你先当店员，我说英文，你纠正我。', [mentor], {
    role: '鹦鹉多罗',
    history: [user('我准备复习今天的英语。'), assistant('这次想怎么练？')],
  }),
  scenario('上下文与邀请', 'context-09', '那直接帮我找到那个老师吧。', [mentor], {
    history: [user('我想把零花钱分成花的和存的。'), assistant('有导师擅长带孩子做零花钱计划。想继续聊聊吗？')],
  }),
  scenario('上下文与邀请', 'context-10', '她也会说英语吗？', [], {
    history: [user('我故事里的小女孩会说中文。'), assistant('是呀。你还可以给她加一个特别的本领。')],
  }),
  scenario('上下文与邀请', 'context-11', '不了，我今天就想随便聊聊。', [], {
    pendingInvite: true,
    history: [user('我想学着管零花钱。'), assistant('要找懂零花钱规划的导师试一试吗？')],
  }),
  scenario('上下文与邀请', 'context-12', '那“草莓”用英语怎么说？', [mentor], {
    history: [user('香蕉用英语怎么说？'), assistant('香蕉是 banana。多罗也能和你一起练英文。')],
  }),
  scenario('上下文与邀请', 'context-13', '对了，我今天还画了一只猫。', [], {
    pendingInvite: true,
    history: [user('我想学着管零花钱。'), assistant('要找懂零花钱规划的导师试一试吗？')],
  }),
  scenario('上下文与邀请', 'context-14', '那张卡我不想用了，我想留在这里。', [mentor], {
    activeMentorCard: { mentor: { name: '鹦鹉多罗' }, goal: '练习英文点餐' },
    history: [user('我想学着用英文点餐。'), assistant('可以先想想自己要点哪道菜。多罗能和你对练。')],
  }),
  scenario('上下文与邀请', 'context-15', '我回来啦，今天吃了一块蛋糕。', [], {
    previousMentorHandoff: { targetAgentName: '鹦鹉多罗', goal: '练习英文点餐' },
  }),
  scenario('上下文与邀请', 'context-16', '好，我们继续吧。', [], {
    role: '鹦鹉多罗', incomingMentorHandoff: { sourceAgentName: '鳄鱼爸爸', goal: '练习英文点餐' },
  }),

  scenario('计算', 'calc-01', '每包 6.75 元，我买 8 包，一共要多少钱？', [calculate]),
  scenario('计算', 'calc-02', '请帮我算 58 − 17 − 9。', [calculate]),
  scenario('计算', 'calc-03', '一袋玩具 88 元，打七五折，打完折是多少钱？', [calculate]),
  scenario('计算', 'calc-04', '我画了 12 个圈。为什么平均分的时候，每一份都要一样多？', [mentor]),
  scenario('计算', 'calc-05', '这题先别帮我算。37×16 应该从个位开始写，还是从十位？', [mentor]),
  scenario('计算', 'calc-06', '我算了 44.8 除以 7 等于 6.4，你帮我验证结果对吗？', [calculate]),
  scenario('计算', 'calc-07', '我姐姐说“6×8 擦掉”。这句话里的“擦掉”是啥意思？', [mentor], {
    role: '兔子罗布',
    expectedReason: '引述的算式是语境，孩子自己提出了词义问题。',
  }),
  scenario('计算', 'calc-08', '我们队有 12 人，另一个队也有 12 人。我今天只想聊我们队的名字。', []),
  scenario('计算', 'calc-09', '请用 n/ln(n) 粗估一百万以内大概有多少个素数，给我一个数。', [calculate], {
    role: '狐狸皮斯理',
  }),
  scenario('计算', 'calc-10', '对数刻度上为什么一样长的距离表示一样的倍数变化？只讲原理，先不用代入数值。', [mentor], {
    role: '狐狸皮斯理',
  }),

  scenario('记忆', 'memory-01', '你还记得我上次聊天说想给小狗取什么名字吗？', [memory]),
  scenario('记忆', 'memory-02', '你帮我看看，上周我跟你聊的火山模型做到第几步了？', [memory]),
  scenario('记忆', 'memory-03', '你还记得我说我最喜欢哪种水果吗？', [], {
    history: [user('我最喜欢梨。'), assistant('梨脆脆甜甜的。')],
  }),
  scenario('记忆', 'memory-04', '老师今天让我回来讲一下，我现在来告诉你，我报名了跳远。', []),
  scenario('记忆', 'memory-05', '我以前跟你聊过我最喜欢的漫画。你还能找到是哪本吗？', [memory]),
  scenario('记忆', 'memory-06', '故事里的大象还记得小兔送它什么吗？', [], {
    history: [user('故事开头小兔送了大象一颗松果。'), assistant('大象把松果收进树洞。')],
  }),
  scenario('记忆', 'memory-07', '昨天我们约好先做一件事。我只记得和读书有关，你能接着提醒我吗？', [memory]),
  scenario('记忆', 'memory-08', '我还记得上周下雨。你能讲讲雨是怎么来的？', [mentor]),

  scenario('联网', 'web-01', '成都今天下午会下雨吗？我想知道出门要不要带伞。', [search]),
  scenario('联网', 'web-02', '雨水是怎么从云里掉下来的？', [mentor]),
  scenario('联网', 'web-03', '查一下今天上海科技馆开不开门，我们想下午去。', [search]),
  scenario('联网', 'web-04', '今天北京的日落时间是几点？', [search]),
  scenario('联网', 'web-05', '我就想知道地球为什么会绕太阳转。', [mentor]),
  scenario('联网', 'web-06', '最新一届世界杯已经结束了吗？冠军是谁？', [search]),
  scenario('联网', 'web-07', '小猫会不会游泳？我就想听你讲，不用上网查。', [mentor]),
  scenario('联网', 'web-08', '能上网找一个中国国家博物馆的官网入口吗？', [search]),
  scenario('联网', 'web-09', '你帮我上网搜一下比特币是什么，把出处一起发我。', [search]),
  scenario('联网', 'web-10', '查资料给我一百万以内素数的精确个数和出处，只要精确值。', [search], {
    role: '狐狸皮斯理',
  }),
  searchGateScenario('flower-no-clues', '我有一问题，我看到了一个花但我不知道这是什么花', [mentor], {
    expectedReason: '孩子想辨认眼前的花，目前没有照片或可检索的辨别线索。',
  }),
  searchGateScenario('flower-web-no-clues', '帮我上网查我刚看到的这是什么花吧。我没有照片，也没记住颜色和叶子长什么样。', [mentor], {
    expectedReason: '孩子想上网辨认具体对象，当前信息不足以找到有效的公开资料来比较。',
  }),
  searchGateScenario('flower-web-with-clues', '我看到水面上浮着圆叶，花是粉色的，有好几层花瓣。你能上网找植物园的资料，教我怎么辨认这朵花吗？', [mentor, search], {
    expectedReason: '孩子请求联网对照，已给出环境、叶形和花朵特征，也需要辨认指导。',
  }),
  searchGateScenario('flower-explain', '为什么有些花一到晚上就合起来？你能讲讲原理吗？', [mentor], {
    expectedReason: '孩子要求理解植物现象，可以直接讲原理。',
  }),
  searchGateScenario('flower-source-only', '帮我上网找植物园讲花朵夜间闭合的资料，只要来源链接。', [search], {
    expectedReason: '孩子明确要查找可公开检索的资料链接。',
  }),
  searchGateScenario('device-no-message', '我平板安装软件时跳出来一个报错，能帮我弄明白怎么回事吗？我没记住它写了什么。', [mentor], {
    expectedReason: '要理解的是孩子设备上的具体提示，缺少报错原话或代码。',
  }),
  searchGateScenario('sound-no-sample', '家里的风扇发出怪声，你帮我判断一下是怎么回事。没录音，也说不清是刮响还是嗡嗡响。', [mentor], {
    expectedReason: '当前有排查需求，缺少辨别这个声音所需的描述。',
  }),
  searchGateScenario('document-no-text', '老师发给我的一张讲义最后一句我没看懂，你能帮我解释吗？我还没把讲义里的字发给你。', [mentor], {
    expectedReason: '需要阅读手头讲义，当前会话里没有待解释的句子。',
  }),
  searchGateScenario('device-context-with-code', '找到了，谷歌 Play 提示“DF-DFERH-01”。帮我上网查这个错误码的帮助资料，只要链接。', [search], {
    history: [
      user('我装软件遇到一个弹窗，你能查一下吗？'),
      assistant('把弹窗的文字或错误码告诉我就能按线索查。'),
    ],
    expectedReason: '这一轮提供了应用名和错误码，可以对准公开帮助资料查询。',
  }),
  searchGateScenario('research-no-search', '我听说最近有人用激光做声音实验。先别上网，你能先讲讲光怎么可能变成声音吗？', [mentor], {
    expectedReason: '孩子明确要求先用现有知识解释原理，本轮不用联网。',
  }),
  searchGateScenario('research-sparse-public', '我听说最近国内有个地方发现了一群恐龙脚印，我不记得地名了。你能查查是哪次发现，再给我讲讲脚印怎么保存下来的吗？', [mentor, search], {
    expectedReason: '发现的时间、地理范围和类型提供了公开检索线索，孩子也在求解化石形成原理。',
  }),
  searchGateScenario('public-source-recheck', '刚才那个周六开放时间，官网公告可能换了。帮我上网再核对一遍上海科技馆周六的开放时间。', [search], {
    history: [
      user('帮我查上海科技馆周六开放到几点。'),
      assistant('刚才在科技馆官网找到了一份周六的开放安排。'),
    ],
    previousWebSearch: { query: '上海科技馆 周六 开放时间 官网', retrieved_at: '2026-11-24T02:00:00.000Z' },
    expectedReason: '孩子担心公开信息可能变化，明确要求重新核对已有搜索结果。',
  }),

  scenario('多工具', 'multi-01', '先帮我找一位能带我学理财的导师，再算一下 300 块花 30% 以后还有多少钱。', [mentor, calculate]),
  scenario('多工具', 'multi-02', '查一下今天杭州的天气；另一个事，18.8 加 7.6 等于多少？', [calculate, search]),
  scenario('多工具', 'multi-03', '你记得我昨天说我要准备哪种水果吗？顺便算算每个 2.8 元、买 7 个的钱。', [memory, calculate]),
  scenario('多工具', 'multi-04', '帮我找个老师陪我写动物故事，再查一下今天成都熊猫基地开门到几点。', [mentor, search]),
  scenario('多工具', 'multi-05', '先回忆一下我上周告诉你的故事写到哪里了，然后帮我找一个擅长讲故事的导师。', [mentor, memory]),
  scenario('多工具', 'multi-06', '先不去啦。帮我算一下 18 除以 4 是多少。', [calculate], {
    pendingInvite: true,
    history: [user('我想知道能找谁练英语。'), assistant('要去找多罗练几句吗？')],
  }),
  scenario('多工具', 'multi-07', '查一下深圳今天会不会下雨；顺便提醒我之前说的模型课是星期几，再算 15.6 乘 4。', [search, memory, calculate]),
  scenario('多工具', 'multi-08', '帮我找一位懂科学的导师。我准备问他怎么区分行星和恒星。', [mentor]),
  scenario('多工具', 'multi-09', '我想先看看有哪些导师；另外查查今天广州晚上有多冷，再帮我算 23.5−8.75。', [mentor, search, calculate]),
  scenario('多工具', 'multi-10', '能讲讲商店为什么要打折吗？再帮我算一下 67.5×0.8。', [mentor, calculate]),
  scenario('多工具', 'multi-11', '最近有个猜想被AI证实了，你知道是什么吗', [mentor, search]),
  scenario('多工具', 'multi-12', '查一下资料里一百万以内素数的精确个数，再用 x/ln(x) 算出近似值和两者的差。', [calculate, search], {
    role: '狐狸皮斯理',
  }),

  ...toolSequence('switch-museum', [
    {
      text: '帮我上网找一下上海科技馆的官方购票入口。', expected: [search],
      reply: '查到了，可以在上海科技馆官网的预约购票入口看安排。', searchQuery: '上海科技馆 官方 预约购票入口',
    },
    {
      text: '我们总共带了 75 元，买三瓶每瓶 6.5 元的水，帮我算算还剩多少。', expected: [calculate],
      reply: '三瓶水一共 19.5 元，还剩 55.5 元。',
    },
    {
      text: '我还想学好天文学，想先认识太阳系。应该从哪里学起呢？', expected: [mentor],
      reply: '可以从太阳和地球的位置关系开始。想动手认识太阳系的话，也可以和懂科学的导师一起试。',
    },
    {
      text: '我今天终于约齐同学了，好开心！', expected: [], reply: '约齐朋友一起去，确实值得开心一下。',
    },
    {
      text: '对了，这次帮我搜一下上海天文馆周六几点关门。', expected: [search],
      reply: '查开放时间时要按具体日期看上海天文馆的公告。',
    },
  ], { unavailableTools: [memory] }),
  ...toolSequence('switch-sports', [
    {
      text: '我想练好篮球投篮，手型和发力要怎么练？', expected: [mentor],
      reply: '可以先从离篮筐近的地方练。山冈也能陪你看手型和发力。',
    },
    {
      text: '先继续在这儿聊。帮我上网找一下国际篮球联合会的官网入口。', expected: [search],
      reply: '找到了，官网入口是 https://www.fiba.basketball/。', searchQuery: '国际篮球联合会 FIBA 官网入口',
    },
    {
      text: '刚才那个官网网址是什么来着？', expected: [],
      reply: '刚才查到的网址是 https://www.fiba.basketball/。',
    },
    {
      text: '我试投了 24 次，进了 18 个，帮我算算命中率是多少。', expected: [calculate],
      reply: '18 除以 24 是 0.75，命中率是 75%。',
    },
    {
      text: '那现在帮我找个导师陪我练运球和变向吧。', expected: [mentor],
      reply: '山冈可以和你练运球时的手感、节奏和变向。',
    },
  ], { unavailableTools: [memory] }),

  ...toolSequence('jevctx-plant', [
    {
      text: '我能不能把要写的观察日记拆成每天一点点？帮我分一下步骤。', expected: [mentor],
      reply: '可以先选一棵植物，每天同一时间记一句，周末再把记录放在一起看看。',
      expectedReason: '孩子主动请布爸帮忙拆分任务，属于布爸专长也先交给导师工具。',
    },
    {
      text: '那为什么我家窗边的芽，都往玻璃那边歪？先不用上网。', expected: [mentor],
      reply: '小苗常会向较亮的一边长。小林擅长陪你观察植物的变化。',
    },
    {
      text: '小林那张推荐卡先不用了，我还想留在这里。', expected: [mentor], activeMentorCard: botanyCard,
      reply: '好，我们留在这儿聊。',
      expectedReason: '这是对当前有效卡片的明确拒绝，交给导师工具处理卡片状态。',
    },
    {
      text: '我早上量到 6.4 厘米，放学后是 7.1 厘米。帮我算长了多少。', expected: [calculate],
      reply: '7.1 减 6.4，长了 0.7 厘米。',
    },
    {
      text: '对了，帮我上网找中国科学院的官网，我想看植物科普。只要官网入口。', expected: [search],
      reply: '我查到中国科学院的官网入口是 https://www.cas.cn/。',
      searchQuery: '中国科学院 官方网站',
    },
    {
      text: '那页链接是哪一个？', expected: [], reply: '刚查到的是 https://www.cas.cn/。',
      expectedReason: '上轮已经查到同一个官网链接，可以直接引用。',
    },
  ], { sequenceTitle: '植物观察与拒绝推荐卡' }),
  ...toolSequence('jevctx-writing', [
    {
      text: '我想学好语文阅读，怎么练才能把读到的故事讲给别人听？', expected: [mentor],
      reply: '先说谁遇到了什么，再说他怎么做，最后补上结果。',
    },
    {
      text: '帮我网上查一下《小王子》的官方出版社页面，只想要原文出处。', expected: [search],
      reply: '查到了出版社的图书页面，可以在这一页核对书名和出处。',
      searchQuery: 'The Little Prince 出版社 官方图书页面',
    },
    {
      text: '我手上这本还剩 156 页，想分成 6 天看。算一下平均每天多少页。', expected: [calculate],
      reply: '平均每天 26 页。',
    },
    {
      text: '我不懂第一段和第二段怎么接，帮我练一下中文作文的过渡。', expected: [mentor],
      reply: '先看看第二段换了时间还是换了地点。我们可以试着补一句让读者跟得上的话。',
    },
    {
      text: '这句话我还想用英文讲出来，我可以怎么练重音和语调？', expected: [mentor],
      reply: '你可以先找出最想强调的词。要不要我帮你找多罗练重音和语调？',
    },
    {
      text: '先不用找别人。这一段我想改成中文第一人称，你来帮我听听顺不顺。', expected: [mentor],
      pendingInvite: true,
      reply: '可以，先挑一句，把人物名字换成“我”试试。',
      expectedReason: '前半句拒绝了文字邀请，后半句发出了新的中文写作求助。',
    },
  ], { sequenceTitle: '语文阅读、写作与英语表达', role: '兔子罗布' }),
  ...toolSequence('jevctx-electronics', [
    {
      text: '我的小程序接不到串口数据，能带我一步步看是哪里没连好吗？', expected: [mentor],
      reply: '先检查程序选的串口号，再看看设备有没有在发数据。',
    },
    {
      text: '我刚才拿橡皮筋试声音，为什么绷得越紧越尖？我想听你解释，这轮不用上网。', expected: [mentor],
      reply: '橡皮筋拉紧时往往振动得更快。想做对照实验，可以请莫非陪你试。',
      expectedReason: '新需求属于声音物理。孩子对这一轮搜索给出了明确限制。',
    },
    {
      text: '换一件事，帮我上网找 Arduino UNO R3 的官方引脚图。', expected: [search],
      reply: '查到了 Arduino 的 UNO R3 官方硬件文档，引脚图在里面。',
      searchQuery: 'Arduino UNO R3 official pinout documentation',
      expectedReason: '新一轮明确要求联网，上一轮的禁搜要求已经结束。',
    },
    {
      text: '我现在量到两个读数 612 和 275，你帮我算它们差多少。', expected: [calculate],
      reply: '两个读数相差 337。',
    },
    {
      text: '我想知道这片薄铝片振动为什么能产生声音，先讲懂原理。', expected: [mentor],
      reply: '薄铝片振动会让附近的空气跟着振动。莫非可以用看得见的实验讲这个过程。',
    },
    {
      text: '帮我上网查 UNO R4 WiFi 的官方技术规格。另算 612 加 275，再帮我找个能教振动物理的导师。', expected: [mentor, search, calculate],
      reply: '官方规格已经找到，和是 887。振动的物理实验可以找莫非一起做。',
      searchQuery: 'Arduino UNO R4 WiFi official technical specifications',
      expectedReason: '本轮有三个各自需要处理的请求。',
    },
  ], { sequenceTitle: '电子小制作与声音实验', role: '仓鼠考特' }),
  ...toolSequence('jevctx-math', [
    {
      text: '先不要给结果，56÷7 这道题，我想听怎么想。', expected: [mentor],
      reply: '你可以反过来想，几个 7 合起来是 56。',
    },
    {
      text: '明白了，那现在直接帮我把这道题算出答案。', expected: [calculate],
      reply: '56 除以 7 等于 8。',
      expectedReason: '题目由前文给出，本轮从只学方法改成要数值。',
    },
    {
      text: '换个话题，帮我搜一下中国科技馆这周六有什么公开活动。', expected: [search],
      reply: '查到官网有一张周六的最新活动安排表。',
      searchQuery: '中国科技馆 本周六 公开活动 官方安排',
    },
    {
      text: '刚才那个周六安排，是在哪查到的？', expected: [],
      reply: '刚才查到的是中国科技馆官网的活动安排页面。',
    },
    {
      text: '那周日的活动有哪些？', expected: [search],
      reply: '我再查了周日的安排，官网有一张单独的活动表。',
      searchQuery: '中国科技馆 本周日 公开活动 官方安排',
      expectedReason: '先前结果是周六的安排，本轮要新的日期信息。',
    },
    {
      text: '活动等会再看。怎么练才能学好数学应用题？你带我理一下方法。', expected: [mentor],
      reply: '我们可以先练找出已知条件，再用一句话说清题目要什么。',
    },
    {
      text: '但我读题总是漏掉信息，你觉得可以找谁跟我练中文阅读理解？', expected: [mentor],
      reply: '可以找罗布一起练，把关键条件圈出来，再用自己的话复述。',
    },
  ], { sequenceTitle: '数学方法与周末活动查询', role: '狐狸皮斯理' }),
  ...toolSequence('jevctx-english', [
    {
      text: '我想学好英语口语，老是不敢先开口，我应该怎么练？', expected: [mentor],
      reply: '可以先固定一句你平时真会用的问候。说顺以后再换一个场景练。',
    },
    {
      text: '我想用英语介绍银行，但先不管英文。银行为什么愿意给存钱的人利息？', expected: [mentor],
      reply: '这个问题跟银行和存款有关。利利可以和你把存款和利息的关系理清楚。',
      expectedReason: '英文只是表达场景，本轮要理解的是银行运作。',
    },
    {
      text: '我现在只想联网查一下，中国人民银行官网入口是哪一个。', expected: [search],
      reply: '我查到中国人民银行官网是 https://www.pbc.gov.cn/。',
      searchQuery: '中国人民银行 官网入口',
    },
    {
      text: '假设是 180 元，拿出四分之一。算一下拿出了多少。', expected: [calculate],
      reply: '拿出了 45 元。',
    },
    {
      text: '先不聊银行了。我知道作业怎么做，但总把几科作业拖在一块，能帮我安排先后吗？', expected: [mentor],
      reply: '可以先把今天要交的列出来。布爸也能陪你拆开这些学习任务。',
      expectedReason: '这里需要通用的任务安排，超出当前英语导师专长。',
    },
    {
      text: '今晚的作业排好了。陪我练一轮英文点餐，你当店员。', expected: [mentor],
      reply: 'Sure! Welcome. What would you like to order?',
    },
  ], { sequenceTitle: '英语口语、金融知识与作业安排', role: '鹦鹉多罗' }),

  ...contextComparison('jevctx-look', '那帮我看看。', [
    {
      expected: [search], history: [user('杭州图书馆明天开放吗？'), assistant('这得核对图书馆最新公告，要我上网查吗？')],
      expectedReason: '结合前文，接受查询明天的公开安排。',
    },
    {
      expected: [calculate], history: [user('我买了 3 支笔，每支 4.5 元。'), assistant('要我把这些笔的总价算出来吗？')],
      expectedReason: '结合前文，接受按已给数值算总价。',
    },
    {
      expected: [mentor], pendingInvite: true,
      history: [user('我想找人练习怎么写中文的开头。'), assistant('要我帮你找擅长中文写作的导师吗？')],
    },
    {
      expected: [mentor], role: '兔子罗布',
      history: [user('我想把“我玩得很开心”写得具体一点。'), assistant('可以。我帮你看哪一个词能换得具体些，好吗？')],
      expectedReason: '短回复接受的是当前导师的写作帮助。',
    },
  ]),
  ...contextComparison('jevctx-this-one', '就这个吧。', [
    {
      expected: [mentor], activeMentorCard: botanyCard,
      history: [user('哪个导师懂小苗往哪边长？'), assistant('小林懂植物，你想用这张小林的推荐卡吗？')],
    },
    {
      expected: [mentor], role: '狐狸皮斯理',
      history: [user('我想挑一题练数学方法。'), assistant('选“怎么画直角”这道题怎么样？')],
      expectedReason: '短回复选定了前文的练习，接续孩子想练数学方法的需求。',
    },
    {
      expected: [search],
      history: [user('我想知道明天哪里有公开的科普讲座。'), assistant('先查上海科技馆明天有没有科普讲座，可以吗？')],
    },
  ]),
  ...contextComparison('jevctx-no-thanks', '先不用了。', [
    {
      expected: [mentor], activeMentorCard: botanyCard,
      history: [user('我想学植物。'), assistant('这是小林的推荐卡，想现在去吗？')],
      expectedReason: '拒绝针对的是可处理的有效卡片。',
    },
    {
      expected: [], pendingInvite: true,
      history: [user('我在看家里的小苗。'), assistant('要去找小林一起聊聊吗？')],
      expectedReason: '仅拒绝文字邀请。',
    },
    {
      expected: [],
      history: [user('我想知道现在外面会不会下雨。'), assistant('要我现在上网查实况吗？')],
      expectedReason: '本轮撤回了查询，没有提出新请求。',
    },
  ]),

  ...contextComparison('jevctx-ai-context', '在 AI 学习课上，怎么用 Python 给一个列表排序？', [
    { expected: [mentor], role: '鳄鱼爸爸', expectedReason: 'AI 是课程场景，实际需要 Python 编程。' },
    { expected: [mentor], role: '仓鼠考特', expectedReason: '孩子主动问了 Python 编程方法，当前导师擅长也触发。' },
  ]),
  ...contextComparison('jevctx-ai-task', '我在练英语。只想学怎么写提示词，让 AI 先解释改了哪几个地方。', [
    { expected: [mentor], role: '鳄鱼爸爸', expectedReason: '英语是使用场景，孩子主动求助的是写 AI 提示词。' },
    { expected: [mentor], role: '鹦鹉多罗' },
  ]),

  mentorGateScenario('oral-bare', '我的口语好差啊', [mentor], {
    role: '鳄鱼爸爸',
    expectedReason: '孩子给出了口语能力上的具体困难。外层可把可能的练习需求交给工具判断。',
  }),
  mentorGateScenario('oral-benny', '我的口语好差啊', [mentor], {
    role: '鳄鱼爸爸', history: oralPracticeHistory, comparisonId: 'mentor-gate-oral-role',
    expectedReason: '前文明确在说英语口语，训练口语超出布爸的通用学习方法。',
  }),
  mentorGateScenario('oral-duoluo', '我的口语好差啊', [], {
    role: '鹦鹉多罗', history: oralPracticeHistory, comparisonId: 'mentor-gate-oral-role',
    expectedReason: '同一句话在英语导师处可以直接接住和练习。',
  }),
  mentorGateScenario('fractions', '我一看到带分数的题就不会了。', [mentor], {
    role: '鳄鱼爸爸',
    expectedReason: '孩子报告了明确的数学困难，虽然还没说出具体题目。',
  }),
  mentorGateScenario('fractions-specialist', '我一看到带分数的题就不会了。', [], {
    role: '狐狸皮斯理',
    expectedReason: '当前是数学导师，可以直接问孩子卡在哪一步并接着讲。',
  }),
  mentorGateScenario('writing', '我写作文每次都卡在开头。', [mentor], {
    role: '鹦鹉多罗',
    expectedReason: '孩子透露了中文作文的写作困难，句子里没有直接求助也可交给导师工具。',
  }),
  mentorGateScenario('sport', '我打羽毛球总是发不出球。', [mentor], {
    role: '鼹鼠莫非',
    expectedReason: '孩子遇到的是运动动作上的困难，目标是发出球。',
  }),
  mentorGateScenario('programming', '我想做会跑的小车，代码一上传就报错。', [mentor], {
    role: '鳄鱼爸爸',
    expectedReason: '具体障碍是代码或上传调试，可让导师工具澄清细节。',
  }),
  mentorGateScenario('vague-no-topic', '老师讲的那个，我还是没懂。', [], {
    contextComparisonId: 'mentor-gate-vague',
    expectedReason: '没有前文可以分辨“那个”是什么，先在聊天里问清楚。',
  }),
  mentorGateScenario('vague-with-topic', '老师讲的那个，我还是没懂。', [mentor], {
    contextComparisonId: 'mentor-gate-vague',
    history: [user('老师今天讲为什么斜坡能省力。'), assistant('你后来试过用斜坡往上搬东西吗？')],
    expectedReason: '前文已定位斜面省力，能够识别孩子对物理原理有困难。',
  }),
  mentorGateScenario('ordinary-complaint', '烦死了，今天排队排了好久。', [], {
    expectedReason: '这是日常抱怨，未表现出需要某项知识、练习或行动帮助。',
  }),
  mentorGateScenario('study-planning', '快期末了，我每天一坐下就不知道该先复习哪门。', [], {
    role: '鳄鱼爸爸',
    expectedReason: '孩子卡在安排几门课的复习顺序，属于当前角色的通用学习方法。',
  }),
  mentorGateScenario('official-link-only', '帮我找中国教育考试网的英语等级考试口试页面，只要官网链接。', [search], {
    expectedReason: '英语是查询主题，本轮只要一个公开链接。',
  }),
  mentorGateScenario('arithmetic-only', '英语练习册一共 72 页，已经写了 46 页，帮我算还剩多少页。', [calculate], {
    expectedReason: '英语是资料背景，本轮只要页数的差。',
  }),
  mentorGateScenario('accept-invite', '可以呀。', [mentor], {
    contextComparisonId: 'mentor-gate-acceptance', pendingInvite: true,
    history: [user('有人能帮我练英语点餐吗？'), assistant('需要我帮你找多罗，和你一起练吗？')],
    expectedReason: '短回复明确承接一条当前有效的文字导师邀请。',
  }),
  mentorGateScenario('accept-chat', '可以呀。', [], {
    contextComparisonId: 'mentor-gate-acceptance',
    history: [user('今天我不想做什么，就想聊聊。'), assistant('那我们聊聊今天有没有好玩的事？')],
    expectedReason: '短回复只是在继续普通聊天。',
  }),
  mentorGateScenario('fraction-method-request', '为什么把两个分数换成一样的分母，就可以直接比较大小？', [mentor], {
    role: '狐狸皮斯理',
    expectedReason: '孩子主动问数学原理，当前角色擅长也先交给导师工具。',
  }),
  mentorGateScenario('fraction-observation-specialist', fractionComparisonObservation, [], {
    role: '狐狸皮斯理', comparisonId: 'mentor-gate-fraction-observation',
    expectedReason: '孩子分享数学发现，当前角色擅长，孩子这轮没有求助。',
  }),
  mentorGateScenario('fraction-observation-outside', fractionComparisonObservation, [mentor], {
    role: '鳄鱼爸爸', comparisonId: 'mentor-gate-fraction-observation',
    expectedReason: '虽然没有问句，孩子正在聊布爸不擅长的分数比较。',
  }),
  mentorGateScenario('sound-observation-specialist', rulerSoundObservation, [], {
    role: '鼹鼠莫非', comparisonId: 'mentor-gate-sound-observation',
    expectedReason: '这是当前角色擅长的物理实验，孩子只是在分享观察。',
  }),
  mentorGateScenario('sound-observation-outside', rulerSoundObservation, [mentor], {
    role: '鹦鹉多罗', comparisonId: 'mentor-gate-sound-observation',
    expectedReason: '孩子在聊声音实验，主题超出英语导师的专长。',
  }),
  mentorGateScenario('incidental-subject', '我把英语课上的对话放进 AI，让它先指出哪里别扭再给改法，效果比只写“帮我改”好多了。', [], {
    role: '鳄鱼爸爸',
    expectedReason: '孩子此刻分享的是自己改进提示词的过程，英语只是使用场景。',
  }),
  mentorGateScenario('left-topic', '对了，今天学校食堂的面条真香。', [], {
    role: '鳄鱼爸爸',
    history: [user(rulerSoundObservation), assistant('你已经试了长短两个位置，听见音调有变化。')],
    expectedReason: '本轮已换成日常闲聊，前文的物理主题已经结束。',
  }),
  mentorGateScenario('budget-total-only', '我花了 16 元买零食、8 元买文具，帮我加起来，给个总数就行。', [calculate], {
    role: '松鼠利利',
    expectedReason: '孩子只需要算出的数值。',
  }),
  mentorGateScenario('budget-total-and-help', '我花了 16 元买零食、8 元买文具，先算总额，再教我怎么分清必要开支和可选开支。', [calculate, mentor], {
    role: '松鼠利利',
    expectedReason: '算总额和学习开支分类是两个独立需求，后者落在当前角色专长也先交给导师工具。',
  }),

  scenario('闲聊与限制', 'other-01', 'hello', []),
  scenario('闲聊与限制', 'other-02', '布爸，我今天心情很好！想和你击掌。', []),
  scenario('闲聊与限制', 'other-03', '到睡觉时间啦，布爸，你给我讲个小故事吧。', []),
  scenario('闲聊与限制', 'other-04', '帮我查今天南京的气温。', [], {
    unavailableTools: [search],
  }),
  scenario('闲聊与限制', 'other-05', '帮我找个导师练英语，再算一下 24.6 加 5.8。', [calculate], {
    unavailableTools: [mentor],
  }),
  scenario('闲聊与限制', 'other-06', '你还记得前天我告诉你的愿望是什么吗？', [], {
    unavailableTools: [memory],
  }),
  scenario('闲聊与限制', 'other-07', '36 乘 19 等于多少？顺便帮我找位讲太空的导师。', [mentor], {
    unavailableTools: [calculate],
  }),

  ...roleComparison('role-01', '苹果用英语怎么说？', '鹦鹉多罗', '鳄鱼爸爸'),
  ...roleComparison('role-02', '我想学英语口语了。', '鹦鹉多罗', '鳄鱼爸爸'),
  ...roleComparison('role-03', '银行为什么愿意给我利息？', '松鼠利利', '狐狸皮斯理'),
  ...roleComparison('role-04', '算平均数为什么要除以个数？', '狐狸皮斯理', '松鼠利利'),
  ...roleComparison('role-05', '为什么猫的眼睛在暗处看起来会发光？', '小鹿小林', '兔子罗布'),
  ...roleComparison('role-06', '同一块橡皮泥，做成碗的样子为什么更容易浮起来？', '鼹鼠莫非', '小鹿小林'),
  ...roleComparison('role-07', '跳远之前怎么热身比较合适？', '猩猩山冈', '鼹鼠莫非'),
  ...roleComparison('role-08', '为什么程序里的循环要有停止条件？', '仓鼠考特', '浣熊康迪'),
  ...roleComparison('role-09', '那这段写完一件事以后，怎么过渡到下一件？', '兔子罗布', '鹦鹉多罗', [
    user('我在写中文作文，前面写学校义卖的事情，下一段想写回家以后。'),
    assistant('前面和后面是两个时间，可以想想怎么把它们连起来。'),
  ]),
  ...roleComparison('role-10', '洗好的校服怎么晾比较不容易皱？', '浣熊康迪', '鳄鱼爸爸'),
  ...roleComparison('role-11', '我紧张的时候肚子发紧，可以怎么让自己放松？', '考拉安仔', '水豚蛋蛋'),
  ...roleComparison('role-12', '朋友一直抢着发言，我想礼貌地请他等我说完，可以怎么开口？', '兔子罗布', '考拉安仔'),
  ...roleComparison('role-13', '我怎么改提示词，能让 AI 画同一个角色时衣服不老是变？', '鳄鱼爸爸', '兔子罗布'),
  ...roleComparison('role-14', 'AI 为什么能听懂我讲话？', '鳄鱼爸爸', '仓鼠考特'),
  ...roleComparison('role-15', '我的 AI 应用麦克风权限开了也没声音，怎么查到底是哪一步坏掉？', '仓鼠考特', '鳄鱼爸爸'),

  ...subjectLearningComparison('subject-english', '如何才能学好英语呢', '鹦鹉多罗', '鳄鱼爸爸', '狐狸皮斯理'),
  ...subjectLearningComparison('subject-math', '怎样才能把数学学好呢？', '狐狸皮斯理', '鳄鱼爸爸', '鹦鹉多罗'),
  ...subjectLearningComparison('subject-chinese', '我想把语文学好一点，该怎么练？', '兔子罗布', '鳄鱼爸爸'),
  ...subjectLearningComparison('subject-programming', '我想把编程学好，应该怎么入门？', '仓鼠考特', '鳄鱼爸爸'),
  scenario('学科学习方法', 'subject-general-01', '我总是拖到很晚才写作业，能帮我排一下放学后的学习时间吗？', [mentor], {
    role: '鳄鱼爸爸', stabilityCheck: true, unavailableTools: [memory],
  }),
  scenario('学科学习方法', 'subject-general-02', '我今天既有语文又有数学作业，题我都懂，只想跟你理一下先做哪件。', [mentor], {
    role: '鳄鱼爸爸', stabilityCheck: true, unavailableTools: [memory],
  }),
];
