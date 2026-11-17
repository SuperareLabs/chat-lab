import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { TelegramApi, privateUpdate } from './platform.mjs';
import { BotDatabase } from './database.mjs';
import { TelegramCore } from './core.mjs';
import { createVoiceRecognizer } from './asr.mjs';
import { readConfig } from '../config.mjs';

const COMMANDS = [
  ['start', '开始使用'], ['roles', '选择角色'], ['new', '新会话，保留记忆'], ['create', '创建私人角色'],
  ['myroles', '我的私人角色'], ['memory', '查看当前角色记忆'], ['history', '查看最近聊天'],
  ['profile', '查看或修改个人资料'], ['settings', '设置'], ['stop', '停止当前生成'],
  ['resend', '重发上一份回答，不重新生成'], ['cancel', '取消编辑或语音确认'], ['help', '指令说明'], ['id', '查看自己的ID'],
];

export class TelegramApp {
  constructor({ env = process.env, config = readConfig(env), api, database, core } = {}) {
    if (config.model.thinking !== 'disabled') throw new Error('Telegram 测试版须关闭思考');
    const ids = (env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids.some(id => !/^[1-9]\d{0,15}$/.test(id)) || ids.length > 16) throw new Error('白名单只接受最多16个数字用户ID');
    if (env.TELEGRAM_PUBLIC_ACCESS !== undefined && !['0', '1'].includes(env.TELEGRAM_PUBLIC_ACCESS)) throw new Error('TELEGRAM_PUBLIC_ACCESS 须为0或1');
    this.publicAccess = env.TELEGRAM_PUBLIC_ACCESS === '1';
    this.env = env; this.config = config; this.allowed = ids;
    this.dir = env.TELEGRAM_DATA_DIR || '/var/lib/chat-lab-telegram';
    this.api = api || new TelegramApi(env.TELEGRAM_BOT_TOKEN);
    this.db = database || new BotDatabase(join(this.dir, 'bot.sqlite'));
    this.core = core; this.stopped = false; this.lastPollAt = 0;
    this.stopController = new AbortController();
  }
  async initialize() {
    const me = await this.api.call('getMe');
    const hook = await this.api.call('getWebhookInfo');
    if (hook.url) throw new Error('已有Webhook，未擅自接管或删除');
    const previous = this.db.db.prepare("SELECT value FROM meta WHERE key='bot_id'").get()?.value;
    if (previous && previous !== String(me.id)) throw new Error('Bot身份与数据目录不一致');
    this.db.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('bot_id',?)").run(String(me.id));
    const limit = Number(this.env.TELEGRAM_DAILY_CHAT_LIMIT || 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('测试版每日聊天额度须为1–1000');
    this.core ??= new TelegramCore({ database: this.db, dataDir: this.dir, botId: me.id,
      allowedUsers: this.allowed, publicAccess: this.publicAccess, config: this.config, dailyLimit: limit, asr: createVoiceRecognizer(this.env),
      voiceLoader: voice => this.api.voice(voice), typing: chatId => this.api.call('sendChatAction', { chat_id: chatId, action: 'typing' }),
    });
    this.core.start();
    await this.api.call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })), scope: { type: 'all_private_chats' } });
    await this.api.call('setChatMenuButton', { menu_button: { type: 'commands' } });
    this.identity = { id: me.id, username: me.username };
    return this.identity;
  }
  offset() { return Number(this.db.db.prepare("SELECT value FROM meta WHERE key='offset'").get()?.value || 0); }
  async pollOnce() {
    const updates = await this.api.call('getUpdates', { offset: this.offset(), timeout: 25, limit: 50, allowed_updates: ['message', 'callback_query'] }, 35_000);
    for (const update of updates) {
      if (this.stopped) break;
      // accept commits the incoming update before polling offset advances.
      this.core.accept(update);
      this.db.db.prepare("INSERT INTO meta(key,value) VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(update.update_id + 1));
      const callbackId = privateUpdate(update)?.callbackId;
      if (callbackId) void this.api.call('answerCallbackQuery', { callback_query_id: callbackId }).catch(() => {});
    }
    this.lastPollAt = Date.now();
    writeFileSync(join(this.dir, 'heartbeat'), String(this.lastPollAt), { mode: 0o600 });
  }
  async deliverOnce() {
    const item = this.db.claim();
    if (!item) return false;
    try {
      const receipt = await this.api.call('sendMessage', item.body);
      this.db.receipt({ id: item.id, state: 'sent', telegramId: receipt.message_id });
    } catch (error) {
      this.db.receipt({ id: item.id, state: error.code === 429 ? 'pending' : error.unknown ? 'unknown' : 'failed', retryAfter: error.retryAfter });
    }
    return true;
  }
  async sleep(ms) { await pause(ms, null, { signal: this.stopController.signal }).catch(() => {}); }
  async run() {
    const poll = async () => {
      while (!this.stopped) {
        try { await this.pollOnce(); }
        catch (error) {
          if (this.stopped) break;
          // No raw errors: fetch exceptions may contain secret-bearing URLs.
          console.error(JSON.stringify({ event: 'telegram_poll_failed', code: error.code ?? error.status ?? 'transport' }));
          await this.sleep(error.retryAfter ? error.retryAfter * 1000 : 5000);
        }
      }
    };
    const send = async () => { while (!this.stopped) { await this.deliverOnce(); await this.sleep(200); } };
    this.running = Promise.all([poll(), send()]);
    await this.running;
  }
  async stop() {
    this.stopped = true; this.stopController.abort(); this.api.close();
    await this.running?.catch(() => {});
    await this.core?.stop(); this.db.close();
  }
}
