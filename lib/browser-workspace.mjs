import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ChatStore, problem } from './store.mjs';
import { ChatRuntime } from './runtime.mjs';

export const BROWSER_WORKSPACE_MAX_BYTES = 16 * 1024 * 1024;
const FORMAT = 'chat-lab-browser-workspace';
const VERSION = 1;
// These are data-only columns, never names or SQL supplied by the browser.
// The order also gives a valid foreign-key insertion order.
const COLUMNS = {
  lab_meta: 'key value',
  agents: 'id name definition metadata revision version created_at updated_at',
  children: 'id name age gender interests version created_at',
  soul_profiles: 'child_id agent_id profile version',
  sessions: 'id child_id agent_id title status created_at updated_at last_activity_at closed_at recent_snapshot context mentor_handoff',
  messages: 'seq id session_id role text created_at parts',
  runs: 'id child_id agent_id session_id request_id user_id assistant_id user_count status error mentor_recommendation',
  jobs: 'session_id child_id agent_id status created_at started_at finished_at error item_count source_snapshot input_context result output_snapshot attempt_history',
  memories: 'id child_id agent_id session_id anchor_id source_ids mentioned_at mentioned_on summary detail committed_at version state kind topics created_at last_mentioned_at content_at detail_changes summary_history archived_at retracted_at retraction_reason',
  profile_writes: 'run_id field operation value source_id result written_at',
  usage_records: 'record_key session_id run_id kind tool_name created_at updated_at entry',
  memory_scopes: 'child_id agent_id revision',
  user_overviews: 'child_id agent_id summary memory_ids version updated_at source_at stale',
  memory_mentions: 'memory_id anchor_id session_id source_ids mentioned_at mentioned_on operation',
  context_briefs: 'child_id agent_id fingerprint session_id model_name status source_snapshot selection result output error created_at started_at finished_at',
};
for (const name of Object.keys(COLUMNS)) COLUMNS[name] = Object.freeze(COLUMNS[name].split(' '));
Object.freeze(COLUMNS);
const INTEGERS = new Set(['revision', 'version', 'age', 'seq', 'user_count', 'item_count', 'stale']);
const OPTIONAL_COLUMNS = { sessions: 'mentor_handoff', runs: 'mentor_recommendation' };
const NULLABLE = {
  children: 'age gender', sessions: 'last_activity_at closed_at recent_snapshot context mentor_handoff', messages: 'parts',
  runs: 'assistant_id error mentor_recommendation', jobs: 'started_at finished_at error item_count source_snapshot input_context result output_snapshot',
  memories: 'detail created_at last_mentioned_at content_at archived_at retracted_at retraction_reason',
  usage_records: 'run_id tool_name', user_overviews: 'updated_at source_at',
  context_briefs: 'selection result output error started_at finished_at',
};
const JSON_COLUMNS = {
  agents: { metadata: 'object' }, children: { interests: 'array' }, soul_profiles: { profile: 'object' },
  sessions: { recent_snapshot: 'array', context: 'object', mentor_handoff: 'object' }, messages: { parts: 'array' },
  runs: { mentor_recommendation: 'object' },
  jobs: { source_snapshot: 'array', input_context: 'object', result: 'object', output_snapshot: 'object', attempt_history: 'array' },
  memories: { source_ids: 'array', detail: 'object', topics: 'array', detail_changes: 'array', summary_history: 'array' },
  profile_writes: { value: 'any', result: 'object' }, usage_records: { entry: 'object' },
  user_overviews: { memory_ids: 'array' }, memory_mentions: { source_ids: 'array' },
  context_briefs: { source_snapshot: 'array', selection: 'object', result: 'object', output: 'object' },
};
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const ownKeysAre = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const byteSize = value => {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch { throw problem('浏览器工作区须为有效 JSON'); }
};
const invalidSnapshot = () => problem('浏览器工作区格式无效，原本地资料未被修改');

function validateSnapshot(snapshot) {
  if (!ownKeysAre(snapshot, ['format', 'version', 'tables']) || snapshot.format !== FORMAT || snapshot.version !== VERSION ||
      !record(snapshot.tables) || Object.keys(snapshot.tables).length !== Object.keys(COLUMNS).length ||
      !Object.keys(snapshot.tables).every(name => Object.hasOwn(COLUMNS, name))) throw invalidSnapshot();
  if (byteSize(snapshot) > BROWSER_WORKSPACE_MAX_BYTES) throw problem('浏览器工作区超过 16 MiB 上限，请先导出备份再清理本地资料', 413);
  let totalRows = 0;
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows) || rows.length > 50_000 || (totalRows += rows.length) > 100_000) throw invalidSnapshot();
    if ((table === 'agents' && rows.length > 1024) || (table === 'children' && rows.length > 128)) throw invalidSnapshot();
    const nullable = new Set((NULLABLE[table] ?? '').split(' '));
    for (const row of rows) {
      if (!ownKeysAre(row, columns)) throw invalidSnapshot();
      for (const column of columns) {
        if (!Object.hasOwn(row, column)) {
          if (column === OPTIONAL_COLUMNS[table]) continue;
          throw invalidSnapshot();
        }
        const value = row[column];
        if (value === null && nullable.has(column)) continue;
        if (INTEGERS.has(column) && !(table === 'agents' && column === 'version')) {
          if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647 || (['seq', 'user_count', 'revision'].includes(column) && value < (column === 'revision' && table === 'memory_scopes' ? 0 : 1))) throw invalidSnapshot();
          continue;
        }
        if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 2 * 1024 * 1024) throw invalidSnapshot();
        if ((column.endsWith('_at') && !Number.isFinite(Date.parse(value))) || (column === 'mentioned_on' && !/^\d{4}-\d{2}-\d{2}$/.test(value))) throw invalidSnapshot();
        const shape = JSON_COLUMNS[table]?.[column];
        if (shape) {
          let parsed;
          try { parsed = JSON.parse(value); } catch { throw invalidSnapshot(); }
          if ((shape === 'array' && !Array.isArray(parsed)) || (shape === 'object' && !record(parsed))) throw invalidSnapshot();
        }
      }
      const enums = { sessions: { status: ['open', 'closed'] }, messages: { role: ['user', 'assistant'] },
        runs: { status: ['running', 'succeeded', 'failed'] }, jobs: { status: ['queued', 'running', 'succeeded', 'failed'] },
        memories: { state: ['active', 'archived', 'retracted'], kind: ['event', 'understanding'] },
        context_briefs: { status: ['queued', 'running', 'succeeded', 'failed', 'stale'] } };
      for (const [field, allowed] of Object.entries(enums[table] ?? {})) if (!allowed.includes(row[field])) throw invalidSnapshot();
    }
  }
  const meta = new Map(snapshot.tables.lab_meta.map(row => [row.key, row.value]));
  if (meta.size !== snapshot.tables.lab_meta.length || !meta.has('data_version') || meta.get('agents_initialized') !== '1' ||
      [...meta.keys()].some(key => !['data_version', 'agents_initialized', 'memory_reset_at', 'shared_prompts_hash'].includes(key) && !key.startsWith('memory_reset_at:')) ||
      (meta.has('shared_prompts_hash') && !/^[a-f0-9]{64}$/.test(meta.get('shared_prompts_hash')))) throw invalidSnapshot();
  return snapshot;
}

function importSnapshot(store, snapshot) {
  try {
    store.transaction(() => {
      for (const [table, columns] of Object.entries(COLUMNS)) {
        const statement = store.sql(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of snapshot.tables[table]) statement.run(...columns.map(column => Object.hasOwn(row, column) ? row[column] : null));
      }
      // Agent IDs intentionally have no legacy SQL FK. Validate their scope here.
      for (const table of ['soul_profiles', 'sessions', 'runs', 'jobs', 'memories', 'memory_scopes', 'user_overviews', 'context_briefs']) {
        if (store.sql(`SELECT 1 FROM ${table} t LEFT JOIN agents a ON a.id=t.agent_id WHERE a.id IS NULL LIMIT 1`).get()) throw invalidSnapshot();
      }
      for (const table of ['runs', 'jobs', 'memories', 'context_briefs']) {
        if (store.sql(`SELECT 1 FROM ${table} t JOIN sessions s ON s.id=t.session_id WHERE t.child_id!=s.child_id OR t.agent_id!=s.agent_id LIMIT 1`).get()) throw invalidSnapshot();
      }
      // A repeated mention moves anchor_id to a later session while session_id
      // keeps the memory's creation session. Validate the user/role scope.
      if (store.sql(`SELECT 1 FROM memories m JOIN messages a ON a.id=m.anchor_id
        JOIN sessions s ON s.id=a.session_id
        WHERE s.child_id!=m.child_id OR s.agent_id!=m.agent_id OR a.role!='user' LIMIT 1`).get()) throw invalidSnapshot();
      if (store.sql("SELECT 1 FROM memories WHERE state='active' GROUP BY child_id,agent_id HAVING COUNT(*)>500 LIMIT 1").get()) throw invalidSnapshot();
      for (const job of snapshot.tables.jobs) {
        if (job.source_snapshot != null && JSON.stringify(JSON.parse(job.source_snapshot)) !== JSON.stringify(store.messages(job.session_id))) throw invalidSnapshot();
      }
      const legacySessions = snapshot.tables.sessions.filter(row => !Object.hasOwn(row, 'mentor_handoff')).map(row => row.id);
      if (legacySessions.length) store.migrateMentorHandoffSnapshots(legacySessions);
    });
  } catch (error) {
    if (error.status) throw error;
    throw invalidSnapshot();
  }
}

const definitionHash = definition => createHash('sha256').update(definition).digest('hex');
const isDefinitionHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function updateSharedPromptCacheStamp(store, prompts = []) {
  const previous = store.sql('SELECT value FROM lab_meta WHERE key=?').get('shared_prompts_hash');
  if (!previous && !prompts.length) return false;
  const hash = createHash('sha256').update(JSON.stringify(prompts)).digest('hex');
  if (previous?.value === hash) return false;
  store.sql('INSERT INTO lab_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('shared_prompts_hash', hash);
  return true;
}

function upgradeCatalogDefinitions(store, seeds, now) {
  return store.transaction(() => {
    let upgraded = false;
    for (const seed of seeds) {
      const targetHash = seed.metadata?.catalogDefinitionSha256;
      if (!isDefinitionHash(targetHash) || typeof seed.definition !== 'string' || definitionHash(seed.definition) !== targetHash) continue;
      const current = store.agentRecord(seed.id);
      if (!current) {
        store.sql(`INSERT INTO agents(id,name,definition,metadata,revision,version,created_at,updated_at)
          VALUES(?,?,?,?,1,?,?,?)`).run(seed.id, seed.name, seed.definition, JSON.stringify(seed.metadata ?? {}),
          seed.version ?? 'db-v1', now, now);
        upgraded = true;
        continue;
      }
      const previousNames = seed.metadata.catalogPreviousNames;
      const recognizedName = current.name === seed.name ||
        (Array.isArray(previousNames) && previousNames.includes(current.name));
      if (!recognizedName || current.revision >= 2_147_483_647) continue;
      const currentHash = definitionHash(current.definition);
      const mentorPresentationChanged = seed.metadata.mentor && (
        current.metadata.description !== seed.metadata.description ||
        !isDeepStrictEqual(current.metadata.mentor, seed.metadata.mentor) ||
        ['aliases', 'specialties'].some(key => seed.metadata.card?.[key] !== undefined &&
          !isDeepStrictEqual(current.metadata.card?.[key], seed.metadata.card[key])));
      if (currentHash === targetHash && current.name === seed.name && !mentorPresentationChanged) continue;
      const previous = seed.metadata.catalogPreviousDefinitionSha256;
      const trackedStock = current.metadata.catalogDefinitionSha256 === currentHash;
      const legacyStock = current.metadata.catalogDefinitionSha256 === undefined && current.revision === 1 &&
        (currentHash === targetHash || (Array.isArray(previous) && previous.includes(currentHash)));
      if (!trackedStock && !legacyStock) continue;
      const aliases = [...new Set([
        ...(Array.isArray(current.metadata.catalogPreviousDefinitionSha256) ? current.metadata.catalogPreviousDefinitionSha256 : []),
        ...(Array.isArray(previous) ? previous : []), currentHash,
      ].filter(isDefinitionHash))];
      const presentation = ['whole-person-v2', 'source-preserving-v3'].includes(seed.metadata.nuwaSource?.adaptationVersion)
        ? { description: seed.metadata.description, nuwaSource: seed.metadata.nuwaSource,
          card: { ...current.metadata.card,
            ...Object.fromEntries(['role', 'relationship', 'personality', 'speakingStyle', 'replyStyle']
              .filter(key => seed.metadata.card?.[key] !== undefined).map(key => [key, seed.metadata.card[key]])) } }
        : {};
      const mentorPresentation = seed.metadata.mentor
        ? { description: seed.metadata.description, mentor: seed.metadata.mentor,
          card: { ...current.metadata.card,
            aliases: seed.metadata.card?.aliases ?? current.metadata.card?.aliases,
            specialties: seed.metadata.card?.specialties ?? current.metadata.card?.specialties } }
        : {};
      const metadata = { ...current.metadata, ...presentation, ...mentorPresentation,
        ...(Array.isArray(previousNames) ? { catalogPreviousNames: previousNames } : {}),
        catalogDefinitionSha256: targetHash, catalogPreviousDefinitionSha256: aliases };
      const revision = current.revision + 1;
      const changed = store.sql(`UPDATE agents SET name=?,definition=?,metadata=?,revision=?,version=?,updated_at=?
        WHERE id=? AND revision=? AND name=? AND definition=?`).run(seed.name, seed.definition, JSON.stringify(metadata), revision,
        `db-v${revision}`, now, current.id, current.revision, current.name, current.definition).changes > 0;
      upgraded = upgraded || changed;
    }
    return upgraded;
  });
}

function syncPublicCatalog(store, catalog, protectedIds) {
  if (!catalog) return false;
  const active = new Set(catalog.agents.map(agent => agent.id));
  const deleted = new Set(catalog.deletedIds);
  return store.transaction(() => {
    let changed = false;
    for (const seed of catalog.agents) {
      const current = store.agentRecord(seed.id);
      if (protectedIds.has(seed.id) || (current && current.metadata.publicCatalog !== true)) {
        throw problem('本地角色 ID 与公共角色冲突，原有资料未被修改', 409);
      }
      // Public text and prompt-affecting metadata come from the server, never
      // from a visitor snapshot. A private legacySoul cannot shadow the text.
      const metadata = { ...seed.metadata, publicCatalog: true, publicRevision: seed.revision,
        hidden: false, publicDeleted: false };
      const encoded = JSON.stringify(metadata);
      if (current && current.name === seed.name && current.definition === seed.definition &&
          current.revision === seed.revision && current.version === seed.version &&
          JSON.stringify(current.metadata) === encoded && current.updatedAt === seed.updatedAt) continue;
      store.sql(`INSERT INTO agents(id,name,definition,metadata,revision,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition=excluded.definition,
        metadata=excluded.metadata,revision=excluded.revision,version=excluded.version,updated_at=excluded.updated_at`)
        .run(seed.id, seed.name, seed.definition, encoded, seed.revision, seed.version, seed.createdAt, seed.updatedAt);
      changed = true;
    }
    for (const current of store.agentRecords()) {
      if (protectedIds.has(current.id) || active.has(current.id)) continue;
      if (!deleted.has(current.id) && current.metadata.publicCatalog !== true) continue;
      const metadata = { ...current.metadata, publicCatalog: true, publicDeleted: true, hidden: true };
      if (JSON.stringify(metadata) === JSON.stringify(current.metadata)) continue;
      store.sql('UPDATE agents SET metadata=? WHERE id=?').run(JSON.stringify(metadata), current.id);
      changed = true;
    }
    return changed;
  });
}

// Retire public defaults without deleting any role text, conversations or memory.
// Apply on every import so an older browser snapshot cannot bring them back.
function retireAgents(store, ids) {
  return store.transaction(() => {
    let changed = false;
    for (const id of ids ?? []) {
      const current = store.agentRecord(id);
      if (!current || current.metadata.hidden === true) continue;
      store.sql('UPDATE agents SET metadata=? WHERE id=?')
        .run(JSON.stringify({ ...current.metadata, hidden: true }), id);
      changed = true;
    }
    return changed;
  });
}

function hideLocalAgent(store, id, body, protectedIds, now) {
  if (!ownKeysAre(body, ['revision']) || !Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw problem('删除角色需要已读取的角色版本');
  }
  const current = store.agentRecord(id);
  if (!current) throw problem('找不到此角色', 404);
  if (protectedIds.has(id)) throw problem('内置角色不能删除', 403);
  if (current.metadata.publicCatalog === true) throw problem('公共角色请通过公共角色库删除', 403);
  if (current.metadata.hidden === true) return { deleted: true, id };
  if (current.revision !== body.revision) throw problem('角色已更新，请重新载入后再删除', 409);
  const revision = current.revision + 1;
  store.sql('UPDATE agents SET metadata=?,revision=?,version=?,updated_at=? WHERE id=?')
    .run(JSON.stringify({ ...current.metadata, hidden: true }), revision, `db-v${revision}`, now, id);
  return { deleted: true, id };
}

function exportSnapshot(store) {
  const snapshot = { format: FORMAT, version: VERSION, tables: Object.fromEntries(Object.entries(COLUMNS)
    .map(([table, columns]) => [table, store.sql(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))])) };
  // Check our own output too, before returning a state that could not be restored.
  return validateSnapshot(snapshot);
}

function text(value, label, max, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || value.includes('\0')) throw problem(`${label}格式或长度无效`);
  return value.trim();
}
function upgradeDefaultVisitorAge(store, defaults) {
  const seed = defaults?.length === 1 ? defaults[0] : null;
  if (seed?.name !== '访客' || seed.age !== 22 || seed.interests?.length !== 0) return false;
  // Snapshot export/import preserves insertion order. The initial public
  // visitor precedes all user-created profiles, even with equal timestamps.
  const row = store.sql('SELECT * FROM children ORDER BY rowid LIMIT 1').get();
  if (!row || row.name !== '访客' || row.age !== null || row.gender !== null || row.version !== 0 ||
      JSON.parse(row.interests).length !== 0) return false;
  return store.sql(`UPDATE children SET age=22,version=version+1
    WHERE id=? AND name='访客' AND age IS NULL AND gender IS NULL AND version=0 AND interests=?`)
    .run(row.id, row.interests).changes > 0;
}

function childInput(body) {
  const name = text(body.name, '姓名', 48);
  const age = body.age == null || body.age === '' ? null : Number(body.age);
  if (age !== null && (!['string', 'number'].includes(typeof body.age) || !Number.isInteger(age) || age < 1 || age > 120)) throw problem('年龄请填写 1–120 的整数或留空');
  const interests = body.interests ?? [];
  if (!Array.isArray(interests) || interests.length > 20) throw problem('兴趣须为最多 20 项的列表');
  return { name, age, interests: [...new Set(interests.map(value => text(value, '兴趣', 64)))] };
}
function chatMessages(body) {
  if (body.messages === undefined) return [{ text: text(body.text, '消息', 4000) }];
  if (body.text !== undefined || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 40) throw problem('请选择发送单条消息或 1–40 条连发消息');
  const messages = body.messages.map(item => {
    const message = text(item?.text, '消息', 4000), createdAt = item.createdAt;
    if (createdAt !== undefined && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt)) throw problem('消息时间格式无效');
    return { text: message, createdAt };
  });
  if (messages.map(item => item.text).join('\n').length > 16_000) throw problem('连发消息总长度过长', 413);
  return messages;
}
function envelopeInput(envelope) {
  if (!ownKeysAre(envelope, ['method', 'path', 'body', 'snapshot', 'scope']) || !['GET', 'POST', 'PATCH', 'DELETE'].includes(envelope.method) ||
      typeof envelope.path !== 'string' || !envelope.path.startsWith('/api/') || envelope.path.length > 1000 ||
      /[\\#\u0000-\u0020]/.test(envelope.path)) throw problem('本地工作区请求格式无效');
  if (envelope.body !== undefined && (!record(envelope.body) || byteSize(envelope.body) > 64_000)) throw problem('请求内容格式无效或太长', 413);
  if (envelope.scope !== undefined && (!ownKeysAre(envelope.scope, ['childId', 'agentId', 'sessionId']) ||
      Object.values(envelope.scope).some(value => value != null && (typeof value !== 'string' || value.length > 100 || value.includes('\0'))))) throw problem('工作区选择无效');
  const url = new URL(envelope.path, 'http://workspace.invalid');
  if (url.origin !== 'http://workspace.invalid' || [...url.searchParams.keys()].some(key => !['childId', 'agentId'].includes(key)) ||
      ['childId', 'agentId'].some(key => url.searchParams.getAll(key).length > 1)) throw problem('工作区地址无效');
  let match;
  const pathname = url.pathname, method = envelope.method;
  if ((method === 'GET' && ['/api/state', '/api/sessions', '/api/memory'].includes(pathname)) ||
      (method === 'POST' && ['/api/agents', '/api/children', '/api/sessions', '/api/chat', '/api/memory/clear',
        '/api/mentor-handoffs'].includes(pathname))) return { url, pathname };
  if ((match = /^\/api\/agents\/([^/]+)(\/prompt)?$/.exec(pathname)) &&
      (method === 'GET' || (['PATCH', 'DELETE'].includes(method) && !match[2]))) return { url, pathname, kind: match[2] ? 'prompt' : 'agent', id: decodeId(match[1]) };
  if (method === 'GET' && (match = /^\/api\/(sessions|memory)\/([^/]+)$/.exec(pathname))) return { url, pathname, kind: match[1], id: decodeId(match[2]) };
  if (method === 'GET' && (match = /^\/api\/sessions\/([^/]+)\/status$/.exec(pathname))) return { url, pathname, kind: 'sessionStatus', id: decodeId(match[1]) };
  if (method === 'POST' && (match = /^\/api\/mentor-handoffs\/([^/]+)\/arrive$/.exec(pathname))) return { url, pathname, kind: 'mentorArrival', id: decodeId(match[1]) };
  if (method === 'POST' && (match = /^\/api\/memory\/jobs\/([^/]+)\/retry$/.exec(pathname))) return { url, pathname, kind: 'retry', id: decodeId(match[1]) };
  throw problem('找不到此本地工作区地址', 404);
}
function requestScope(envelope, route) {
  const body = envelope.body ?? {};
  const scopedGet = envelope.method === 'GET' &&
    (['/api/sessions', '/api/memory'].includes(route.pathname) || ['sessions', 'sessionStatus', 'memory'].includes(route.kind));
  const scopedPost = envelope.method === 'POST' &&
    (['/api/sessions', '/api/chat', '/api/mentor-handoffs'].includes(route.pathname) ||
      ['retry', 'mentorArrival'].includes(route.kind) ||
      (route.pathname === '/api/memory/clear' && body.all !== true));
  const source = scopedGet ? Object.fromEntries(route.url.searchParams) : scopedPost ? body : null;
  if (source) {
    for (const field of ['childId', 'agentId']) {
      // Business scope belongs to the URL/body captured with this operation.
      // A separately sampled UI preference must never redirect a read or clear.
      text(source[field], field === 'childId' ? '用户 ID' : '角色 ID', 100);
      if (envelope.scope?.[field] != null && envelope.scope[field] !== source[field]) {
        throw problem('当前用户或角色选择已变化，请重新操作');
      }
    }
  }
  return { body, businessScoped: !!source,
    childId: source ? source.childId : envelope.scope?.childId,
    agentId: source ? source.agentId : envelope.scope?.agentId,
    sessionId: body.sessionId ?? envelope.scope?.sessionId };
}

function decodeId(value) {
  let id;
  try { id = decodeURIComponent(value); } catch { throw problem('地址 ID 无效'); }
  if (/[\/\\]/.test(id)) throw problem('地址 ID 无效');
  return text(id, '地址 ID', 100);
}

function memoryView(store, runtime, childId, agentId) {
  return { profile: store.profile(childId, agentId), overview: store.userOverview(childId, agentId),
    chatOverview: runtime.chatOverview(childId, agentId, { includeSources: true }), counts: store.memoryCounts(childId, agentId),
    items: store.allMemories(childId, agentId), jobs: store.jobList(childId, agentId) };
}
function scopedClear(store, childId, agentId, now) {
  return store.transaction(() => {
    for (const table of ['runs', 'jobs', 'context_briefs']) {
      if (store.sql(`SELECT 1 FROM ${table} WHERE child_id=? AND agent_id=? AND status='running' LIMIT 1`).get(childId, agentId)) throw problem('当前用户仍有任务运行，未清空记忆', 409);
    }
    const deleted = {};
    deleted.memory_mentions = store.sql('DELETE FROM memory_mentions WHERE memory_id IN (SELECT id FROM memories WHERE child_id=? AND agent_id=?)').run(childId, agentId).changes;
    deleted.profile_writes = store.sql('DELETE FROM profile_writes WHERE run_id IN (SELECT id FROM runs WHERE child_id=? AND agent_id=?)').run(childId, agentId).changes;
    for (const table of ['user_overviews', 'context_briefs', 'memory_scopes', 'memories', 'soul_profiles']) deleted[table] = store.sql(`DELETE FROM ${table} WHERE child_id=? AND agent_id=?`).run(childId, agentId).changes;
    const closedSessions = store.sql(`UPDATE sessions SET status='closed',closed_at=COALESCE(closed_at,?),recent_snapshot=NULL,context=NULL WHERE child_id=? AND agent_id=?`).run(now, childId, agentId).changes;
    const result = JSON.stringify({ resetSkipped: true, resetAt: now });
    const updated = store.sql(`UPDATE jobs SET status='succeeded',started_at=NULL,finished_at=?,error=NULL,item_count=0,
      source_snapshot=NULL,input_context=NULL,result=?,output_snapshot=NULL,attempt_history='[]' WHERE child_id=? AND agent_id=?`).run(now, result, childId, agentId).changes;
    const inserted = store.sql(`INSERT OR IGNORE INTO jobs(session_id,child_id,agent_id,status,created_at,finished_at,item_count,result)
      SELECT id,child_id,agent_id,'succeeded',?,?,0,? FROM sessions WHERE child_id=? AND agent_id=?`).run(now, now, result, childId, agentId).changes;
    store.sql('INSERT INTO lab_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`memory_reset_at:${childId}:${agentId}`, now);
    return { deleted, closedSessions, sealedJobs: updated + inserted, resetAt: now };
  });
}

async function settle(runtime) {
  runtime.tick();
  while (runtime.worker || runtime.briefWorker) await Promise.allSettled([runtime.worker, runtime.briefWorker].filter(Boolean));
}

/** No workspace, store, cookie identity, or user data survives execute(). */
export function createBrowserWorkspace(config = {}) {
  return { async execute(envelope, { emit, signal = new AbortController().signal } = {}) {
    const route = envelopeInput(envelope);
    const selected = requestScope(envelope, route);
    const incoming = envelope.snapshot == null ? null : validateSnapshot(envelope.snapshot);
    const store = new ChatStore(':memory:');
    const runtime = new ChatRuntime({ ...config, souls: undefined, store, allowDataReset: false, recentEventsEnabled: true });
    // Browser timers own the 15-minute deadline. Each request catches up before
    // producing its saved snapshot; no server timer outlives the response.
    runtime.tick = function () {
      if (this.stopped) return;
      this.store.closeDue(this.now(), this.idleMs);
      if (route.kind !== 'sessionStatus') {
        this.startWorker();
        this.startBriefWorker();
      }
    };
    const abort = () => { void runtime.stop(); };
    signal.addEventListener('abort', abort, { once: true });
    let status = 200, value, streamError, invalidates, catalogUpgraded = false, visitorUpgraded = false, publicChanged = false;
    const protectedAgentIds = new Set((config.defaultAgents ?? []).map(agent => agent.id));
    const { body } = selected;
    let { childId, agentId, sessionId } = selected;
    const isChat = envelope.method === 'POST' && route.pathname === '/api/chat';
    let memoryClaimed = false, briefClaimed = false, memoryScope;
    // One scoped job per request keeps an uploaded queue from causing a model
    // fan-out. Prefer the selected scope, then catch up an older scope. The
    // extraction, validation, repair and commit remain ChatRuntime's.
    store.claimJob = now => {
      if (memoryClaimed) return null;
      return store.transaction(() => {
        const job = store.sql(`SELECT j.* FROM jobs j WHERE j.status='queued'
          AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.session_id=j.session_id AND r.status='running')
          ORDER BY (j.child_id=? AND j.agent_id=?) DESC,j.created_at,j.rowid LIMIT 1`).get(childId ?? '', agentId ?? '');
        if (!job) return null;
        const snapshot = job.source_snapshot == null ? store.messages(job.session_id) : JSON.parse(job.source_snapshot);
        store.sql("UPDATE jobs SET status='running',started_at=?,source_snapshot=? WHERE session_id=?").run(now, JSON.stringify(snapshot), job.session_id);
        memoryClaimed = true;
        memoryScope = { childId: job.child_id, agentId: job.agent_id };
        return { ...job, snapshot };
      });
    };
    store.claimContextBrief = (now, { modelName } = {}) => {
      if (briefClaimed) return null;
      return store.transaction(() => {
        for (;;) {
          const briefChild = memoryScope?.childId ?? childId ?? '', briefAgent = memoryScope?.agentId ?? agentId ?? '';
          const job = memoryScope
            ? store.sql("SELECT * FROM context_briefs WHERE status='queued' AND child_id=? AND agent_id=? ORDER BY created_at,rowid LIMIT 1").get(briefChild, briefAgent)
            : store.sql("SELECT * FROM context_briefs WHERE status='queued' ORDER BY (child_id=? AND agent_id=?) DESC,created_at,rowid LIMIT 1").get(briefChild, briefAgent);
          if (!job) return null;
          const input = store.readBriefSources(job.child_id, job.agent_id, { modelName: job.model_name });
          if ((modelName !== undefined && job.model_name !== String(modelName ?? '')) || input.fingerprint !== job.fingerprint || !input.records.length) {
            store.sql("UPDATE context_briefs SET status='stale',error=?,finished_at=? WHERE child_id=? AND agent_id=? AND fingerprint=?").run('概括来源或生成模型已变化，旧任务未调用模型', now, job.child_id, job.agent_id, job.fingerprint);
            continue;
          }
          store.sql("UPDATE context_briefs SET status='running',started_at=? WHERE child_id=? AND agent_id=? AND fingerprint=?").run(now, job.child_id, job.agent_id, job.fingerprint);
          briefClaimed = true;
          return { ...job, status: 'running', started_at: now, records: input.records };
        }
      });
    };
    try {
      if (incoming) importSnapshot(store, incoming);
      else {
        // Pre-stamp the current version: legacy activateVersion otherwise adds
        // an implicit personal test profile. Seed only explicit public defaults.
        store.sql('INSERT INTO lab_meta(key,value) VALUES(?,?)').run('data_version', runtime.dataVersion);
        store.initializeAgents(config.defaultAgents ?? [], runtime.now(), { importSeeds: true });
        for (const child of config.defaultChildren ?? []) store.createChild(childInput(child), runtime.now());
      }
      catalogUpgraded = upgradeCatalogDefinitions(store, config.defaultAgents ?? [], runtime.now());
      catalogUpgraded = updateSharedPromptCacheStamp(store, config.sharedPrompts) || catalogUpgraded;
      visitorUpgraded = upgradeDefaultVisitorAge(store, config.defaultChildren);
      if (config.catalog) publicChanged = syncPublicCatalog(store, await config.catalog.list(), protectedAgentIds);
      catalogUpgraded = retireAgents(store, config.retiredAgentIds) || catalogUpgraded;
      runtime.initialize();
      if (!selected.businessScoped) {
        childId ??= store.children()[0]?.id;
        agentId ??= runtime.state().agents[0]?.id;
      }
      agentId = runtime.agentId(agentId);
      if (signal.aborted) abort();
      try {
        if (signal.aborted) throw problem('这次操作已停止', 499);
        const { pathname, kind, id } = route;
        if (pathname === '/api/state') value = runtime.state();
        else if (pathname === '/api/agents' && envelope.method === 'POST') {
          if (config.catalog) throw problem('新角色会公开到公共角色库，请刷新页面后创建', 409);
          status = 201; value = { agent: runtime.createAgent(body) }; agentId = value.agent.id;
        } else if (kind === 'agent') {
          const current = store.agentRecord(id);
          if (envelope.method === 'DELETE') {
            value = hideLocalAgent(store, id, body, protectedAgentIds, runtime.now());
            invalidates = ['/api/agents', '/api/sessions', '/api/memory'];
          } else {
            if (envelope.method === 'PATCH' && current?.metadata.publicCatalog === true) throw problem('公共角色请通过公共角色库编辑', 403);
            if (envelope.method === 'PATCH' && current?.metadata.hidden === true) throw problem('此角色已删除', 410);
            value = { agent: envelope.method === 'GET' ? runtime.agent(id) : runtime.updateAgent(id, body) };
          }
          agentId = id;
        }
        else if (kind === 'prompt') { value = runtime.promptDetail(id); agentId = id; }
        else if (pathname === '/api/children') { status = 201; value = { child: store.createChild(childInput(body), runtime.now()) }; childId = value.child.id; }
        else if (pathname === '/api/memory/clear' && body.all === true) {
          if (!ownKeysAre(body, ['all'])) throw problem('清空全部记忆时仅接受 all');
          value = store.clearMemories(runtime.now()); invalidates = ['/api/sessions', '/api/memory'];
        } else {
          runtime.assertScope(childId, agentId);
          if (pathname === '/api/sessions' && envelope.method === 'POST') {
            runtime.assertAudience(childId, agentId);
            status = 201; value = { session: store.manuallyOpen(childId, agentId, runtime.now()) }; sessionId = value.session.id;
          } else if (pathname === '/api/sessions') value = { sessions: store.sessions(childId, agentId) };
          else if (kind === 'sessionStatus') {
            value = runtime.sessionStatus({ childId, agentId, sessionId: id });
            sessionId = id;
          } else if (pathname === '/api/mentor-handoffs') {
            value = runtime.prepareMentorHandoff({ childId, agentId, cardId: text(body.cardId, '推荐卡片 ID', 100) });
          } else if (kind === 'mentorArrival') {
            value = await runtime.arriveMentorHandoff({ childId, agentId, cardId: id,
              sessionId: text(body.sessionId, '会话 ID', 100) }, signal);
            sessionId = value.session.id;
          } else if (kind === 'sessions') {
            value = store.session(id, childId, agentId); sessionId = id;
            if (!value) throw problem('找不到此会话', 404);
          } else if (pathname === '/api/memory') value = memoryView(store, runtime, childId, agentId);
          else if (kind === 'memory') {
            const item = store.memoryDetail(id, childId, agentId, { includeRetracted: true });
            if (!item) throw problem('找不到此记忆', 404);
            value = { item };
          } else if (kind === 'retry') { status = 202; value = { job: store.retryJob(id, childId, agentId, runtime.now()) }; }
          else if (pathname === '/api/memory/clear') {
            if (!ownKeysAre(body, ['childId', 'agentId', 'all']) || (body.all !== undefined && body.all !== false)) throw problem('清空记忆请求无效');
            value = scopedClear(store, childId, agentId, runtime.now()); invalidates = ['/api/sessions', '/api/memory'];
          } else if (isChat) {
            const run = runtime.beginChat({ childId, agentId, sessionId: text(body.sessionId, '会话 ID', 100, true),
              requestId: text(body.requestId, '请求 ID', 100), messages: chatMessages(body) });
            sessionId = run.sessionId;
            await runtime.chat(run, event => emit?.(event), signal);
            value = null;
          }
        }
      } catch (error) {
        status = error.status || 500;
        const message = error.status ? error.message : runtime.publicError(error, '本地工作区操作失败');
        value = { error: message };
        if (isChat) streamError = message;
      }
      await settle(runtime);
      if (memoryClaimed || briefClaimed) invalidates = ['/api/sessions', '/api/memory'];
      // A role may be edited or retired while a model request is in flight.
      // Reconcile before saving its snapshot so that it cannot reappear later.
      if (config.catalog) publicChanged = syncPublicCatalog(store, await config.catalog.list(), protectedAgentIds) || publicChanged;
      catalogUpgraded = retireAgents(store, config.retiredAgentIds) || catalogUpgraded;
      // Re-read GET values after catch-up extraction has fully committed.
      if (envelope.method === 'GET' && status < 400) {
        if (route.pathname === '/api/state') value = runtime.state();
        else if (route.pathname === '/api/sessions') value = { sessions: store.sessions(childId, agentId) };
        else if (route.pathname === '/api/memory') value = memoryView(store, runtime, childId, agentId);
        else if (route.kind === 'sessions') value = store.session(route.id, childId, agentId);
        else if (route.kind === 'sessionStatus') value = store.sessionStatus(route.id, childId, agentId, runtime.now(), runtime.idleMs);
        else if (route.kind === 'memory') value = { item: store.memoryDetail(route.id, childId, agentId, { includeRetracted: true }) };
      }
      await runtime.stop({ drain: true });
      const views = { '/api/state': runtime.state() };
      childId ??= views['/api/state'].children[0]?.id;
      agentId ??= views['/api/state'].agents[0]?.id;
      if (runtime.souls.has(agentId)) {
        views[`/api/agents/${encodeURIComponent(agentId)}`] = { agent: runtime.agent(agentId) };
        views[`/api/agents/${encodeURIComponent(agentId)}/prompt`] = runtime.promptDetail(agentId);
      }
      if (childId && agentId && store.child(childId) && runtime.souls.has(agentId)) {
        const suffix = '?' + new URLSearchParams({ childId, agentId });
        views['/api/sessions' + suffix] = { sessions: store.sessions(childId, agentId) };
        views['/api/memory' + suffix] = memoryView(store, runtime, childId, agentId);
        sessionId ??= store.active(childId, agentId)?.id;
        const session = sessionId && store.session(sessionId, childId, agentId);
        if (session) views['/api/sessions/' + encodeURIComponent(sessionId) + suffix] = session;
      }
      if (envelope.method === 'GET' && status < 400) views[envelope.path] = value;
      let nextDeadline = store.nextDeadline(runtime.idleMs);
      const queuedMemory = runtime.memoryModel.configured && store.sql("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").get();
      const queuedBrief = runtime.contextBriefEnabled && runtime.memoryModel.configured && store.sql("SELECT 1 FROM context_briefs WHERE status='queued' LIMIT 1").get();
      if (!signal.aborted && (queuedMemory || queuedBrief)) nextDeadline = Math.min(nextDeadline ?? Infinity, runtime.clock().getTime() + 1000);
      if (catalogUpgraded) invalidates = [...new Set([...(invalidates ?? []), '/api/agents'])];
      if (visitorUpgraded) invalidates = [...new Set([...(invalidates ?? []), '/api/memory'])];
      if (publicChanged) invalidates = [...new Set([...(invalidates ?? []), '/api/agents', '/api/sessions', '/api/memory'])];
      const result = { status, value, snapshot: exportSnapshot(store), views, nextDeadline, ...(invalidates ? { invalidates } : {}) };
      if (isChat) { emit?.({ type: 'workspace', ...result }); if (streamError) emit?.({ type: 'error', message: streamError }); }
      return result;
    } finally {
      signal.removeEventListener('abort', abort);
      await runtime.stop();
      store.close();
    }
  } };
}
