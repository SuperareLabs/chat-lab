import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { problem } from './store.mjs';
import { normalizeVideoVoiceId } from './agent-voice.mjs';

const MAX_ACTIVE_AGENTS = 256;
const hash = value => createHash('sha256').update(value).digest('hex');
const ownKeysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).every(key => keys.includes(key));

function ownerHash(ownerKey, optional = false) {
  if (optional && ownerKey == null) return null;
  if (typeof ownerKey !== 'string' || !/^[a-f0-9]{64}$/.test(ownerKey)) throw problem('缺少有效的角色管理凭证', 403);
  return hash(ownerKey);
}

function input(value, update = false) {
  const keys = update ? ['name', 'definition', 'revision', 'videoVoiceId'] : ['name', 'definition', 'requestId', 'videoVoiceId'];
  if (!ownKeysAre(value, keys) || typeof value.name !== 'string' || !value.name.trim() ||
      value.name.trim().length > 80 || /[\0\r\n]/.test(value.name) ||
      typeof value.definition !== 'string' || !value.definition.trim() || value.definition.includes('\0') ||
      Buffer.byteLength(value.definition, 'utf8') > 56_000) throw problem('请填写有效的名称与角色设定，名称最多80字，设定最多56000字节');
  if (update) revision(value);
  else if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestId)) {
    throw problem('创建角色需要有效的请求编号');
  }
  return { name: value.name.trim(), definition: value.definition, videoVoiceId: normalizeVideoVoiceId(value.videoVoiceId),
    ...(update ? { revision: value.revision } : { requestId: value.requestId }) };
}

function revision(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1) throw problem('角色 revision 须为正整数');
}

function owns(row, candidate) {
  return Boolean(candidate && row?.owner_hash && timingSafeEqual(Buffer.from(row.owner_hash, 'hex'), Buffer.from(candidate, 'hex')));
}

function agent(row, candidate) {
  const voice = row.video_voice_id ? { videoVoiceId: row.video_voice_id } : {};
  return { id: row.id, name: row.name, definition: row.definition, revision: row.revision,
    version: `public-v${row.revision}`, createdAt: row.created_at, updatedAt: row.updated_at,
    ...voice, metadata: { publicCatalog: true, publicRevision: row.revision, ...voice }, canManage: owns(row, candidate) };
}

/** Stores shared role definitions and hashed management credentials only. */
export class PublicCatalog {
  constructor({ path = ':memory:' } = {}) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('公共角色库路径无效');
    const filename = path === ':memory:' ? path : resolve(path);
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.some(row => !['public_catalog_meta', 'public_catalog_agents'].includes(row.name))) {
        throw new Error('指定文件不是公共角色库，请使用独立数据库文件');
      }
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS public_catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO public_catalog_meta(id,revision) VALUES(1,0);
        CREATE TABLE IF NOT EXISTS public_catalog_agents (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, revision INTEGER NOT NULL,
          owner_hash TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, video_voice_id TEXT,
          UNIQUE(owner_hash,request_id)
        );`);
      if (!this.db.prepare('PRAGMA table_info(public_catalog_agents)').all().some(column => column.name === 'video_voice_id')) {
        this.db.exec('ALTER TABLE public_catalog_agents ADD COLUMN video_voice_id TEXT');
      }
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  currentRevision() { return this.db.prepare('SELECT revision FROM public_catalog_meta WHERE id=1').get().revision; }
  advanceRevision() { this.db.exec('UPDATE public_catalog_meta SET revision=revision+1 WHERE id=1'); return this.currentRevision(); }

  list(ownerKey) {
    const candidate = ownerHash(ownerKey, true);
    const rows = this.db.prepare('SELECT * FROM public_catalog_agents ORDER BY created_at,rowid').all();
    return { revision: this.currentRevision(), agents: rows.filter(row => row.deleted_at === null).map(row => agent(row, candidate)),
      deletedIds: rows.filter(row => row.deleted_at !== null).map(row => row.id) };
  }

  create(value, { ownerKey } = {}) {
    const candidate = ownerHash(ownerKey), data = input(value);
    const fingerprint = hash(JSON.stringify([data.name, data.definition, ...(data.videoVoiceId ? [data.videoVoiceId] : [])]));
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM public_catalog_agents WHERE owner_hash=? AND request_id=?').get(candidate, data.requestId);
      if (existing) {
        if (existing.request_hash !== fingerprint) throw problem('同一创建请求的内容已变化，请重新创建', 409);
        if (existing.deleted_at !== null) throw problem('此角色已删除，请使用新的创建请求', 410);
        return { agent: agent(existing, candidate), catalogRevision: this.currentRevision() };
      }
      if (this.db.prepare('SELECT COUNT(*) AS n FROM public_catalog_agents WHERE deleted_at IS NULL').get().n >= MAX_ACTIVE_AGENTS) {
        throw problem('公共角色库已满，请先删除不再使用的角色', 409);
      }
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO public_catalog_agents(id,name,definition,revision,owner_hash,request_id,request_hash,created_at,updated_at,video_voice_id)
        VALUES(?,?,?,1,?,?,?,?,?,?)`).run(id, data.name, data.definition, candidate, data.requestId, fingerprint, now, now, data.videoVoiceId || null);
      const catalogRevision = this.advanceRevision();
      return { agent: agent(this.db.prepare('SELECT * FROM public_catalog_agents WHERE id=?').get(id), candidate), catalogRevision };
    });
  }

  update(id, value, { ownerKey } = {}) {
    const candidate = ownerHash(ownerKey), data = input(value, true);
    return this.transaction(() => {
      const row = this.manageable(id, candidate);
      if (row.deleted_at !== null) throw problem('此角色已删除', 410);
      if (row.revision !== data.revision) throw problem('此角色已更新，请重新载入后再保存', 409);
      const voice = data.videoVoiceId === undefined ? row.video_voice_id : data.videoVoiceId || null;
      this.db.prepare('UPDATE public_catalog_agents SET name=?,definition=?,video_voice_id=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(data.name, data.definition, voice, new Date().toISOString(), id);
      const catalogRevision = this.advanceRevision();
      return { agent: agent(this.db.prepare('SELECT * FROM public_catalog_agents WHERE id=?').get(id), candidate), catalogRevision };
    });
  }

  delete(id, value, { ownerKey } = {}) {
    const candidate = ownerHash(ownerKey);
    if (!ownKeysAre(value, ['revision'])) throw problem('删除角色仅接受 revision');
    revision(value);
    return this.transaction(() => {
      const row = this.manageable(id, candidate);
      if (row.deleted_at !== null) return { deleted: true, id, catalogRevision: this.currentRevision() };
      if (row.revision !== value.revision) throw problem('此角色已更新，请重新载入后再删除', 409);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE public_catalog_agents SET revision=revision+1,updated_at=?,deleted_at=? WHERE id=?').run(now, now, id);
      return { deleted: true, id, catalogRevision: this.advanceRevision() };
    });
  }

  manageable(id, candidate) {
    if (typeof id !== 'string' || !id || id.length > 100) throw problem('找不到此公共角色', 404);
    const row = this.db.prepare('SELECT * FROM public_catalog_agents WHERE id=?').get(id);
    if (!row) throw problem('找不到此公共角色', 404);
    if (!owns(row, candidate)) throw problem('只有创建者可以修改或删除此角色', 403);
    return row;
  }

  close() { this.db.close(); }
}
