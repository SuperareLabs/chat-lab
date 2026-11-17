import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { splitTelegramText } from './platform.mjs';

export class BotDatabase {
  constructor(path) {
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
    const columns = new Set(this.db.prepare('PRAGMA table_info(inbox)').all().map(c => c.name));
    if (!columns.has('source')) this.db.exec('ALTER TABLE inbox ADD COLUMN source TEXT');
    if (!columns.has('confirmed_from')) this.db.exec('ALTER TABLE inbox ADD COLUMN confirmed_from INTEGER');
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
  finish(row, messages, error = null) {
    this.transaction(() => {
      for (const [logicalIndex, message] of messages.entries()) {
        const body = typeof message === 'string' ? { text: message } : message;
        for (const [fragmentIndex, text] of splitTelegramText(body.text).entries()) {
          const packet = { chat_id: row.user_id, text, ...(fragmentIndex === 0 && body.reply_markup ? { reply_markup: body.reply_markup } : {}) };
          this.db.prepare('INSERT OR IGNORE INTO outbox(update_id,user_id,logical_index,fragment_index,body) VALUES(?,?,?,?,?)')
            .run(row.id, row.user_id, logicalIndex, fragmentIndex, JSON.stringify(packet));
        }
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
    const row = this.db.prepare('SELECT state FROM outbox WHERE id=?').get(id);
    if (!row || row.state === 'sent') return;
    this.db.prepare('UPDATE outbox SET state=?,telegram_id=?,retry_at=? WHERE id=?')
      .run(state, telegramId, Date.now() + Math.min(3600, Math.max(1, Number(retryAfter) || 1)) * 1000, id);
  }
  close() { this.db.close(); }
}
