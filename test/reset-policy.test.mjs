import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLabServer } from '../server.mjs';
import { loadSouls, MEMORY_PROMPT, renderSoul } from '../lib/prompts.mjs';
import { MEMORY_FRAMEWORK_VERSION, MEMORY_COMPATIBLE_DATA_VERSIONS } from '../lib/memory-version.mjs';
import { MEMORY_REPAIR_PROMPT } from '../lib/memory-repair.mjs';

const now = '2026-11-12T02:00:00.000Z';
const tables = ['children', 'soul_profiles', 'sessions', 'messages', 'runs', 'jobs', 'memories', 'profile_writes'];
const clock = () => new Date(now);

function oldFingerprint(souls) {
  const systems = [...souls].map(([id, soul]) => [id, renderSoul(soul)])
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([
    '1.0.8', MEMORY_PROMPT, systems.map(([id, prompt]) => [id, souls.get(id).version, prompt]),
  ])).digest('hex');
}

function snapshot(store) {
  return Object.fromEntries(tables.map(table => [table, store.sql('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}

async function openLab(dbPath, options = {}) {
  const lab = createLabServer({
    provider: { chat() { throw new Error('reset-policy tests must not invoke a model'); } },
    // Exercise the historical 1.0.8 adoption path explicitly at framework 1.
    dbPath, appVersion: '1.0.9', memoryFrameworkVersion: 1, clock, ...options,
  });
  if (options.legacyFingerprint) lab.runtime.dataVersion = options.legacyFingerprint;
  lab.runtime.initialize();
  return lab;
}

async function closeLab(lab) {
  await lab.runtime.stop();
  lab.store.close();
}

function seedAllTables(lab) {
  const store = lab.store;
  const child = store.children()[0];
  const agentId = lab.runtime.state().agents[0].id;
  const run = store.beginChat({
    childId: child.id, agentId, requestId: 'saved-run',
    messages: [{ text: '以后叫我小禾，我今年9岁了。' }],
  }, now, 15 * 60 * 1000);
  store.applyProfile(run, { field: 'preferred_name', operation: 'set', value: '小禾' }, now);
  store.applyProfile(run, { field: 'age', operation: 'set', value: 9 }, now);
  store.finishChat(run, { reply: '我记一下。\n\n记好了，小禾今年九岁。', parts: ['我记一下。', '记好了，小禾今年九岁。'] }, now);
  store.recordContext(run.sessionId, { system: lab.runtime.systems.get(agentId), preserved: 'existing context' });
  store.manuallyOpen(child.id, agentId, now);
  const job = store.claimJob(now);
  assert.ok(job);
  store.commitJob(job, [{
    anchorMessageId: run.userId, sourceMessageIds: [run.userId],
    summary: '希望被称作小禾，今年九岁',
    detail: { event: '孩子更正称呼和年龄' }, mentionedAt: now, mentionedOn: '2026-11-12',
  }], now);
  store.createChild({ name: '手动创建孩子', age: 7, interests: ['画画'] }, now);
  for (const table of tables) assert.ok(store.sql('SELECT count(*) AS n FROM ' + table).get().n, table);
  return { childId: child.id, snapshot: snapshot(store) };
}

function assertFreshDefault(lab, priorId) {
  const children = lab.store.children();
  assert.equal(children.length, 1);
  assert.notEqual(children[0].id, priorId);
  assert.deepEqual(children[0], { id: children[0].id, name: '马超', age: 8, interests: [] });
  for (const table of tables.filter(table => table !== 'children')) {
    assert.equal(lab.store.sql('SELECT count(*) AS n FROM ' + table).get().n, 0, table);
  }
}

test('the legacy 1.0.8 policy adopts identical prompts without altering stored records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'croco-reset-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'chat.sqlite');
  const souls = loadSouls();
  const legacy = oldFingerprint(souls);
  let lab = await openLab(dbPath, { appVersion: '1.0.8', souls, legacyFingerprint: legacy });
  const saved = seedAllTables(lab);
  await closeLab(lab);

  lab = await openLab(dbPath, { appVersion: '1.0.9', souls });
  const adopted = lab.runtime.dataVersion;
  assert.notEqual(adopted, legacy, 'the old package-based metadata moves to the independent memory fingerprint');
  assert.equal(lab.store.sql("SELECT value FROM lab_meta WHERE key = 'data_version'").get().value, adopted);
  assert.deepEqual(snapshot(lab.store), saved.snapshot, 'migration keeps all eight tables, IDs, multipart text and context');
  assert.equal(lab.runtime.state().appVersion, '1.0.9');
  assert.equal(lab.runtime.state().memoryFrameworkVersion, 1);
  await closeLab(lab);

  const displayOnly = new Map([...souls].map(([id, soul]) => [id, {
    ...soul, version: 'display-release-label',
    card: { ...soul.card, personality: '仅修改角色卡的展示介绍' },
  }]));
  lab = await openLab(dbPath, { appVersion: '2.0.0', souls: displayOnly });
  assert.equal(lab.runtime.dataVersion, adopted, 'application versions, SOUL labels and public card copy do not reset memory');
  assert.deepEqual(snapshot(lab.store), saved.snapshot);
  assert.equal(lab.runtime.state().appVersion, '2.0.0');
  await closeLab(lab);

  lab = await openLab(dbPath, { appVersion: '2.0.1', souls });
  assert.equal(lab.runtime.dataVersion, adopted);
  assert.deepEqual(snapshot(lab.store), saved.snapshot, 'later non-memory upgrades still retain the exact modified default and manual child');
  await closeLab(lab);
});

test('actual role prompt changes reset records while legacy migration checks the prompt content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'croco-prompt-reset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const souls = loadSouls();
  const id = souls.keys().next().value;
  const changed = new Map(souls);
  const original = souls.get(id);
  changed.set(id, original.schemaVersion === 2
    ? { ...original, definition: original.definition + '这是提示词的实际变更。' }
    : { ...original, speakingStyle: original.speakingStyle + '这是提示词的实际变更。' });

  for (const legacy of [false, true]) {
    const dbPath = join(directory, legacy ? 'legacy.sqlite' : 'current.sqlite');
    let lab = await openLab(dbPath, { souls, ...(legacy ? { legacyFingerprint: oldFingerprint(souls) } : {}) });
    const saved = seedAllTables(lab);
    const before = lab.runtime.dataVersion;
    await closeLab(lab);
    lab = await openLab(dbPath, { souls: changed });
    assert.notEqual(lab.runtime.dataVersion, before);
    assertFreshDefault(lab, saved.childId);
    await closeLab(lab);
  }
});

test('a memory-framework version change resets both current and legacy data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'croco-memory-framework-reset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const souls = loadSouls();
  for (const legacy of [false, true]) {
    const dbPath = join(directory, legacy ? 'legacy.sqlite' : 'current.sqlite');
    let lab = await openLab(dbPath, { souls, memoryFrameworkVersion: 1, ...(legacy ? { legacyFingerprint: oldFingerprint(souls) } : {}) });
    const saved = seedAllTables(lab);
    const before = lab.runtime.dataVersion;
    await closeLab(lab);
    lab = await openLab(dbPath, { souls, appVersion: '3.0.0', memoryFrameworkVersion: MEMORY_FRAMEWORK_VERSION });
    assert.notEqual(lab.runtime.dataVersion, before);
    assert.equal(lab.runtime.state().memoryFrameworkVersion, MEMORY_FRAMEWORK_VERSION);
    assertFreshDefault(lab, saved.childId);
    await closeLab(lab);
  }
});

const deployed120 = '750cae7b3bcf25c2f9e9fff8c8892c8edeee25deeb5767bf7bbbe0c89703d7be';
function completeSnapshot(store) {
  const names = store.sql("SELECT name FROM sqlite_master WHERE type='table' AND name!='lab_meta' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  return Object.fromEntries(names.map(table => [table, store.sql('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}

function seedPreservedOverview(lab) {
  const childId = lab.store.children()[0].id, agentId = lab.runtime.state().agents[0].id;
  const run = lab.store.beginChat({ childId, agentId, text: '我一直喜欢画画。', requestId: 'saved-overview' }, now, 900_000);
  lab.store.finishChat(run, { reply: '记住了。' }, now);
  lab.store.manuallyOpen(childId, agentId, now);
  const job = lab.store.claimJob(now), user = job.snapshot.find(message => message.role === 'user');
  lab.store.commitJob(job, { creates: [{ kind: 'understanding', topics: ['画画'], summary: '用户一直喜欢画画。',
    detail: { notes: '原有详情不因版本迁移改写。' }, anchorMessageId: user.id, sourceMessageIds: [user.id] }],
  updates: [], mentions: [], retractions: [], overview: { summary: '用户一直喜欢画画。', memoryIds: [], createIndexes: [0] } }, now);
  lab.store.recordUsage({ key: 'historical-review', sessionId: job.session_id, kind: 'memory', name: 'review',
    model: 'historical-memory-model', pending: false, status: 'succeeded' }, now);
  lab.store.ensureContextBrief(childId, agentId, now, { modelName: 'historical-memory-model', sessionId: job.session_id });
}

test('framework 5 adopts only the explicitly authorized 1.2.0 fingerprint and changes no data outside lab_meta', async t => {
  assert.equal(MEMORY_FRAMEWORK_VERSION, 6);
  assert.deepEqual(MEMORY_COMPATIBLE_DATA_VERSIONS[5], [deployed120]);
  const directory = await mkdtemp(join(tmpdir(), 'croco-preserve-120-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'chat.sqlite');
  let lab = await openLab(dbPath, { appVersion: '1.2.0', memoryFrameworkVersion: 4, legacyFingerprint: deployed120,
    contextBriefEnabled: false });
  seedAllTables(lab);
  seedPreservedOverview(lab);
  const preserved = completeSnapshot(lab.store);
  assert(preserved.user_overviews.length);
  assert(preserved.memory_mentions.length);
  assert(preserved.context_briefs.length);
  assert(preserved.usage_records.length);
  await closeLab(lab);

  lab = await openLab(dbPath, { appVersion: '1.3.0', memoryFrameworkVersion: 5, allowDataReset: false,
    contextBriefEnabled: false });
  t.after(() => closeLab(lab));
  const systems = [...lab.runtime.systems].sort(([a], [b]) => a.localeCompare(b));
  const activeFingerprint = createHash('sha256').update(JSON.stringify([5, MEMORY_PROMPT, MEMORY_REPAIR_PROMPT, systems])).digest('hex');
  assert.equal(lab.runtime.dataVersion, activeFingerprint, 'retired review text is excluded from the active memory fingerprint');
  assert.notEqual(lab.runtime.dataVersion, deployed120);
  assert.equal(lab.store.sql("SELECT value FROM lab_meta WHERE key='data_version'").get().value, lab.runtime.dataVersion);
  assert.deepEqual(completeSnapshot(lab.store), preserved,
    'users, messages, memories, details, mentions, overview, cached brief, jobs and historical review usage stay byte-for-byte unchanged');
});

const deployedRepairVersions = [
  ['1.3.0', 5, '326cb06b722e5ccb72f7024336c5bc52b103ee259a4eecea1306fa9c77a91c42'],
  ['1.3.1', 6, '677fa5fb30317b57c448463a4bc0fd36ad271a3d9c351dc5656493e81f23ccb8'],
  ['1.3.2', 6, 'ad087545c4ed5a43f5b686606486629ce75f8b1835820299c8193b3706076ba2'],
  ['1.3.3', 6, 'c90a3f1f13b4c36acabfc9c73a1ea1991d111b8185c3e24c9a242cb4dba7fb7d'],
  ['1.3.4', 6, 'ae4598eaebd0280b9d5e0318b3aa83eb0f8dbd616b61eee433c25c6e2f80b316'],
  ['1.3.5', 6, '6a977c6d15984470760035730a8b665496a0a9480ea0ab09aa4ef1f46c5f0a73'],
  ['1.3.6', 6, 'c4e9387777b9ff19269ad2cb1e9e7aafb0b7bf2dfd498f10a9860aa97b55d6b8'],
  ['1.3.7', 6, 'b124979c5e73ec40aab8583f84ef10178a055e74e7a9885153c9c077c9458bc7'],
  ['1.3.8', 6, 'e2c5eb8a4cc38d4707ff770a43ea137ebfffbc5a15571fa82fb0014ce2a7d494'],
  ['1.3.9', 6, '96d167a946ef3852a0900a3f06df93a5bc19901e94f257854f84c05f2fb9534b'],
  ['1.3.10', 6, '119dd775b8807574ea6bd91ba9dbfe39a153af811876d2a621607496bc9a1291'],
  ['1.3.11', 6, '2c2802f8944d69b0e5c5d027f40e858e44d72524fe1c189818ef55ae3b21e9ec'],
  ['1.3.12', 6, '760e21c0068a87b4a3cc150a0beef67271e6db80215b918be29862643daabb61'],
];
for (const [version, framework, fingerprint] of deployedRepairVersions) {
test(`framework 6 adopts the authorized deployed ${version} fingerprint without rewriting business data`, async t => {
  assert.deepEqual(MEMORY_COMPATIBLE_DATA_VERSIONS[6], deployedRepairVersions.map(item => item[2]));
  const directory = await mkdtemp(join(tmpdir(), 'croco-preserve-130-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'chat.sqlite');
  let lab = await openLab(dbPath, { appVersion: version, memoryFrameworkVersion: framework, legacyFingerprint: fingerprint,
    contextBriefEnabled: false });
  seedAllTables(lab);
  seedPreservedOverview(lab);
  const preserved = completeSnapshot(lab.store);
  await closeLab(lab);
  lab = await openLab(dbPath, { appVersion: '1.3.13', memoryFrameworkVersion: 6, allowDataReset: false,
    contextBriefEnabled: false });
  t.after(() => closeLab(lab));
  assert.notEqual(lab.runtime.dataVersion, fingerprint);
  assert.equal(lab.store.sql("SELECT value FROM lab_meta WHERE key='data_version'").get().value, lab.runtime.dataVersion);
  const systems = [...lab.runtime.systems].sort(([a], [b]) => a.localeCompare(b));
  const activeFingerprint = createHash('sha256').update(JSON.stringify([6, MEMORY_PROMPT, MEMORY_REPAIR_PROMPT, systems])).digest('hex');
  assert.equal(lab.runtime.dataVersion, activeFingerprint, 'the actual repair prompt participates in the data fingerprint');
  assert.deepEqual(completeSnapshot(lab.store), preserved);
});
}

test('framework 6 rejects an unknown prior fingerprint with resets disabled before changing any data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'croco-reject-unknown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'chat.sqlite');
  const unknown = 'unrecognized-memory-layout';
  let lab = await openLab(dbPath, { memoryFrameworkVersion: 4, legacyFingerprint: unknown, contextBriefEnabled: false });
  seedAllTables(lab);
  seedPreservedOverview(lab);
  const preserved = completeSnapshot(lab.store);
  await closeLab(lab);
  lab = createLabServer({ dbPath, appVersion: '1.3.1', memoryFrameworkVersion: 6, allowDataReset: false,
    contextBriefEnabled: false, clock, provider: { chat() { assert.fail('migration never calls a model'); } } });
  t.after(() => closeLab(lab));
  assert.throws(() => lab.runtime.initialize(), /本次启动禁止重置数据/);
  assert.equal(lab.store.sql("SELECT value FROM lab_meta WHERE key='data_version'").get().value, unknown);
  assert.deepEqual(completeSnapshot(lab.store), preserved);
});
