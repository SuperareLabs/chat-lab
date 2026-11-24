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
    scenario(group, `${comparisonId}-b`, text, [], { role: specialist, comparisonId, history }),
  ];
}

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
  scenario('导师意图', 'mentor-14', '多罗，我们排练一下买冰淇淋的英文对话，你演店员吧。', [], {
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
  scenario('上下文与邀请', 'context-08', '要不你先当店员，我说英文，你纠正我。', [], {
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

  scenario('计算', 'calc-01', '每包 6.75 元，我买 8 包，一共要多少钱？', [calculate]),
  scenario('计算', 'calc-02', '请帮我算 58 − 17 − 9。', [calculate]),
  scenario('计算', 'calc-03', '一袋玩具 88 元，打七五折，打完折是多少钱？', [calculate]),
  scenario('计算', 'calc-04', '我画了 12 个圈。为什么平均分的时候，每一份都要一样多？', [mentor]),
  scenario('计算', 'calc-05', '这题先别帮我算。37×16 应该从个位开始写，还是从十位？', [mentor]),
  scenario('计算', 'calc-06', '我算了 44.8 除以 7 等于 6.4，你帮我验证结果对吗？', [calculate]),
  scenario('计算', 'calc-07', '我姐姐说“6×8 擦掉”。这句话里的“擦掉”是啥意思？', [], {
    role: '兔子罗布',
  }),
  scenario('计算', 'calc-08', '我们队有 12 人，另一个队也有 12 人。我今天只想聊我们队的名字。', []),

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
  ...roleComparison('role-12', '朋友一直抢着发言，我想礼貌地请他等我说完，可以怎么开口？', '水豚蛋蛋', '考拉安仔'),
  ...roleComparison('role-13', '我怎么改提示词，能让 AI 画同一个角色时衣服不老是变？', '鳄鱼爸爸', '兔子罗布'),
];
