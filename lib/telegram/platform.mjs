// Channel framing is independent of persona content and paragraph boundaries.
export function splitTelegramText(text, limit = 4096) {
  const chars = Array.from(text);
  const parts = [];
  while (chars.length) parts.push(chars.splice(0, limit).join(''));
  return parts;
}

export function privateUpdate(update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  const from = callback?.from ?? message?.from;
  if (message?.chat?.type !== 'private' || from?.is_bot || !Number.isSafeInteger(from?.id) ||
      from.id <= 0 || from.id !== message.chat.id) return null;
  if (callback && (typeof callback.data !== 'string' || callback.data.length > 64)) return null;
  return { userId: String(from.id), chatId: String(message.chat.id), messageId: message.message_id,
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 48) || '朋友',
    username: typeof from.username === 'string' ? from.username.slice(0, 64) : null,
    text: callback?.data ?? (typeof message.text === 'string' ? message.text : ''),
    callbackId: callback?.id, voice: callback ? null : message.voice,
    date: message.date, isCallback: !!callback };
}

export function command(text) {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), arg: (match[2] ?? '').trim() } : null;
}

export class TelegramApiError extends Error {
  constructor(code, retryAfter = null, unknown = false) {
    // Never expose provider URLs, response descriptions or request bodies.
    super(`Telegram API ${code}`); this.code = code; this.retryAfter = retryAfter; this.unknown = unknown;
  }
}

export class TelegramApi {
  constructor(token, { fetchImpl = fetch } = {}) {
    if (!/^\d{5,16}:[A-Za-z0-9_-]{25,100}$/.test(token ?? '')) throw new Error('Telegram Token 格式无效');
    this.token = token; this.fetch = fetchImpl; this.controller = new AbortController();
  }
  async call(method, body = {}, timeoutMs = 15_000) {
    let response, data;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
      data = await response.json();
    } catch { throw new TelegramApiError('TRANSPORT', null, true); }
    if (!data.ok) throw new TelegramApiError(data.error_code || response.status, data.parameters?.retry_after);
    return data.result;
  }
  close() { this.controller.abort(); }
  async voice(voice) {
    if (!Number.isFinite(voice?.duration) || voice.duration > 120 || voice.duration < 0 ||
        (voice.file_size != null && voice.file_size > 8 * 1024 * 1024)) throw new Error('语音限两分钟、8MB以内');
    const info = await this.call('getFile', { file_id: voice.file_id });
    // Only Telegram-originated relative paths; never use a user-provided URL.
    if (!/^voice\/[\w./-]+$/.test(info.file_path ?? '') || info.file_path.includes('..')) throw new Error('语音下载路径无效');
    let response;
    try { response = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`, { signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('语音下载失败，请重新发送'); }
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 8 * 1024 * 1024) throw new Error('语音下载失败或文件超限');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024) { await response.body.cancel?.().catch(() => {}); throw new Error('语音文件超过8MB'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('base64');
  }
}
