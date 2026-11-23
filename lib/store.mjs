import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { briefFingerprint, renderContextBrief, CONTEXT_BRIEF_VERSION } from './context-brief.mjs';
import { normalizeVideoVoiceId } from './agent-voice.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const encode = JSON.stringify;
const decode = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
export function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function childRow(row) {
  if (!row) return null;
  const { id, name, age, gender, interests } = row;
  return { id, name, age, interests: decode(interests, []), ...(gender ? { gender } : {}) };
}
function sessionRow(row) {
  if (!row) return null;
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
    status: row.status, memoryStatus: row.memory_status ?? 'none' };
}
function messageRow(row) {
  return { id: row.id, role: row.role, text: row.text, createdAt: row.created_at,
    ...(row.parts ? { parts: decode(row.parts, []) } : {}),
    ...(row.attachment ? { attachment: decode(row.attachment) } : {}) };
}
function agentRow(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, definition: row.definition, metadata: decode(row.metadata, {}),
    revision: row.revision, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function agentInput(value, { update = false } = {}) {
  const allowed = update ? ['name', 'definition', 'revision', 'videoVoiceId'] : ['name', 'definition', 'videoVoiceId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).some(key => !allowed.includes(key)) ||
      !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'definition') ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.includes('\0') ||
      typeof value.definition !== 'string' || !value.definition.trim() || value.definition.includes('\0')) {
    throw problem('角色仅接受非空的名称与定义，且不得包含 NUL 或额外字段');
  }
  if (update && (!Object.hasOwn(value, 'revision') || !Number.isSafeInteger(value.revision) || value.revision < 1)) {
    throw problem('角色 revision 须为正整数');
  }
  // The definition is user-authored text. Its whitespace and line endings are data.
  return { name: value.name.trim(), definition: value.definition, videoVoiceId: normalizeVideoVoiceId(value.videoVoiceId),
    ...(update ? { revision: value.revision } : {}) };
}
function itemRow(row, withDetail = false) {
  const item = { memoryId: row.id, mentionedOn: row.mentioned_on, summary: row.summary,
    kind: row.kind ?? 'event', state: row.state ?? 'active', topics: decode(row.topics, []),
    lastMentionedAt: row.last_mentioned_at ?? row.mentioned_at,
    createdAt: row.created_at ?? row.committed_at, version: row.version,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.retracted_at ? { retractedAt: row.retracted_at } : {}) };
  if (withDetail) Object.assign(item, { detail: decode(row.detail, {}),
    anchorMessageId: row.anchor_id,
    detailMeaning: 'original_record_with_sourced_changes',
    detailChanges: decode(row.detail_changes, []), summaryHistory: decode(row.summary_history, []),
    sourceMessageIds: decode(row.source_ids, []),
    ...(row.retraction_reason ? { retractionReason: row.retraction_reason } : {}) });
  return item;
}

const profileDefaults = () => ({ preferred_name: null, interest: [], conversation_preference: [] });

export class ChatStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS lab_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS children (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER, gender TEXT, interests TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS soul_profiles (
        child_id TEXT NOT NULL REFERENCES children(id), agent_id TEXT NOT NULL, profile TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (child_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), agent_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_activity_at TEXT, closed_at TEXT, recent_snapshot TEXT, context TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_session ON sessions(child_id, agent_id) WHERE status = 'open';
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, parts TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, seq);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES messages(id), assistant_id TEXT REFERENCES messages(id),
        user_count INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, error TEXT, UNIQUE(child_id, agent_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS runs_by_session ON runs(session_id, status);
      CREATE TABLE IF NOT EXISTS jobs (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), child_id TEXT NOT NULL REFERENCES children(id),
        agent_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
        finished_at TEXT, error TEXT, item_count INTEGER, source_snapshot TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_by_scope ON jobs(child_id, agent_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id), anchor_id TEXT NOT NULL REFERENCES messages(id),
        source_ids TEXT NOT NULL, mentioned_at TEXT NOT NULL, mentioned_on TEXT NOT NULL, summary TEXT NOT NULL,
        detail TEXT, committed_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS memories_by_scope_time ON memories(child_id, agent_id, mentioned_at DESC);
      CREATE TABLE IF NOT EXISTS profile_writes (
        run_id TEXT NOT NULL REFERENCES runs(id), field TEXT NOT NULL, operation TEXT NOT NULL, value TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES messages(id), result TEXT NOT NULL, written_at TEXT NOT NULL,
        PRIMARY KEY(run_id, field, operation, value)
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        record_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,
        tool_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        entry TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_by_session ON usage_records(session_id, created_at);
    `);
    if (!this.sql('PRAGMA table_info(runs)').all().some(column => column.name === 'user_count')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN user_count INTEGER NOT NULL DEFAULT 1');
    }
    if (!this.sql('PRAGMA table_info(messages)').all().some(column => column.name === 'parts')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN parts TEXT');
    }
    if (!this.sql('PRAGMA table_info(messages)').all().some(column => column.name === 'attachment')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN attachment TEXT');
    }
    const memoryColumns = new Set(this.sql('PRAGMA table_info(memories)').all().map(column => column.name));
    const additions = {
      state: "TEXT NOT NULL DEFAULT 'active'", kind: "TEXT NOT NULL DEFAULT 'event'",
      topics: "TEXT NOT NULL DEFAULT '[]'", created_at: 'TEXT', last_mentioned_at: 'TEXT', content_at: 'TEXT',
      detail_changes: "TEXT NOT NULL DEFAULT '[]'", summary_history: "TEXT NOT NULL DEFAULT '[]'",
      archived_at: 'TEXT', retracted_at: 'TEXT', retraction_reason: 'TEXT',
    };
    for (const [name, definition] of Object.entries(additions)) if (!memoryColumns.has(name)) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
    const jobColumns = new Set(this.sql('PRAGMA table_info(jobs)').all().map(column => column.name));
    for (const name of ['input_context', 'result', 'output_snapshot']) if (!jobColumns.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} TEXT`);
    if (!jobColumns.has('attempt_history')) this.db.exec("ALTER TABLE jobs ADD COLUMN attempt_history TEXT NOT NULL DEFAULT '[]'");
    this.db.exec(`
      UPDATE memories SET created_at=COALESCE(created_at,committed_at),
        last_mentioned_at=COALESCE(last_mentioned_at,mentioned_at),content_at=COALESCE(content_at,mentioned_at)
        WHERE created_at IS NULL OR last_mentioned_at IS NULL OR content_at IS NULL;
      CREATE INDEX IF NOT EXISTS memories_by_scope_state ON memories(child_id,agent_id,state,last_mentioned_at);
      CREATE TABLE IF NOT EXISTS memory_scopes (
        child_id TEXT NOT NULL REFERENCES children(id), agent_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(child_id,agent_id)
      );
      CREATE TABLE IF NOT EXISTS user_overviews (
        child_id TEXT NOT NULL REFERENCES children(id), agent_id TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '', memory_ids TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT, source_at TEXT, stale INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(child_id,agent_id)
      );
      CREATE TABLE IF NOT EXISTS memory_mentions (
        memory_id TEXT NOT NULL REFERENCES memories(id), anchor_id TEXT NOT NULL REFERENCES messages(id),
        session_id TEXT NOT NULL REFERENCES sessions(id), source_ids TEXT NOT NULL,
        mentioned_at TEXT NOT NULL, mentioned_on TEXT NOT NULL, operation TEXT NOT NULL,
        PRIMARY KEY(memory_id,anchor_id)
      );
      CREATE INDEX IF NOT EXISTS memory_mentions_by_date ON memory_mentions(memory_id,mentioned_on);
      INSERT OR IGNORE INTO memory_mentions(memory_id,anchor_id,session_id,source_ids,mentioned_at,mentioned_on,operation)
        SELECT id,anchor_id,session_id,source_ids,mentioned_at,mentioned_on,'create' FROM memories;
      CREATE TABLE IF NOT EXISTS context_briefs (
        child_id TEXT NOT NULL REFERENCES children(id), agent_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id), model_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, source_snapshot TEXT NOT NULL, selection TEXT, result TEXT, output TEXT, error TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        PRIMARY KEY(child_id,agent_id,fingerprint)
      );
      CREATE INDEX IF NOT EXISTS context_briefs_by_status ON context_briefs(status,created_at);
    `);
  }

  sql(text) { return this.db.prepare(text); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  agentsInitialized() {
    return !!this.sql("SELECT 1 FROM lab_meta WHERE key='agents_initialized'").get();
  }

  hasLegacyAgentData() {
    if (this.sql("SELECT 1 FROM lab_meta WHERE key='data_version'").get()) return true;
    return !!this.sql(`SELECT 1 FROM children UNION ALL SELECT 1 FROM sessions
      UNION ALL SELECT 1 FROM soul_profiles UNION ALL SELECT 1 FROM messages
      UNION ALL SELECT 1 FROM runs UNION ALL SELECT 1 FROM jobs UNION ALL SELECT 1 FROM memories
      UNION ALL SELECT 1 FROM profile_writes UNION ALL SELECT 1 FROM usage_records
      UNION ALL SELECT 1 FROM memory_scopes UNION ALL SELECT 1 FROM user_overviews
      UNION ALL SELECT 1 FROM memory_mentions UNION ALL SELECT 1 FROM context_briefs LIMIT 1`).get();
  }

  agentRecords() {
    return this.sql('SELECT * FROM agents ORDER BY created_at,id').all().map(agentRow);
  }

  agentRecord(id) {
    if (typeof id !== 'string') return null;
    return agentRow(this.sql('SELECT * FROM agents WHERE id=?').get(id));
  }

  initializeAgents(seeds, now, { importSeeds = false } = {}) {
    return this.transaction(() => {
      if (this.agentsInitialized()) return { initialized: false, imported: 0 };
      let imported = 0;
      if (importSeeds) {
        if (!Array.isArray(seeds)) throw problem('角色迁移来源须为列表');
        for (const seed of seeds) {
          if (!seed || typeof seed !== 'object' || Array.isArray(seed) ||
              Reflect.ownKeys(seed).some(key => !['id', 'name', 'definition', 'metadata', 'version'].includes(key)) ||
              typeof seed.id !== 'string' || !seed.id.trim() || seed.id.includes('\0')) throw problem('角色迁移来源无效');
          const { name, definition } = agentInput({ name: seed.name, definition: seed.definition });
          const metadata = seed.metadata ?? {};
          if (typeof metadata !== 'object' || Array.isArray(metadata)) throw problem('角色迁移 metadata 须为 JSON 对象');
          let encodedMetadata;
          try { encodedMetadata = encode(metadata); } catch { throw problem('角色迁移 metadata 须为 JSON 对象'); }
          const version = seed.version ?? 'db-v1';
          if (typeof version !== 'string' || !version.trim() || version.includes('\0')) throw problem('角色迁移 version 无效');
          imported += this.sql(`INSERT OR IGNORE INTO agents(id,name,definition,metadata,revision,version,created_at,updated_at)
            VALUES(?,?,?,?,1,?,?,?)`).run(seed.id, name, definition, encodedMetadata, version, now, now).changes;
        }
      }
      // A deliberately empty first initialization is final too: restart must not
      // reinstall legacy configuration over the database's role inventory.
      this.sql("INSERT INTO lab_meta(key,value) VALUES('agents_initialized','1')").run();
      return { initialized: true, imported };
    });
  }

  createAgent(value, now) {
    const { name, definition, videoVoiceId } = agentInput(value);
    return this.transaction(() => {
      const id = randomUUID();
      this.sql(`INSERT INTO agents(id,name,definition,metadata,revision,version,created_at,updated_at)
        VALUES(?,?,?,?,1,'db-v1',?,?)`).run(id, name, definition, encode(videoVoiceId ? { videoVoiceId } : {}), now, now);
      return this.agentRecord(id);
    });
  }

  updateAgent(id, value, now) {
    const { name, definition, revision, videoVoiceId } = agentInput(value, { update: true });
    return this.transaction(() => {
      const current = this.agentRecord(id);
      if (!current) throw problem('角色不存在', 404);
      if (current.revision !== revision || revision === Number.MAX_SAFE_INTEGER) {
        throw problem('角色已更新，请重新读取后再保存', 409);
      }
      const nextRevision = revision + 1;
      const metadata = videoVoiceId === undefined ? current.metadata : { ...current.metadata, videoVoiceId };
      const changed = this.sql(`UPDATE agents SET name=?,definition=?,metadata=?,revision=?,version=?,updated_at=?
        WHERE id=? AND revision=?`).run(name, definition, encode(metadata), nextRevision, `db-v${nextRevision}`, now, id, revision).changes;
      if (!changed) throw problem('角色已更新，请重新读取后再保存', 409);
      return this.agentRecord(id);
    });
  }

  activateVersion(version, now, { compatibleVersions = [], allowReset = true } = {}) {
    const changed = this.transaction(() => {
      const previous = this.sql("SELECT value FROM lab_meta WHERE key = 'data_version'").get()?.value;
      if (previous === version) return false;
      if (previous && compatibleVersions.includes(previous)) {
        this.sql("UPDATE lab_meta SET value = ? WHERE key = 'data_version'").run(version);
        return false;
      }
      if (!allowReset && (previous || this.sql('SELECT 1 FROM children LIMIT 1').get())) {
        throw problem('本次启动禁止重置数据，记忆版本不兼容；已有用户、会话和记忆已保留', 409);
      }
      this.db.exec(`
        DELETE FROM context_briefs;
        DELETE FROM usage_records;
        DELETE FROM profile_writes;
        DELETE FROM memory_mentions;
        DELETE FROM user_overviews;
        DELETE FROM memory_scopes;
        DELETE FROM memories;
        DELETE FROM jobs;
        DELETE FROM runs;
        DELETE FROM messages;
        DELETE FROM sessions;
        DELETE FROM soul_profiles;
        DELETE FROM children;
        DELETE FROM sqlite_sequence WHERE name = 'messages';
      `);
      this.createChild({ name: '马超', age: 8, interests: [] }, now);
      this.sql("INSERT INTO lab_meta (key, value) VALUES ('data_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(version);
      return true;
    });
    if (changed) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  clearMemories(now) {
    return this.transaction(() => {
      const running = this.sql(`SELECT 1 FROM runs WHERE status='running'
        UNION ALL SELECT 1 FROM jobs WHERE status='running'
        UNION ALL SELECT 1 FROM context_briefs WHERE status='running' LIMIT 1`).get();
      if (running) throw problem('仍有聊天、记忆或概括任务运行，未清空记忆', 409);

      const deleted = {};
      for (const table of ['memory_mentions', 'user_overviews', 'context_briefs', 'memory_scopes',
        'memories', 'soul_profiles', 'profile_writes']) {
        deleted[table] = this.sql('DELETE FROM ' + table).run().changes;
      }
      const closedSessions = this.sql(`UPDATE sessions SET status='closed',closed_at=COALESCE(closed_at,?),
        recent_snapshot=NULL,context=NULL`).run(now).changes;
      const result = encode({ resetSkipped: true, resetAt: now });
      const updatedJobs = this.sql(`UPDATE jobs SET status='succeeded',started_at=NULL,finished_at=?,
        error=NULL,item_count=0,source_snapshot=NULL,input_context=NULL,result=?,output_snapshot=NULL,attempt_history='[]'`)
        .run(now, result).changes;
      // Every old session gets a terminal marker, including empty sessions. This
      // prevents closeSession's INSERT OR IGNORE from queuing old messages again.
      const insertedJobs = this.sql(`INSERT OR IGNORE INTO jobs(session_id,child_id,agent_id,status,created_at,finished_at,item_count,result)
        SELECT id,child_id,agent_id,'succeeded',?,?,0,? FROM sessions`).run(now, now, result).changes;
      this.sql(`INSERT INTO lab_meta(key,value) VALUES('memory_reset_at',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(now);
      return { deleted, closedSessions, sealedJobs: updatedJobs + insertedJobs, resetAt: now };
    });
  }

  recover(now) {
    this.transaction(() => {
      this.sql("UPDATE runs SET status = 'failed', error = ? WHERE status = 'running'").run('上一轮在服务重启时中断');
      this.sql("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'")
        .run('上次整理在服务重启时中断，未重复发送模型请求', now);
      this.sql("UPDATE context_briefs SET status='failed',error=?,finished_at=? WHERE status='running'")
        .run('上次聊天概括生成在服务重启时中断，未自动重试', now);
    });
  }

  close() { this.db.close(); }
  children() { return this.sql('SELECT * FROM children ORDER BY created_at, id').all().map(childRow); }
  child(id) { return childRow(this.sql('SELECT * FROM children WHERE id = ?').get(id)); }

  createChild({ name, age, interests }, now) {
    const id = randomUUID();
    this.sql('INSERT INTO children(id, name, age, interests, created_at) VALUES(?,?,?,?,?)')
      .run(id, name, age, encode(interests), now);
    return this.child(id);
  }

  profile(childId, agentId) {
    const childProfile = this.child(childId);
    const data = this.sql('SELECT profile FROM soul_profiles WHERE child_id = ? AND agent_id = ?').get(childId, agentId);
    return { childProfile, soulProfile: { ...profileDefaults(), ...decode(data?.profile, {}) } };
  }

  active(childId, agentId) {
    return this.sql("SELECT * FROM sessions WHERE child_id = ? AND agent_id = ? AND status = 'open'").get(childId, agentId);
  }

  rawSession(id, childId, agentId) {
    return this.sql(`SELECT s.*, j.status AS memory_status FROM sessions s LEFT JOIN jobs j ON j.session_id = s.id
      WHERE s.id = ? AND s.child_id = ? AND s.agent_id = ?`).get(id, childId, agentId);
  }

  sessions(childId, agentId) {
    return this.sql(`SELECT s.*, j.status AS memory_status FROM sessions s LEFT JOIN jobs j ON j.session_id = s.id
      WHERE s.child_id = ? AND s.agent_id = ? ORDER BY s.updated_at DESC, s.rowid DESC`).all(childId, agentId).map(sessionRow);
  }

  session(id, childId, agentId) {
    const row = this.rawSession(id, childId, agentId);
    if (!row) return null;
    return { session: sessionRow(row), messages: this.messages(id), context: decode(row.context), usage: this.usage(id) };
  }

  recordUsage({ key, sessionId, runId = null, kind, name = null, ...entry }, now) {
    this.sql(`INSERT INTO usage_records(record_key,session_id,run_id,kind,tool_name,created_at,updated_at,entry)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET updated_at=excluded.updated_at,entry=excluded.entry`)
      .run(key, sessionId, runId, kind, name, now, now, encode({ ...entry, kind, name, recordedAt: now }));
    return { ...entry, kind, name, recordedAt: now };
  }

  usage(sessionId) {
    const rows = this.sql('SELECT kind,created_at,entry FROM usage_records WHERE session_id=? ORDER BY rowid').all(sessionId);
    const entries = rows.map(row => decode(row.entry, {}));
    const requests = entries.filter(entry => entry.kind !== 'local_tool');
    const sum = key => {
      const values = requests.map(entry => entry[key]).filter(value => typeof value === 'number' && Number.isFinite(value));
      return values.length ? values.reduce((a, b) => a + b, 0) : requests.length ? null : 0;
    };
    const untrackedTurns = this.sql(`SELECT count(*) AS n FROM runs r WHERE r.session_id=? AND NOT EXISTS
      (SELECT 1 FROM usage_records u WHERE u.run_id=r.id AND u.kind='chat')`).get(sessionId).n;
    const untrackedMemoryJobs = this.sql(`SELECT count(*) AS n FROM jobs j WHERE j.session_id=?
      AND j.status IN ('running','succeeded','failed') AND NOT EXISTS
      (SELECT 1 FROM usage_records u WHERE u.session_id=j.session_id AND u.kind='memory')
      AND CASE WHEN json_valid(j.result) THEN json_type(j.result,'$.resetSkipped') IS NOT 'true' ELSE 1 END`).get(sessionId).n;
    const arkRequests = requests.filter(entry => !entry.mediaBilling);
    const missingUsageCalls = arkRequests.filter(entry => entry.usageStatus !== 'reported').length;
    const unpricedCalls = arkRequests.filter(entry => entry.modelCostCny == null || entry.toolCostCny == null || entry.totalCostCny == null).length;
    const lastChat = entries.findLast(entry => entry.kind === 'chat' && Number.isFinite(entry.inputTokens));
    const latestContext = lastChat && Number.isFinite(lastChat.inputTokens) ? {
      inputTokens: lastChat.inputTokens, model: lastChat.model,
      contextWindowTokens: lastChat.contextWindowTokens ?? null,
      outputReserveTokens: lastChat.outputReserveTokens ?? null,
      measuredAt: lastChat.recordedAt,
    } : null;
    return {
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
      cachedTokens: sum('cachedTokens'), reasoningTokens: sum('reasoningTokens'), searchCalls: sum('searchCalls'),
      modelCostCny: sum('modelCostCny'), toolCostCny: sum('toolCostCny'), totalCostCny: sum('totalCostCny'),
      knownCostCny: sum('knownCostCny'),
      recordedCalls: requests.length, chatCalls: entries.filter(entry => entry.kind === 'chat').length,
      searchRequests: entries.filter(entry => entry.kind === 'search').length,
      memoryCalls: entries.filter(entry => entry.kind === 'memory').length,
      toolCalls: entries.filter(entry => ['search', 'local_tool', 'character_media'].includes(entry.kind)).length,
      missingUsageCalls, unpricedCalls, untrackedTurns, untrackedMemoryJobs,
      partial: !!(missingUsageCalls || unpricedCalls || untrackedTurns || untrackedMemoryJobs),
      latestContext, trackingStartedAt: rows[0]?.created_at ?? null,
      calls: entries,
    };
  }

  messages(id) {
    return this.sql('SELECT id, role, text, created_at, parts, attachment FROM messages WHERE session_id = ? ORDER BY seq').all(id).map(messageRow);
  }

  closeSession(row, at) {
    this.sql("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(at, row.id);
    if (row.last_activity_at) {
      this.sql(`INSERT OR IGNORE INTO jobs(session_id, child_id, agent_id, status, created_at)
        VALUES(?,?,?,'queued',?)`).run(row.id, row.child_id, row.agent_id, at);
    }
  }

  newSession(childId, agentId, now) {
    const id = randomUUID();
    this.sql('INSERT INTO sessions(id, child_id, agent_id, title, created_at, updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, childId, agentId, '新会话', now, now);
    return this.rawSession(id, childId, agentId);
  }

  manuallyOpen(childId, agentId, now) {
    return this.transaction(() => {
      const active = this.active(childId, agentId);
      if (active) this.closeSession(active, now);
      return sessionRow(this.newSession(childId, agentId, now));
    });
  }

  closeDue(now, idleMs) {
    const cutoff = new Date(Date.parse(now) - idleMs).toISOString();
    return this.transaction(() => {
      const due = this.sql("SELECT * FROM sessions WHERE status = 'open' AND last_activity_at <= ?").all(cutoff);
      for (const session of due) this.closeSession(session, new Date(Date.parse(session.last_activity_at) + idleMs).toISOString());
      return due.length;
    });
  }

  nextDeadline(idleMs) {
    const next = this.sql("SELECT MIN(last_activity_at) AS last_at FROM sessions WHERE status = 'open'").get().last_at;
    return next ? Date.parse(next) + idleMs : null;
  }

  beginChat({ childId, agentId, sessionId, text: singleText, messages = [{ text: singleText }], requestId }, now, idleMs) {
    return this.transaction(() => {
      if (sessionId && !this.rawSession(sessionId, childId, agentId)) throw problem('找不到此会话', 404);
      const existing = this.sql('SELECT * FROM runs WHERE child_id = ? AND agent_id = ? AND request_id = ?')
        .get(childId, agentId, requestId);
      if (existing) {
        // Each run inserts its user messages consecutively in this same transaction.
        const original = this.sql(`SELECT text FROM messages WHERE session_id = ?
          AND seq >= (SELECT seq FROM messages WHERE id = ?) ORDER BY seq LIMIT ?`)
          .all(existing.session_id, existing.user_id, existing.user_count);
        if (original.length !== messages.length || original.some((message, index) => message.text !== messages[index].text)) {
          throw problem('此请求 ID 已用于其他消息', 409);
        }
        if (existing.status === 'running') throw problem('这条消息仍在生成', 409);
        const reply = existing.assistant_id && this.sql('SELECT text, parts, attachment FROM messages WHERE id = ?').get(existing.assistant_id);
        return { replay: true, sessionId: existing.session_id, status: existing.status, error: existing.error,
          reply: reply?.text, parts: decode(reply?.parts), attachment: decode(reply?.attachment),
          toolAcknowledged: !!this.sql('SELECT 1 FROM usage_records WHERE run_id=? AND tool_name IS NOT NULL LIMIT 1').get(existing.id) };
      }
      let session = this.active(childId, agentId);
      if (session?.last_activity_at && Date.parse(now) - Date.parse(session.last_activity_at) >= idleMs) {
        this.closeSession(session, new Date(Date.parse(session.last_activity_at) + idleMs).toISOString());
        session = null;
      }
      session ??= this.newSession(childId, agentId, now);
      if (this.sql("SELECT 1 FROM runs WHERE session_id = ? AND status = 'running'").get(session.id)) {
        throw problem('这个会话已有一条消息正在生成', 409);
      }
      const insert = this.sql("INSERT INTO messages(id, session_id, role, text, created_at) VALUES(?,?,'user',?,?)");
      const nowMs = Date.parse(now);
      const userMessages = messages.map(({ text, createdAt }) => {
        const id = randomUUID();
        const ageMs = nowMs - Date.parse(createdAt);
        insert.run(id, session.id, text, ageMs >= 0 && ageMs <= 60_000 ? createdAt : now);
        return { id, text };
      });
      const userId = userMessages[0].id;
      const runId = randomUUID();
      this.sql(`INSERT INTO runs(id, child_id, agent_id, session_id, request_id, user_id, user_count, status)
        VALUES(?,?,?,?,?,?,?,'running')`).run(runId, childId, agentId, session.id, requestId, userId, userMessages.length);
      const text = userMessages.map(message => message.text).join('\n');
      const recent = session.recent_snapshot == null ? this.recent(childId, agentId, now) : decode(session.recent_snapshot, []);
      const title = session.last_activity_at ? session.title : Array.from(text.replace(/\s+/g, ' ')).slice(0, 26).join('');
      this.sql('UPDATE sessions SET last_activity_at = ?, updated_at = ?, title = ?, recent_snapshot = ? WHERE id = ?')
        .run(now, now, title, encode(recent), session.id);
      return { runId, userId, userMessages, sessionId: session.id, recent, childId, agentId, text };
    });
  }

  recordContext(sessionId, context) {
    this.sql('UPDATE sessions SET context = ? WHERE id = ?').run(encode(context), sessionId);
  }

  finishChat(run, { reply, parts, attachment, error }, now) {
    this.transaction(() => {
      if (this.sql('SELECT status FROM runs WHERE id = ?').get(run.runId)?.status !== 'running') return;
      let assistantId = null;
      if (reply || attachment) {
        assistantId = randomUUID();
        this.sql("INSERT INTO messages(id, session_id, role, text, created_at, parts, attachment) VALUES(?,?,'assistant',?,?,?,?)")
          .run(assistantId, run.sessionId, reply || '', now, Array.isArray(parts) && parts.length ? encode(parts) : null,
            attachment ? encode(attachment) : null);
      }
      this.sql('UPDATE runs SET status = ?, assistant_id = ?, error = ? WHERE id = ?')
        .run(error ? 'failed' : 'succeeded', assistantId, error ?? null, run.runId);
      this.sql('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, run.sessionId);
    });
  }

  recent(childId, agentId, anchor) {
    const start = new Date(Date.parse(anchor) - WEEK_MS).toISOString();
    return this.sql(`SELECT * FROM memories
      WHERE child_id = ? AND agent_id = ? AND state != 'retracted' AND last_mentioned_at >= ? AND last_mentioned_at <= ? AND committed_at <= ?
      ORDER BY last_mentioned_at DESC, rowid DESC`).all(childId, agentId, start, anchor, anchor).map(row => itemRow(row));
  }

  recentEventSummaries(childId, agentId, now) {
    return this.sql(`SELECT summary, COALESCE(last_mentioned_at, mentioned_at) AS lastMentionedAt
      FROM memories
      WHERE child_id=? AND agent_id=? AND kind='event' AND state IN ('active','archived')
        AND committed_at<=? AND COALESCE(last_mentioned_at, mentioned_at)<=?
      ORDER BY lastMentionedAt DESC, rowid DESC LIMIT 3`).all(childId, agentId, now, now);
  }

  allMemories(childId, agentId) {
    return this.sql('SELECT * FROM memories WHERE child_id = ? AND agent_id = ? ORDER BY last_mentioned_at DESC, rowid DESC')
      .all(childId, agentId).map(row => itemRow(row));
  }

  memoryDetail(id, childId, agentId, { includeRetracted = false } = {}) {
    const row = this.sql('SELECT * FROM memories WHERE id = ? AND child_id = ? AND agent_id = ?').get(id, childId, agentId);
    if (!row || (!includeRetracted && row.state === 'retracted')) return null;
    const item = itemRow(row, true);
    item.mentions = this.sql(`SELECT anchor_id,session_id,source_ids,mentioned_at,mentioned_on,operation
      FROM memory_mentions WHERE memory_id=? ORDER BY mentioned_at DESC,anchor_id`).all(id).map(mention => ({
      anchorMessageId: mention.anchor_id, sessionId: mention.session_id,
      sourceMessageIds: decode(mention.source_ids, []), mentionedAt: mention.mentioned_at,
      mentionedOn: mention.mentioned_on, operation: mention.operation,
    }));
    return item;
  }

  recall(childId, agentId, { query, fromDate = '0000-01-01', toDate = '9999-12-31' }) {
    const rows = this.sql(`SELECT * FROM memories m WHERE child_id=? AND agent_id=? AND state!='retracted'
      AND (EXISTS(SELECT 1 FROM memory_mentions mm WHERE mm.memory_id=m.id AND mm.mentioned_on BETWEEN ? AND ?)
        OR m.mentioned_on BETWEEN ? AND ?)
      ORDER BY last_mentioned_at DESC,rowid DESC`).all(childId, agentId, fromDate, toDate, fromDate, toDate);
    const hits = rankMemories(rows, query).filter(hit => hit.score > 0);
    const items = hits.slice(0, 6).map(({ row }) => ({ ...itemRow(row),
      matchedMentionDates: [...new Set(this.sql(`SELECT mentioned_on FROM memory_mentions
        WHERE memory_id=? AND mentioned_on BETWEEN ? AND ? ORDER BY mentioned_at DESC`)
        .all(row.id, fromDate, toDate).map(mention => mention.mentioned_on))] }));
    return { status: items.length ? 'matched' : 'no_match', items };
  }

  memoryRevision(childId, agentId) {
    return this.sql('SELECT revision FROM memory_scopes WHERE child_id=? AND agent_id=?').get(childId, agentId)?.revision ?? 0;
  }

  memoryCounts(childId, agentId) {
    const counts = { active: 0, archived: 0, retracted: 0, activeLimit: 500 };
    for (const row of this.sql('SELECT state,count(*) AS n FROM memories WHERE child_id=? AND agent_id=? GROUP BY state').all(childId, agentId)) {
      if (Object.hasOwn(counts, row.state)) counts[row.state] = row.n;
    }
    return counts;
  }

  userOverview(childId, agentId) {
    const row = this.sql('SELECT * FROM user_overviews WHERE child_id=? AND agent_id=?').get(childId, agentId);
    if (!row) return { summary: '', memoryIds: [], version: 0, updatedAt: null, stale: false };
    const memoryIds = decode(row.memory_ids, []);
    const referenced = memoryIds.map(id => this.sql("SELECT id,summary FROM memories WHERE id=? AND child_id=? AND agent_id=? AND kind='understanding' AND state!='retracted'").get(id, childId, agentId));
    const valid = referenced.every(Boolean);
    const stale = !!row.stale || !valid;
    // Free-form model overview text is retained in the job audit only. Runtime
    // context is assembled from the current, effective atomic understanding
    // records, so an unrelated event or withdrawn name cannot leak through an
    // otherwise structurally valid model paragraph.
    const effective = stale ? { summary: '', memoryIds: [] } : composeOverview(referenced);
    return { ...effective,
      version: row.version, updatedAt: row.updated_at, stale };
  }

  /** Read-only source projection: prior valid overview sources, including
   * archives, plus active understandings. No mention timestamps are touched. */
  readBriefSources(childId, agentId, { modelName = '' } = {}) {
    const selected = new Map();
    const overview = this.sql('SELECT memory_ids FROM user_overviews WHERE child_id=? AND agent_id=?').get(childId, agentId);
    for (const id of decode(overview?.memory_ids, [])) {
      if (selected.size >= 500) break;
      const row = this.sql("SELECT id,summary,kind FROM memories WHERE id=? AND child_id=? AND agent_id=? AND kind='understanding' AND state IN ('active','archived')")
        .get(id, childId, agentId);
      if (row) selected.set(row.id, row);
    }
    for (const row of this.sql("SELECT id,summary,kind FROM memories WHERE child_id=? AND agent_id=? AND kind='understanding' AND state='active' ORDER BY id")
      .all(childId, agentId)) {
      if (selected.size >= 500) break;
      selected.set(row.id, row);
    }
    const records = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { fingerprint: briefFingerprint(records, { modelName: String(modelName ?? '') }), records };
  }

  readContextBrief(childId, agentId, { modelName = '' } = {}) {
    const input = this.readBriefSources(childId, agentId, { modelName });
    const base = { fingerprint: input.fingerprint, version: CONTEXT_BRIEF_VERSION };
    if (!input.records.length) return { ...renderContextBrief(null, []), ...base,
      mode: 'source_fallback', status: 'empty', generatedAt: null };
    const row = this.sql('SELECT * FROM context_briefs WHERE child_id=? AND agent_id=? AND fingerprint=?')
      .get(childId, agentId, input.fingerprint);
    if (row?.status === 'succeeded') {
      try {
        const selection = decode(row.selection);
        validateBriefSelection(selection, input.records);
        // Rebuild solely from current source text. Even a corrupted cached
        // result paragraph cannot introduce facts into the chat context.
        return { ...renderContextBrief(selection, input.records), ...base, mode: 'cached', status: 'ready',
          generatedAt: row.finished_at, updatedAt: row.finished_at };
      } catch {
        return { ...renderContextBrief(null, input.records), ...base, mode: 'source_fallback', status: 'failed',
          generatedAt: null, error: '概括缓存来源校验未通过，暂用当前有效原文' };
      }
    }
    return { ...renderContextBrief(null, input.records), ...base, mode: 'source_fallback',
      status: row?.status === 'stale' ? 'failed' : row?.status ?? 'queued', generatedAt: null,
      ...(row?.error ? { error: row.error } : {}) };
  }

  ensureContextBrief(childId, agentId, now, { modelName = '', sessionId } = {}) {
    return this.transaction(() => {
      if (!this.child(childId) || typeof agentId !== 'string' || !agentId) throw problem('概括用户或角色不存在', 404);
      let session;
      if (sessionId != null) {
        session = this.sql('SELECT id FROM sessions WHERE id=? AND child_id=? AND agent_id=?').get(sessionId, childId, agentId);
        if (!session) throw problem('概括用量归属会话不属于当前用户与角色', 404);
      }
      const input = this.readBriefSources(childId, agentId, { modelName });
      if (!input.records.length) return { ...this.readContextBrief(childId, agentId, { modelName }), queued: false };
      const existing = this.sql('SELECT 1 FROM context_briefs WHERE child_id=? AND agent_id=? AND fingerprint=?')
        .get(childId, agentId, input.fingerprint);
      if (existing) return { ...this.readContextBrief(childId, agentId, { modelName }), queued: false };
      session ??= this.sql('SELECT id FROM sessions WHERE child_id=? AND agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(childId, agentId);
      if (!session) return { ...this.readContextBrief(childId, agentId, { modelName }), queued: false };
      this.sql(`INSERT INTO context_briefs(child_id,agent_id,fingerprint,session_id,model_name,status,source_snapshot,created_at)
        VALUES(?,?,?,?,?,'queued',?,?)`).run(childId, agentId, input.fingerprint, session.id,
        String(modelName ?? ''), encode(input.records), now);
      return { ...this.readContextBrief(childId, agentId, { modelName }), queued: true };
    });
  }

  claimContextBrief(now, { modelName } = {}) {
    return this.transaction(() => {
      for (;;) {
        const row = this.sql("SELECT * FROM context_briefs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
        if (!row) return null;
        const changedModel = modelName !== undefined && row.model_name !== String(modelName ?? '');
        const input = this.readBriefSources(row.child_id, row.agent_id, { modelName: row.model_name });
        if (changedModel || input.fingerprint !== row.fingerprint || !input.records.length) {
          this.sql("UPDATE context_briefs SET status='stale',error=?,finished_at=? WHERE child_id=? AND agent_id=? AND fingerprint=? AND status='queued'")
            .run('概括来源或生成模型已变化，旧任务未调用模型', now, row.child_id, row.agent_id, row.fingerprint);
          continue;
        }
        this.sql("UPDATE context_briefs SET status='running',started_at=? WHERE child_id=? AND agent_id=? AND fingerprint=? AND status='queued'")
          .run(now, row.child_id, row.agent_id, row.fingerprint);
        return { ...row, status: 'running', started_at: now, records: input.records };
      }
    });
  }

  recordContextBriefOutput(job, response) {
    const snapshot = { content: typeof response?.content === 'string' ? response.content : '',
      receipt: safeDiagnostic(response?.receipt ?? null), metrics: safeDiagnostic(response?.metrics ?? null) };
    return this.sql("UPDATE context_briefs SET output=? WHERE child_id=? AND agent_id=? AND fingerprint=? AND session_id=? AND status='running'")
      .run(encode(snapshot), job.child_id, job.agent_id, job.fingerprint, job.session_id).changes > 0;
  }

  commitContextBrief(job, selection, now, { modelName = job.model_name } = {}) {
    return this.transaction(() => {
      const row = this.sql("SELECT * FROM context_briefs WHERE child_id=? AND agent_id=? AND fingerprint=? AND session_id=? AND status='running'")
        .get(job.child_id, job.agent_id, job.fingerprint, job.session_id);
      if (!row) return { committed: false };
      const input = this.readBriefSources(row.child_id, row.agent_id, { modelName });
      if (String(modelName ?? '') !== row.model_name || input.fingerprint !== row.fingerprint) {
        this.sql("UPDATE context_briefs SET status='stale',error=?,finished_at=? WHERE child_id=? AND agent_id=? AND fingerprint=? AND status='running'")
          .run('概括来源已变化，本次结果没有覆盖当前概括', now, row.child_id, row.agent_id, row.fingerprint);
        return { committed: false, stale: true };
      }
      validateBriefSelection(selection, input.records);
      const result = renderContextBrief(selection, input.records);
      this.sql("UPDATE context_briefs SET status='succeeded',selection=?,result=?,finished_at=?,error=NULL WHERE child_id=? AND agent_id=? AND fingerprint=? AND status='running'")
        .run(encode(selection), encode(result), now, row.child_id, row.agent_id, row.fingerprint);
      return { committed: true, view: this.readContextBrief(row.child_id, row.agent_id, { modelName }) };
    });
  }

  failContextBrief(job, error, now) {
    return this.sql("UPDATE context_briefs SET status='failed',error=?,finished_at=? WHERE child_id=? AND agent_id=? AND fingerprint=? AND session_id=? AND status='running'")
      .run(String(error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300), now,
        job.child_id, job.agent_id, job.fingerprint, job.session_id).changes > 0;
  }

  memoryInput(childId, agentId, source) {
    return this.transaction(() => this.readMemoryInput(childId, agentId, source));
  }

  readMemoryInput(childId, agentId, source) {
    const rows = this.sql("SELECT * FROM memories WHERE child_id=? AND agent_id=? AND state!='retracted' ORDER BY last_mentioned_at DESC,id").all(childId, agentId);
    const overview = this.userOverview(childId, agentId);
    // Visible assistant text can resolve a user's short acknowledgement such
    // as "对，就是那次". It is a retrieval clue only: selecting a candidate
    // never touches it, and commit still requires an actual user anchor.
    const query = source.filter(message => ['user', 'assistant'].includes(message.role))
      .map(message => message.text).join('\n');
    const ranked = rankMemories(rows, query);
    const byId = new Map(rows.map(row => [row.id, row]));
    const selected = new Map();
    for (const id of overview.memoryIds) if (byId.has(id)) selected.set(id, byId.get(id));
    for (const { row, score } of ranked) if (score > 0 && selected.size < 500) selected.set(row.id, row);
    for (const row of rows) if (row.state === 'active' && selected.size < 500) selected.set(row.id, row);
    const memoryIndex = [...selected.values()].slice(0, 500).map(row => ({
      id: row.id, version: row.version, state: row.state, kind: row.kind,
      summary: row.summary, topics: decode(row.topics, []),
      lastMentionedAt: row.last_mentioned_at,
      ...(decode(row.detail, {})?.occurredAt ? { occurredAt: decode(row.detail, {}).occurredAt } : {}),
    }));
    return { memoryIndex, overview, revision: this.memoryRevision(childId, agentId) };
  }

  jobList(childId, agentId) {
    return this.sql('SELECT * FROM jobs WHERE child_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(childId, agentId).map(row => ({
        sessionId: row.session_id, status: row.status, createdAt: row.created_at, startedAt: row.started_at,
        finishedAt: row.finished_at, error: row.error, itemCount: row.item_count,
        input: decode(row.input_context), result: decode(row.result),
        output: decode(row.output_snapshot), attempts: decode(row.attempt_history, []),
      }));
  }

  recordMemoryInput(job, context) {
    this.sql("UPDATE jobs SET input_context=? WHERE session_id=? AND child_id=? AND agent_id=? AND status='running'")
      .run(encode(context), job.session_id, job.child_id, job.agent_id);
  }

  recordMemoryOutput(job, response, { stage = 'extraction' } = {}) {
    if (!['extraction', 'repair', 'review'].includes(stage)) throw problem('记忆输出阶段须为 extraction、repair 或历史 review', 400);
    const snapshotOf = value => ({
      content: typeof value?.content === 'string' ? value.content : '',
      receipt: safeDiagnostic(value?.receipt ?? null), metrics: safeDiagnostic(value?.metrics ?? null),
    });
    return this.transaction(() => {
      const row = this.sql("SELECT output_snapshot FROM jobs WHERE session_id=? AND child_id=? AND agent_id=? AND status='running'")
        .get(job.session_id, job.child_id, job.agent_id);
      if (!row) return false;
      const previous = decode(row.output_snapshot, {});
      const stages = {};
      for (const name of ['extraction', 'repair', 'review']) {
        if (previous?.stages?.[name]) stages[name] = snapshotOf(previous.stages[name]);
      }
      // Existing single-call snapshots are the extraction evidence. Keep the
      // top-level view stable when a repair or historical review is appended.
      if (!stages.extraction && typeof previous?.content === 'string') stages.extraction = snapshotOf(previous);
      stages[stage] = snapshotOf(response);
      const snapshot = { ...(stages.extraction ?? snapshotOf(null)), stages,
        ...(Array.isArray(previous.validationFailures) ? { validationFailures: safeDiagnostic(previous.validationFailures) } : {}) };
      const written = this.sql("UPDATE jobs SET output_snapshot=? WHERE session_id=? AND child_id=? AND agent_id=? AND status='running'")
        .run(encode(snapshot), job.session_id, job.child_id, job.agent_id);
      return written.changes > 0;
    });
  }

  recordMemoryValidationFailure(job, { stage, error }, now) {
    if (!['extraction', 'repair'].includes(stage)) throw problem('记忆校验阶段须为 extraction 或 repair', 400);
    return this.transaction(() => {
      const row = this.sql("SELECT output_snapshot FROM jobs WHERE session_id=? AND child_id=? AND agent_id=? AND status='running'")
        .get(job.session_id, job.child_id, job.agent_id);
      if (!row) return false;
      const previous = decode(row.output_snapshot, {});
      const failure = { stage, message: typeof error?.message === 'string' ? error.message : String(error),
        validationContext: safeDiagnostic(error?.validationContext ?? null), at: now };
      const snapshot = { ...previous, validationFailures: [...(Array.isArray(previous.validationFailures)
        ? safeDiagnostic(previous.validationFailures) : []), failure] };
      return this.sql("UPDATE jobs SET output_snapshot=? WHERE session_id=? AND child_id=? AND agent_id=? AND status='running'")
        .run(encode(snapshot), job.session_id, job.child_id, job.agent_id).changes > 0;
    });
  }

  retryJob(sessionId, childId, agentId, now) {
    return this.transaction(() => {
      const row = this.sql('SELECT * FROM jobs WHERE session_id=? AND child_id=? AND agent_id=?').get(sessionId, childId, agentId);
      if (!row) throw problem('找不到此用户与角色的记忆任务', 404);
      if (row.status !== 'failed') throw problem('只有失败的记忆任务可以手动重试；任务未重复排队', 409);
      const attempts = [...decode(row.attempt_history, []), {
        startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
        input: decode(row.input_context), result: decode(row.result), output: decode(row.output_snapshot),
      }];
      this.sql(`UPDATE jobs SET status='queued',created_at=?,started_at=NULL,finished_at=NULL,error=NULL,item_count=NULL,
        input_context=NULL,result=NULL,output_snapshot=NULL,attempt_history=? WHERE session_id=? AND status='failed'`)
        .run(now, encode(attempts), sessionId);
      return { sessionId, status: 'queued', attempts: attempts.length };
    });
  }

  claimJob(now) {
    return this.transaction(() => {
      const job = this.sql(`SELECT j.* FROM jobs j WHERE j.status = 'queued'
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.session_id = j.session_id AND r.status = 'running')
        ORDER BY j.created_at, j.rowid LIMIT 1`).get();
      if (!job) return null;
      const snapshot = decode(job.source_snapshot) ?? this.messages(job.session_id);
      this.sql("UPDATE jobs SET status = 'running', started_at = ?, source_snapshot = ? WHERE session_id = ?")
        .run(now, encode(snapshot), job.session_id);
      return { ...job, snapshot };
    });
  }

  commitJob(job, output, now, { timezone = 'Asia/Shanghai', revision } = {}) {
    return this.transaction(() => {
      const actual = this.sql('SELECT * FROM jobs WHERE session_id=?').get(job.session_id);
      if (actual?.child_id !== job.child_id || actual?.agent_id !== job.agent_id) throw problem('记忆任务范围不匹配', 409);
      if (actual.status !== 'running') return { committed: false, replay: actual.status === 'succeeded', result: decode(actual.result) };
      const childId = job.child_id, agentId = job.agent_id;
      const expectedRevision = revision ?? decode(actual.input_context)?.revision;
      if (expectedRevision !== undefined && this.memoryRevision(childId, agentId) !== expectedRevision) {
        throw Object.assign(problem('记忆库已变化，本次结果未覆盖新记忆，也未自动重发模型请求', 409), { code: 'MEMORY_REVISION_CONFLICT' });
      }
      // The legacy array is retained for local fixtures/import compatibility;
      // the runtime's V2 parser never accepts the old model {items} protocol.
      const legacy = Array.isArray(output);
      const plan = legacy ? { creates: output.map(item => ({ kind: 'event', topics: [], ...item })),
        updates: [], mentions: [], retractions: [], overview: null } : output;
      const channels = ['creates', 'updates', 'mentions', 'retractions'];
      if (!plan || typeof plan !== 'object' || channels.some(key => !Array.isArray(plan[key]))) throw problem('记忆更新结构无效');
      const source = decode(actual.source_snapshot) ?? job.snapshot ?? [];
      const sourceById = new Map(source.map(message => [message.id, message]));
      const sourceOrder = new Map(source.map((message, index) => [message.id, index]));
      const before = this.sql('SELECT * FROM memories WHERE child_id=? AND agent_id=?').all(childId, agentId);
      const oldById = new Map(before.map(row => [row.id, row]));
      const operations = [], seen = new Set();
      for (const channel of channels) for (const [index, item] of plan[channel].entries()) {
        if (!item || typeof item !== 'object') throw problem('记忆操作条目无效');
        const anchor = sourceById.get(item.anchorMessageId);
        if (!anchor || (!legacy && anchor.role !== 'user') || !Array.isArray(item.sourceMessageIds) ||
            !item.sourceMessageIds.length || !item.sourceMessageIds.includes(item.anchorMessageId) ||
            !item.sourceMessageIds.every(id => sourceById.has(id))) throw problem('记忆操作缺少有效用户来源');
        const at = anchor.createdAt ?? anchor.sentAt;
        if (!Number.isFinite(Date.parse(at))) throw problem('来源消息时间无效');
        const latest = item.sourceMessageIds.map(id => sourceById.get(id)).filter(message => message.role === 'user')
          .sort((a, b) => Date.parse(b.createdAt ?? b.sentAt) - Date.parse(a.createdAt ?? a.sentAt)
            || sourceOrder.get(b.id) - sourceOrder.get(a.id))[0];
        if (!legacy && latest && latest.id !== anchor.id) throw problem('提及锚点须为来源中最后一条相关用户消息');
        const old = channel !== 'creates' ? oldById.get(item.memoryId) : null;
        if (channel !== 'creates') {
          if (!old || old.state === 'retracted') throw problem('旧记忆不存在、已撤回或不属于当前用户与角色');
          if (seen.has(old.id)) throw problem('同一记忆本轮存在重复或冲突操作');
          seen.add(old.id);
          if (['updates', 'retractions'].includes(channel) && Date.parse(at) < Date.parse(old.content_at)) {
            throw Object.assign(problem('旧会话的内容早于这条记忆的新版本，未覆盖或撤回新内容', 409), { code: 'MEMORY_CONTENT_CONFLICT' });
          }
        }
        if (['creates', 'updates'].includes(channel) && (typeof item.summary !== 'string' || !item.summary.trim())) throw problem('记忆操作缺少摘要');
        if (channel === 'creates' && (!['understanding', 'event'].includes(item.kind) || !Array.isArray(item.topics) || item.topics.some(topic => typeof topic !== 'string' || !topic.trim()))) throw problem('新增记忆类型或主题词无效');
        if (channel === 'updates' && !['supplement', 'correction'].includes(item.changeType)) throw problem('记忆变更类型无效');
        if (channel === 'retractions' && (typeof item.reason !== 'string' || !item.reason.trim())) throw problem('撤回操作缺少依据');
        operations.push({ channel, index, item, old, at, on: localDate(at, timezone) });
      }
      const priorOverview = this.sql('SELECT * FROM user_overviews WHERE child_id=? AND agent_id=?').get(childId, agentId);
      const result = { committed: true, createdIds: [], updatedIds: [], mentionedIds: [], retractedIds: [],
        archivedIds: [], reactivatedIds: [], exactDuplicates: [], overviewUpdated: false };
      const createIds = [];
      const insertMention = (id, op) => this.sql(`INSERT OR IGNORE INTO memory_mentions
        (memory_id,anchor_id,session_id,source_ids,mentioned_at,mentioned_on,operation) VALUES(?,?,?,?,?,?,?)`)
        .run(id, op.item.anchorMessageId, job.session_id, encode([...new Set(op.item.sourceMessageIds)]), op.at, op.on, op.channel);
      const touch = (id, op) => {
        const row = this.sql('SELECT * FROM memories WHERE id=?').get(id);
        const later = Date.parse(op.at) >= Date.parse(row.last_mentioned_at);
        if (row.state === 'archived') result.reactivatedIds.push(id);
        this.sql(`UPDATE memories SET state='active',archived_at=NULL,
          last_mentioned_at=?,mentioned_at=?,mentioned_on=?,anchor_id=?,source_ids=?,version=version+1 WHERE id=?`)
          .run(later ? op.at : row.last_mentioned_at, later ? op.at : row.mentioned_at, later ? op.on : row.mentioned_on,
            later ? op.item.anchorMessageId : row.anchor_id,
            encode([...new Set([...decode(row.source_ids, []), ...op.item.sourceMessageIds])]), id);
        insertMention(id, op);
      };
      for (const op of operations.filter(op => op.channel !== 'creates')) {
        const { item, old } = op;
        if (op.channel === 'retractions') {
          this.sql("UPDATE memories SET state='retracted',retracted_at=?,retraction_reason=?,content_at=?,version=version+1 WHERE id=?")
            .run(op.at, item.reason.trim(), op.at, old.id);
          insertMention(old.id, op);
          result.retractedIds.push(old.id);
          continue;
        }
        if (op.channel === 'updates') {
          const history = [...decode(old.summary_history, []), { summary: old.summary, version: old.version,
            changeType: item.changeType, supersededAt: op.at, sourceMessageIds: decode(old.source_ids, []),
            changedBy: { sessionId: job.session_id, anchorMessageId: item.anchorMessageId, sourceMessageIds: item.sourceMessageIds } }];
          const changes = [...decode(old.detail_changes, []), ...(item.detailDelta ? [{ changeType: item.changeType,
            detailDelta: item.detailDelta, mentionedAt: op.at, sessionId: job.session_id,
            anchorMessageId: item.anchorMessageId, sourceMessageIds: item.sourceMessageIds }] : [])];
          this.sql('UPDATE memories SET summary=?,summary_history=?,detail_changes=?,content_at=? WHERE id=?')
            .run(item.summary.trim(), encode(history), encode(changes), op.at, old.id);
          result.updatedIds.push(old.id);
        } else result.mentionedIds.push(old.id);
        touch(old.id, op);
      }
      for (const op of operations.filter(op => op.channel === 'creates')) {
        const { item } = op;
        const existing = this.sql("SELECT * FROM memories WHERE child_id=? AND agent_id=? AND state!='retracted'")
          .all(childId, agentId).find(row => exactContent(row.summary) === exactContent(item.summary));
        if (existing) {
          if (seen.has(existing.id)) throw problem('新增候选与本轮旧记忆操作重复，未提交冲突结果');
          createIds[op.index] = existing.id;
          result.exactDuplicates.push({ createIndex: op.index, memoryId: existing.id });
          touch(existing.id, op);
          continue;
        }
        const id = randomUUID();
        this.sql(`INSERT INTO memories(id,child_id,agent_id,session_id,anchor_id,source_ids,mentioned_at,mentioned_on,
          summary,detail,committed_at,kind,topics,created_at,last_mentioned_at,content_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, childId, agentId, job.session_id,
          item.anchorMessageId, encode([...new Set(item.sourceMessageIds)]), op.at, op.on, item.summary.trim(),
          item.detail ? encode(item.detail) : null, now, item.kind, encode(item.topics.map(value => value.trim())), now, op.at, op.at);
        createIds[op.index] = id;
        result.createdIds.push(id);
        insertMention(id, op);
      }
      const touchedSemanticIds = new Set([...result.updatedIds, ...result.retractedIds]);
      const referencedChanged = decode(priorOverview?.memory_ids, []).some(id => touchedSemanticIds.has(id));
      let overview = plan.overview;
      if (overview == null && !legacy) {
        const changedUnderstanding = operations.filter(op =>
          op.channel === 'creates' && op.item.kind === 'understanding'
          || op.channel === 'updates' && op.old.kind === 'understanding')
          .map(op => op.channel === 'creates' ? createIds[op.index] : op.old.id)
          .filter(id => this.sql("SELECT 1 FROM memories WHERE id=? AND child_id=? AND agent_id=? AND kind='understanding' AND state!='retracted'")
            .get(id, childId, agentId));
        if (changedUnderstanding.length || referencedChanged) {
          // Resolve creates only after exact deduplication. A proposed
          // understanding may map to an existing event, so the database's
          // effective kind/state/scope, not the draft kind, gates every source.
          const ids = [...new Set([...decode(priorOverview?.memory_ids, []),
            ...changedUnderstanding])];
          const records = ids.map(id => this.sql("SELECT id,summary FROM memories WHERE id=? AND child_id=? AND agent_id=? AND kind='understanding' AND state!='retracted'")
            .get(id, childId, agentId)).filter(Boolean).slice(0, 500);
          const effective = composeOverview(records);
          overview = { summary: effective.summary, memoryIds: effective.memoryIds, createIndexes: [] };
          result.overviewFallback = true;
        }
      }
      if (overview != null) {
        if (typeof overview.summary !== 'string' || overview.summary.length > 1200 || !Array.isArray(overview.memoryIds) ||
            overview.memoryIds.some(id => typeof id !== 'string' || !id) || !Array.isArray(overview.createIndexes) ||
            overview.memoryIds.length + overview.createIndexes.length > 500 ||
            overview.createIndexes.some(index => !Number.isInteger(index) || !createIds[index])) throw problem('用户概括或来源结构无效');
        const memoryIds = [...new Set([...overview.memoryIds, ...overview.createIndexes.map(index => createIds[index])])];
        if ((overview.summary.trim() && !memoryIds.length) || memoryIds.some(id => !this.sql("SELECT 1 FROM memories WHERE id=? AND child_id=? AND agent_id=? AND kind='understanding' AND state!='retracted'").get(id, childId, agentId))) {
          throw problem('用户概括引用了不存在、已撤回或非长期了解的来源');
        }
        const effective = composeOverview(memoryIds.map(id => this.sql('SELECT id,summary FROM memories WHERE id=?').get(id)));
        const latestSource = source.filter(message => message.role === 'user').map(message => message.createdAt ?? message.sentAt)
          .filter(at => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? now;
        if (!priorOverview?.source_at || Date.parse(latestSource) >= Date.parse(priorOverview.source_at)) {
          this.sql(`INSERT INTO user_overviews(child_id,agent_id,summary,memory_ids,version,updated_at,source_at,stale)
            VALUES(?,?,?,?,1,?,?,0) ON CONFLICT(child_id,agent_id) DO UPDATE SET summary=excluded.summary,memory_ids=excluded.memory_ids,
            version=user_overviews.version+1,updated_at=excluded.updated_at,source_at=excluded.source_at,stale=0`)
            .run(childId, agentId, effective.summary, encode(effective.memoryIds), now, latestSource);
          result.overviewUpdated = true;
        } else if (referencedChanged) {
          this.sql("UPDATE user_overviews SET summary='',memory_ids='[]',stale=1,version=version+1,updated_at=? WHERE child_id=? AND agent_id=?")
            .run(now, childId, agentId);
        }
      } else if (referencedChanged) {
        this.sql("UPDATE user_overviews SET summary='',memory_ids='[]',stale=1,version=version+1,updated_at=? WHERE child_id=? AND agent_id=?")
          .run(now, childId, agentId);
      }
      const active = this.sql("SELECT * FROM memories WHERE child_id=? AND agent_id=? AND state='active'").all(childId, agentId)
        .sort((a, b) => Date.parse(a.last_mentioned_at) - Date.parse(b.last_mentioned_at)
          || Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
      for (const row of active.slice(0, Math.max(0, active.length - 500))) {
        this.sql("UPDATE memories SET state='archived',archived_at=?,version=version+1 WHERE id=?").run(now, row.id);
        result.archivedIds.push(row.id);
      }
      result.counts = { created: result.createdIds.length, updated: result.updatedIds.length, mentioned: result.mentionedIds.length,
        retracted: result.retractedIds.length, archived: result.archivedIds.length,
        reactivated: new Set(result.reactivatedIds).size, deduplicated: result.exactDuplicates.length };
      const anyChange = operations.length || result.overviewUpdated || referencedChanged;
      if (anyChange) this.sql(`INSERT INTO memory_scopes(child_id,agent_id,revision) VALUES(?,?,1)
        ON CONFLICT(child_id,agent_id) DO UPDATE SET revision=memory_scopes.revision+1`).run(childId, agentId);
      result.revision = this.memoryRevision(childId, agentId);
      result.memoryCounts = this.memoryCounts(childId, agentId);
      this.sql("UPDATE jobs SET status='succeeded',finished_at=?,item_count=?,result=? WHERE session_id=? AND status='running'")
        .run(now, operations.length, encode({ ...result, plan }), job.session_id);
      return result;
    });
  }

  failJob(job, error, now, { validationContext } = {}) {
    if (validationContext !== undefined) {
      const row = this.sql("SELECT result FROM jobs WHERE session_id=? AND child_id=? AND agent_id=? AND status='running'")
        .get(job.session_id, job.child_id, job.agent_id);
      if (row) this.sql('UPDATE jobs SET result=? WHERE session_id=? AND child_id=? AND agent_id=?')
        .run(encode({ ...decode(row.result, {}), validationContext: safeDiagnostic(validationContext) }), job.session_id, job.child_id, job.agent_id);
    }
    this.sql("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE session_id=? AND child_id=? AND agent_id=? AND status='running'")
      .run(now, String(error), job.session_id, job.child_id, job.agent_id);
  }

  applyProfile(run, { field, operation, value, sourceId = run.userId }, now) {
    return this.transaction(() => {
      const persisted = this.sql("SELECT * FROM runs WHERE id = ? AND status = 'running'").get(run.runId);
      if (!persisted || persisted.child_id !== run.childId || persisted.agent_id !== run.agentId ||
          persisted.session_id !== run.sessionId || persisted.user_id !== run.userId) return { status: 'conflict', field };
      const prior = this.sql('SELECT result FROM profile_writes WHERE run_id = ? AND field = ? AND operation = ? AND value = ?')
        .get(run.runId, field, operation, encode(value));
      if (prior) return decode(prior.result);
      let status = 'unchanged';
      let resultValue;
      if (field === 'name' || field === 'age') {
        const child = this.sql('SELECT * FROM children WHERE id = ?').get(run.childId);
        if (child[field] !== value) {
          if (run.sharedProfile && child[field] !== run.sharedProfile[field]) return { status: 'conflict', field };
          const update = field === 'name' ? 'UPDATE children SET name = ?, version = version + 1 WHERE id = ?' :
            'UPDATE children SET age = ?, version = version + 1 WHERE id = ?';
          this.sql(update).run(value, run.childId);
          status = 'updated';
        }
        resultValue = value;
      } else {
        const previous = this.sql('SELECT * FROM soul_profiles WHERE child_id = ? AND agent_id = ?').get(run.childId, run.agentId);
        const profile = { ...profileDefaults(), ...decode(previous?.profile, {}) };
        const before = profile[field];
        const normalized = normalizeSearch(value);
        if (operation === 'set') profile[field] = value;
        if (operation === 'add' && !before.some(item => normalizeSearch(item) === normalized)) profile[field] = [...before, value];
        if (operation === 'remove') profile[field] = before.filter(item => normalizeSearch(item) !== normalized);
        if (encode(profile[field]) !== encode(before)) {
          this.sql(`INSERT INTO soul_profiles(child_id, agent_id, profile, version) VALUES(?,?,?,1)
            ON CONFLICT(child_id,agent_id) DO UPDATE SET profile = excluded.profile, version = soul_profiles.version + 1`)
            .run(run.childId, run.agentId, encode(profile));
          status = 'updated';
        }
        resultValue = profile[field];
      }
      const result = { status, field, value: resultValue };
      this.sql('INSERT INTO profile_writes(run_id, field, operation, value, source_id, result, written_at) VALUES(?,?,?,?,?,?,?)')
        .run(run.runId, field, operation, encode(value), sourceId, encode(result), now);
      return result;
    });
  }
}

function normalizeSearch(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function exactContent(value) { return String(value).normalize('NFKC').trim().toLowerCase(); }

function safeDiagnostic(value) {
  if (Array.isArray(value)) return value.map(safeDiagnostic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:authorization|api[-_]?key|secret|access[-_]?token|refresh[-_]?token|cookie|set-cookie)$/i.test(key))
    .map(([key, item]) => [key, safeDiagnostic(item)]));
  return value;
}

function validateBriefSelection(selection, records) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(selection) || Object.keys(selection).some(key => !['groups', 'deferredIds'].includes(key))
      || !Array.isArray(selection.groups) || !Array.isArray(selection.deferredIds)) throw problem('聊天概括选源结构无效');
  const allowed = new Set(records.map(row => row.id));
  const seen = new Set();
  const take = id => {
    if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) throw problem('聊天概括含未知、跨范围或重复来源');
    seen.add(id);
  };
  for (const group of selection.groups) {
    if (!object(group) || Object.keys(group).some(key => !['category', 'representativeId', 'memberIds'].includes(key))
        || !['background', 'preferences', 'goals', 'interaction', 'other'].includes(group.category)
        || !Array.isArray(group.memberIds) || !group.memberIds.length
        || !group.memberIds.includes(group.representativeId)) throw problem('聊天概括分组或代表来源无效');
    group.memberIds.forEach(take);
  }
  selection.deferredIds.forEach(take);
  if (seen.size !== allowed.size) throw problem('聊天概括没有完整交代全部来源');
}

function composeOverview(records, budget = 1200) {
  const sentences = [], memoryIds = [], seen = new Set();
  let length = 0;
  for (const record of records) {
    const sentence = record?.summary?.trim();
    if (!record || seen.has(record.id) || !sentence) continue;
    seen.add(record.id);
    const cost = sentence.length + (sentences.length ? 1 : 0);
    if (length + cost > budget) continue;
    sentences.push(sentence);
    memoryIds.push(record.id);
    length += cost;
  }
  return { summary: sentences.join('\n'), memoryIds };
}

function localDate(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function rankMemories(rows, query) {
  const queryText = normalizeSearch(String(query));
  if (!queryText) return rows.map(row => ({ row, score: 0 }));
  const words = String(query).toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/gu) ?? [];
  const terms = new Set(words.flatMap(word => {
    const text = normalizeSearch(word);
    if (/^[\u3400-\u9fff]{3,}$/u.test(text)) return Array.from(text).slice(0, -1).map((char, index) => char + text[index + 1]);
    return text ? [text] : [];
  }));
  return rows.map(row => {
    const headline = normalizeSearch(row.summary + ' ' + decode(row.topics, []).join(' '));
    // Original detail is useful for retrieval; changed details remain historical
    // evidence rather than being silently flattened into a new factual object.
    const body = normalizeSearch(Object.values(decode(row.detail, {})).join(' ') + ' '
      + decode(row.detail_changes, []).map(change => Object.values(change.detailDelta ?? {}).join(' ')).join(' '));
    const full = (headline.includes(queryText) ? 20 : 0) + (body.includes(queryText) ? 10 : 0);
    const partial = [...terms].reduce((n, term) => n + (headline.includes(term) ? 2 : body.includes(term) ? 1 : 0), 0);
    return { row, score: full + partial };
  }).sort((a, b) => b.score - a.score || Date.parse(b.row.last_mentioned_at) - Date.parse(a.row.last_mentioned_at) || a.row.id.localeCompare(b.row.id));
}
