// Transport instructions stay separate from character text and memory versions.
export const CHAT_OUTPUT_PROMPT = `【聊天消息输出格式】
你决定这轮发几条消息。正文必须是一个 JSON 对象，只有 messages 字段，值为非空字符串数组；每一项是一条独立消息。不要输出对象以外的文字或包裹 JSON 的代码围栏。
应用只展示数组里的消息文字，用户看不到 JSON 外壳。用户要求“只回纯文本”“不要JSON”“禁止大括号”，指的是他看到的消息内容；仍把那句话写进 messages 字符串，不能因此省略外壳、输出空白或改变传输格式。
日常默认 1 条，确实有第二拍、第三拍才发 2～3 条；每条通常 5～20 字，最多 30 字。够了就停，不凑字数、条数，不把一长段话切碎来绕过限制。
对方明确要求详细介绍、解释、步骤、比较、长文或代码时，可以写长；先决定需要几条消息，再在每条内部安排段落。单换行、空行、列表和代码块都是这条消息的正文，不表示另发一条。一个完整的讲解通常放在一条消息里，按内容分段；不要为了换段而另开消息。日常最多 3 条的限制不套在明确要求展开的长回复上。
需要调用工具时仍实际调用工具，调用前正文可为空，或用同一 JSON 格式只接 1 条短话。工具返回后再给最终消息；日常若已经发过工具前的短话，最终最多再发 2 条，不重复这句短话。
普通查数、算数也是日常短回复，不因用了工具就展开科普。用户发来纯算式，就是请你计算，不当成乱码或没话找话；给出数值前调用 calculate。用户明确要求使用某个已提供的工具时，实际调用后再答，不用口算或猜测替代。
例如普通两条消息：{"messages":["好啊","那六点你也得醒"]}
例如一条消息内分段：{"messages":["第一段正文。\\n\\n第二段正文。"]}
这里只规定传输格式和话量；人物性格、接话方式、事实及安全边界仍按角色设定。不要对用户解释这个格式。`;

export const CHAT_RESPONSE_FORMAT = Object.freeze({ type: 'json_object' });
export class ReplyFormatError extends Error {
  constructor() { super('这轮回复格式不完整，请重试。'); this.name = 'ReplyFormatError'; }
}

export function decodeChatOutput(content, { maxMessages = 32, allowEmpty = false } = {}) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    if (allowEmpty) return { messages: [], format: 'empty' };
    throw new ReplyFormatError();
  }
  let value;
  try { value = JSON.parse(text); }
  catch {
    // Legacy/plain-text providers remain usable as ONE message. Never infer
    // boundaries from newlines, and never expose a broken protocol envelope.
    if (/^[{[\"]/.test(text) || /"messages"\s*:/.test(text) || /^```(?:json)?\s*\n\s*[{[]/i.test(text)) throw new ReplyFormatError();
    return { messages: [content], format: 'plain-fallback' };
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== 1 || !Array.isArray(value.messages) ||
      (!value.messages.length && !allowEmpty) || value.messages.length > maxMessages ||
      !value.messages.every(item => typeof item === 'string' && item.trim())) throw new ReplyFormatError();
  return { messages: value.messages, format: 'messages-v1' };
}

export function chatHistoryForModel(history) {
  return history.map(message => message.role === 'assistant'
    ? { ...message, text: JSON.stringify({ messages: Array.isArray(message.parts) && message.parts.length &&
      message.parts.every(part => typeof part === 'string' && part.trim()) ? message.parts : [message.text] }) }
    : message);
}
