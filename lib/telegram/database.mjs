import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { splitTelegramText } from './platform.mjs';

export class BotDatabase {
  constructor(path, { systemMessageTtlMs = 60_000 } = {}) {
    this.systemMessageTtlMs = systemMessageTtlMs;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, selected_role TEXT, draft TEXT, profile_id TEXT);
      CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', role_id TEXT, text TEXT, error TEXT, source TEXT, confirmed_from INTEGER);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, update_id INTEGER NOT NULL,
        user_id TEXT NOT NULL, logical_index INTEGER NOT NULL, fragment_index INTEGER NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', retry_at INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER,
        telegram_id INTEGER, UNIQUE(update_id,logical_index,fragment_index));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_cleanup(user_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      due_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,message_id));
      CREATE INDEX IF NOT EXISTS cleanup_due ON message_cleanup(state,due_at);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(inbox)').all().map(c => c.name));
    if (!columns.has('source')) this.db.exec('ALTER TABLE inbox ADD COLUMN source TEXT');
    if (!columns.has('confirmed_from')) this.db.exec('ALTER TABLE inbox ADD COLUMN confirmed_from INTEGER');
    if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(c => c.name === 'ephemeral')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0');
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  user(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  ensureUser(id) { this.db.prepare('INSERT OR IGNORE INTO users(id) VALUES(?)').run(id); return this.user(id); }
  updateUser(id, field, value) {
    if (!['selected_role', 'draft', 'profile_id'].includes(field)) throw new Error('Invalid user field');
    this.db.prepare(`UPDATE users SET ${field}=? WHERE id=?`).run(value, id);
  }
  accept(update, input) {
    const source = { messageId: input.messageId, date: input.date, kind: input.voice ? 'voice' : input.isCallback ? 'callback' : 'text',
      ...(input.voice ? { fileId: input.voice.file_id, duration: input.voice.duration } : {}) };
    return this.db.prepare('INSERT OR IGNORE INTO inbox(id,user_id,payload,source) VALUES(?,?,?,?)')
      .run(update.update_id, input.userId, JSON.stringify(update), JSON.stringify(source)).changes > 0;
  }
  next(userId) { return this.db.prepare("SELECT * FROM inbox WHERE user_id=? AND state IN ('queued','running') ORDER BY id LIMIT 1").get(userId); }
  queuedUsers() { return this.db.prepare("SELECT DISTINCT user_id FROM inbox WHERE state IN ('queued','running')").all().map(row => row.user_id); }
  bind(id, role, text) { this.db.prepare("UPDATE inbox SET state='running',role_id=?,text=? WHERE id=?").run(role, text, id); }
  finish(row, messages, error = null, { ephemeral = false, deleteInput = false } = {}) {
    this.transaction(() => {
      for (const [logicalIndex, message] of messages.entries()) {
        const body = typeof message === 'string' ? { text: message } : message;
        for (const [fragmentIndex, text] of splitTelegramText(body.text).entries()) {
          const packet = { chat_id: row.user_id, text, ...(fragmentIndex === 0 && body.reply_markup ? { reply_markup: body.reply_markup } : {}) };
          this.db.prepare('INSERT OR IGNORE INTO outbox(update_id,user_id,logical_index,fragment_index,body,ephemeral) VALUES(?,?,?,?,?,?)')
            .run(row.id, row.user_id, logicalIndex, fragmentIndex, JSON.stringify(packet), Number(body.ephemeral ?? ephemeral));
        }
      }
      const source = this.db.prepare('SELECT source FROM inbox WHERE id=?').get(row.id)?.source;
      const input = source ? JSON.parse(source) : null;
      // Only confirmed management text inputs; voice and normal chat are retained.
      if (deleteInput && input?.kind === 'text' && Number.isSafeInteger(input.messageId)) {
        this.scheduleCleanup(row.user_id, input.messageId);
      }
      this.db.prepare("UPDATE inbox SET state='done',error=?,payload='{}' WHERE id=?").run(error, row.id);
    });
  }
  claim(now = Date.now()) {
    return this.transaction(() => {
      // A lost send receipt is not proof of non-delivery. Never blindly re-send.
      this.db.prepare("UPDATE outbox SET state='unknown' WHERE state='sending' AND claimed_at<?").run(now - 10 * 60_000);
      const row = this.db.prepare(`SELECT o.* FROM outbox o WHERE o.state='pending' AND o.retry_at<=?
        AND NOT EXISTS(SELECT 1 FROM outbox p WHERE p.user_id=o.user_id AND p.id<o.id AND p.state IN ('pending','sending'))
        ORDER BY o.id LIMIT 1`).get(now);
      if (!row) return null;
      this.db.prepare("UPDATE outbox SET state='sending',claimed_at=? WHERE id=?").run(now, row.id);
      return { id: row.id, body: JSON.parse(row.body) };
    });
  }
  receipt({ id, state, telegramId = null, retryAfter = 0 }) {
    if (!Number.isSafeInteger(id) || !['sent', 'unknown', 'failed', 'pending'].includes(state)) throw new Error('Invalid receipt');
    const row = this.db.prepare('SELECT state,user_id,ephemeral FROM outbox WHERE id=?').get(id);
    if (!row || row.state === 'sent') return;
    this.transaction(() => {
      this.db.prepare('UPDATE outbox SET state=?,telegram_id=?,retry_at=? WHERE id=?')
        .run(state, telegramId, Date.now() + Math.min(3600, Math.max(1, Number(retryAfter) || 1)) * 1000, id);
      if (state === 'sent' && row.ephemeral && Number.isSafeInteger(telegramId)) this.scheduleCleanup(row.user_id, telegramId);
    });
  }
  scheduleCleanup(userId, messageId, due = Date.now() + this.systemMessageTtlMs) {
    this.db.prepare('INSERT OR IGNORE INTO message_cleanup(user_id,message_id,due_at) VALUES(?,?,?)').run(userId, messageId, due);
  }
  expireExistingControls() {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key='ephemeral_controls_v1'").get()) return;
    this.transaction(() => {
      // Chat input was always durably bound to inbox.text before model calls.
      // Null text therefore identifies old management-only responses. Exclude
      // /resend groups, which contain copies of real character messages.
      const rows = this.db.prepare(`SELECT o.id,o.user_id,o.state,o.telegram_id FROM outbox o JOIN inbox i ON i.id=o.update_id
        WHERE i.state='done' AND i.text IS NULL
          AND NOT EXISTS(SELECT 1 FROM outbox r WHERE r.update_id=o.update_id
            AND json_extract(r.body,'$.text')='以下重发上一份已保存回答：')`).all();
      for (const row of rows) {
        this.db.prepare('UPDATE outbox SET ephemeral=1 WHERE id=?').run(row.id);
        if (row.state === 'sent' && Number.isSafeInteger(row.telegram_id)) this.scheduleCleanup(row.user_id, row.telegram_id);
      }
      this.db.prepare("INSERT INTO meta(key,value) VALUES('ephemeral_controls_v1','1')").run();
    });
  }
  nextCleanup(now = Date.now()) {
    return this.db.prepare("SELECT * FROM message_cleanup WHERE state='pending' AND due_at<=? ORDER BY due_at,message_id LIMIT 1").get(now);
  }
  finishCleanup(item, { done = false, retryAfter = null } = {}) {
    const retry = !done && retryAfter !== null && item.attempts < 8;
    this.db.prepare('UPDATE message_cleanup SET state=?,attempts=attempts+1,due_at=? WHERE user_id=? AND message_id=?')
      .run(done ? 'done' : retry ? 'pending' : 'failed', Date.now() + Math.min(3600, Math.max(1, Number(retryAfter) || 1)) * 1000, item.user_id, item.message_id);
  }
  close() { this.db.close(); }
}
