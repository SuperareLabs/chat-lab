import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../lib/store.mjs';

const now = '2026-11-13T08:00:00.000Z';
const later = '2026-11-13T09:00:00.000Z';
const seed = overrides => ({ id: 'legacy-agent', name: '原角色', definition: '\n原有定义\r\n\n',
  metadata: { card: { portrait: '/assets/legacy.png', theme: 'pine' },
    voice: { label: '原声音', sample: '/assets/voices/original.mp3' },
    audience: { minimumAge: 18 }, legacySoul: { schemaVersion: 1, speakingStyle: '原始说话方式' } },
  version: 'legacy-soul-v1', ...overrides });

function memoryStore(t) {
  const store = new ChatStore(':memory:');
  t.after(() => store.close());
  return store;
}

function businessSnapshot(store) {
  const tables = store.sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('agents','lab_meta') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  return Object.fromEntries(tables.map(table => [table, store.sql('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}

test('fresh initialization installs zero roles unless seed import was explicitly requested', t => {
  const store = memoryStore(t);
  assert.equal(store.agentsInitialized(), false);
  assert.equal(store.hasLegacyAgentData(), false);
  assert.deepEqual(store.agentRecords(), []);
  const before = businessSnapshot(store);
  assert.deepEqual(store.initializeAgents([seed()], now), { initialized: true, imported: 0 });
  assert.equal(store.agentsInitialized(), true);
  assert.equal(store.hasLegacyAgentData(), false, 'the role marker alone is not legacy business data');
  assert.deepEqual(store.agentRecords(), []);
  assert.deepEqual(store.initializeAgents([seed()], later, { importSeeds: true }), { initialized: false, imported: 0 });
  assert.deepEqual(store.agentRecords(), []);
  assert.deepEqual(businessSnapshot(store), before);
});

test('creates a stable UUID role with backend version and preserves definition whitespace verbatim', t => {
  const store = memoryStore(t);
  const definition = '\r\n  第一段。\n\n第二段。  \r\n';
  const record = store.createAgent({ name: '  自建角色  ', definition }, now);
  assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(record, { id: record.id, name: '自建角色', definition, metadata: {},
    revision: 1, version: 'db-v1', createdAt: now, updatedAt: now });
  assert.deepEqual(store.agentRecord(record.id), record);
  assert.equal(store.agentRecord('missing'), null);
  assert.equal(store.agentRecord(undefined), null);
  const second = store.createAgent({ name: '第二个角色', definition: '第二份定义。' }, later);
  assert.notEqual(second.id, record.id);
  assert.deepEqual(store.agentRecords(), [record, second]);
});

test('editing uses CAS, creates the version on the backend, and leaves metadata bytes unchanged', t => {
  const store = memoryStore(t), original = seed();
  store.initializeAgents([original], now, { importSeeds: true });
  const metadataBytes = store.sql('SELECT metadata FROM agents WHERE id=?').get(original.id).metadata;
  const definition = '\n\n由用户编辑。\r\n末尾保留空格。  \n';
  const edited = store.updateAgent(original.id, { name: '  新名称 ', definition, revision: 1 }, later);
  assert.deepEqual(edited, { id: original.id, name: '新名称', definition, metadata: original.metadata,
    revision: 2, version: 'db-v2', createdAt: now, updatedAt: later });
  assert.equal(store.sql('SELECT metadata FROM agents WHERE id=?').get(original.id).metadata, metadataBytes);
  assert.throws(() => store.updateAgent(original.id, { name: '旧窗口', definition: '不能覆盖。', revision: 1 }, later),
    error => error.status === 409);
  assert.throws(() => store.updateAgent('missing', { name: '名称', definition: '定义', revision: 1 }, later),
    error => error.status === 404);
  assert.deepEqual(store.agentRecord(original.id), edited);
  const updatedAgain = store.updateAgent(original.id, { name: edited.name, definition: '\t第三版\n', revision: 2 }, later);
  assert.equal(updatedAgain.version, 'db-v3');
  assert.equal(updatedAgain.revision, 3);
  assert.equal(updatedAgain.id, original.id);
  assert.deepEqual(updatedAgain.metadata, original.metadata);
});

test('create and update reject extra keys, blank or NUL text, invalid types and invalid revisions', t => {
  const store = memoryStore(t);
  const record = store.createAgent({ name: '保留角色', definition: '保留定义。' }, now);
  const invalid = [undefined, null, [], 'text', 12, {},
    { name: '名称' }, { definition: '定义' },
    { name: '', definition: '定义' }, { name: ' \n\t', definition: '定义' },
    { name: '名称', definition: '' }, { name: '名称', definition: '\r\n\t' },
    { name: 12, definition: '定义' }, { name: '名称', definition: {} },
    { name: '名\0称', definition: '定义' }, { name: '名称', definition: '定\0义' },
    { name: '名称', definition: '定义', id: 'client-id' },
    { name: '名称', definition: '定义', metadata: {} },
    { name: '名称', definition: '定义', version: 'client-version' },
    JSON.parse('{"name":"名称","definition":"定义","__proto__":{}}'),
    { name: '名称', definition: '定义', [Symbol('extra')]: true },
  ];
  for (const input of invalid) {
    assert.throws(() => store.createAgent(input, later), error => error.status === 400);
    const update = input && typeof input === 'object' && !Array.isArray(input) ? { ...input, revision: 1 } : input;
    assert.throws(() => store.updateAgent(record.id, update, later), error => error.status === 400);
  }
  assert.throws(() => store.createAgent({ name: '名称', definition: '定义', revision: 1 }, later), error => error.status === 400);
  for (const revision of [undefined, null, 0, -1, 1.5, '1', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.updateAgent(record.id, { name: '名称', definition: '定义', revision }, later), error => error.status === 400);
  }
  assert.deepEqual(store.agentRecords(), [record]);
});

test('one-time import keeps original IDs and version markers without overwriting existing agents', t => {
  const store = memoryStore(t);
  const existing = store.createAgent({ name: '已有自建角色', definition: '\n已有定义\n' }, now);
  const legacy = seed();
  assert.deepEqual(store.initializeAgents([
    seed({ id: existing.id, name: '不可覆盖', definition: '不可覆盖定义。' }), legacy,
    seed({ id: 'legacy-default-version', version: undefined }),
  ], later, { importSeeds: true }), { initialized: true, imported: 2 });
  assert.deepEqual(store.agentRecord(existing.id), existing);
  assert.deepEqual(store.agentRecord(legacy.id), { ...legacy, revision: 1, createdAt: later, updatedAt: later });
  assert.equal(store.agentRecord('legacy-default-version').version, 'db-v1');
  assert.equal(store.hasLegacyAgentData(), false, 'agents alone do not trigger legacy business migration');
  assert.deepEqual(store.initializeAgents(null, later, { importSeeds: true }), { initialized: false, imported: 0 },
    'a completed initialization never reads or reinstalls changed configuration');
});

test('failed seed import rolls back both imported rows and the initialization marker', t => {
  const store = memoryStore(t);
  const circular = {}; circular.self = circular;
  for (const invalid of [seed({ id: 'bad-blank', definition: ' \n' }),
    seed({ id: 'bad-extra', unexpected: true }), seed({ id: 'bad-metadata', metadata: [] }),
    seed({ id: 'bad-json', metadata: circular }), seed({ id: 'bad-version', version: '\0' })]) {
    assert.throws(() => store.initializeAgents([seed(), invalid], now, { importSeeds: true }), error => error.status === 400);
    assert.deepEqual(store.agentRecords(), []);
    assert.equal(store.agentsInitialized(), false);
  }
  assert.throws(() => store.initializeAgents(null, now, { importSeeds: true }), error => error.status === 400);
  assert.equal(store.agentsInitialized(), false);
  assert.equal(store.initializeAgents([seed()], now, { importSeeds: true }).imported, 1);
});

test('restart preserves edited definitions, metadata, inventory and the no-reimport marker', t => {
  const directory = mkdtempSync(join(tmpdir(), 'croco-agents-store-'));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'test.sqlite');
  store = new ChatStore(path);
  store.initializeAgents([seed()], now, { importSeeds: true });
  const edited = store.updateAgent('legacy-agent', { name: '数据库名称', definition: '\r\n数据库定义\n', revision: 1 }, later);
  const created = store.createAgent({ name: '新增角色', definition: '用户定义。' }, later);
  store.close();
  store = new ChatStore(path);
  assert.equal(store.agentsInitialized(), true);
  assert.deepEqual(store.initializeAgents([seed({ definition: '配置中的旧定义。' }), seed({ id: 'new-config-role' })], later,
    { importSeeds: true }), { initialized: false, imported: 0 });
  assert.deepEqual(store.agentRecord(edited.id), edited);
  assert.deepEqual(store.agentRecord(created.id), created);
  assert.equal(store.agentRecord('new-config-role'), null);
});

test('legacy detection sees old version markers and business data before any activation', t => {
  const store = memoryStore(t);
  store.initializeAgents([], now);
  assert.equal(store.hasLegacyAgentData(), false);
  store.sql("INSERT INTO lab_meta(key,value) VALUES('data_version','legacy-memory')").run();
  assert.equal(store.hasLegacyAgentData(), true);
  store.sql("DELETE FROM lab_meta WHERE key='data_version'").run();
  assert.equal(store.hasLegacyAgentData(), false);
  store.createChild({ name: '迁移测试用户', age: 25, interests: [] }, now);
  assert.equal(store.hasLegacyAgentData(), true);
});

test('agent migration and edits preserve existing user, chat, memory, overview and usage rows', t => {
  const store = memoryStore(t);
  store.sql("INSERT INTO lab_meta(key,value) VALUES('data_version','legacy-memory')").run();
  const child = store.createChild({ name: '合成迁移用户', age: 25, interests: ['阅读'] }, now);
  const run = store.beginChat({ childId: child.id, agentId: 'legacy-agent', text: '我一直喜欢阅读。', requestId: 'fixture' }, now, 900_000);
  store.finishChat(run, { reply: '记住了。' }, now);
  store.recordUsage({ key: 'fixture-usage', sessionId: run.sessionId, runId: run.runId, kind: 'chat', model: 'fixture', pending: false }, now);
  store.manuallyOpen(child.id, 'legacy-agent', now);
  const job = store.claimJob(now), user = job.snapshot.find(message => message.role === 'user');
  store.commitJob(job, { creates: [{ kind: 'understanding', topics: ['阅读'], summary: '用户一直喜欢阅读。',
    detail: { notes: '合成测试详情。' }, anchorMessageId: user.id, sourceMessageIds: [user.id] }],
  updates: [], mentions: [], retractions: [], overview: { summary: '用户一直喜欢阅读。', memoryIds: [], createIndexes: [0] } }, now);
  const before = businessSnapshot(store);
  assert.equal(store.hasLegacyAgentData(), true);
  store.initializeAgents([seed()], later, { importSeeds: true });
  store.activateVersion('current-memory', later, { compatibleVersions: ['legacy-memory'], allowReset: false });
  store.updateAgent('legacy-agent', { name: '只修改角色', definition: '\n角色修改后定义\n', revision: 1 }, later);
  assert.deepEqual(businessSnapshot(store), before);
  assert.equal(store.sql("SELECT value FROM lab_meta WHERE key='data_version'").get().value, 'current-memory');
});

test('unknown data versions remain guarded and explicit memory resets retain agents and initialization', t => {
  const store = memoryStore(t);
  store.initializeAgents([seed()], now, { importSeeds: true });
  store.activateVersion('unknown-memory-version', now);
  const beforeAgents = store.agentRecords(), beforeBusiness = businessSnapshot(store);
  assert.throws(() => store.activateVersion('current-memory', later, { allowReset: false }), error => error.status === 409);
  assert.deepEqual(store.agentRecords(), beforeAgents);
  assert.deepEqual(businessSnapshot(store), beforeBusiness);
  assert.equal(store.agentsInitialized(), true);
  store.activateVersion('explicitly-reset-memory', later, { allowReset: true });
  assert.deepEqual(store.agentRecords(), beforeAgents);
  assert.equal(store.agentsInitialized(), true);
  assert.equal(store.initializeAgents([seed({ id: 'cannot-reinstall' })], later, { importSeeds: true }).imported, 0);
});
