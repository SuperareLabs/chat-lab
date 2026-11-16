import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PublicCatalog } from '../lib/public-catalog.mjs';

const ownerKey = 'a'.repeat(64), otherKey = 'b'.repeat(64);
const create = (catalog, requestId = 'request-1', overrides = {}) => catalog.create({
  name: '  公开搭子  ', definition: '  第一段\r\n\r\n第二段。\n ', requestId, ...overrides,
}, { ownerKey });

test('public roles survive database reopening while creator credentials are hashed and never returned', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'chat-public-catalog-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'roles.sqlite');
  let catalog = new PublicCatalog({ path });
  const created = create(catalog);
  assert.equal(created.agent.name, '公开搭子');
  assert.equal(created.agent.definition, '  第一段\r\n\r\n第二段。\n ');
  assert.equal(created.catalogRevision, 1);
  assert.equal(created.agent.canManage, true);
  assert.equal(catalog.list().agents[0].canManage, false);
  assert.equal(catalog.list(otherKey).agents[0].canManage, false);
  assert.equal(catalog.list(ownerKey).agents[0].canManage, true);
  const payload = JSON.stringify([created, catalog.list(ownerKey)]);
  assert(!payload.includes(ownerKey));
  assert(!payload.includes(createHash('sha256').update(ownerKey).digest('hex')));
  assert(!payload.includes('owner_hash'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  catalog.close();
  catalog = new PublicCatalog({ path });
  assert.equal(catalog.list(ownerKey).agents[0].id, created.agent.id);
  assert.equal(catalog.list().revision, 1);
  assert.deepEqual(catalog.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
    ['public_catalog_agents', 'public_catalog_meta']);
  catalog.close();
});

test('creation retries are idempotent by creator and request, including after edits and deletion', () => {
  const catalog = new PublicCatalog();
  try {
    const first = create(catalog), again = create(catalog);
    assert.equal(again.agent.id, first.agent.id);
    assert.equal(again.catalogRevision, 1);
    assert.throws(() => create(catalog, 'request-1', { definition: '不同内容' }), error => error.status === 409);
    const secondCreator = catalog.create({ name: '同名', definition: '独立角色', requestId: 'request-1' }, { ownerKey: otherKey });
    assert.notEqual(secondCreator.agent.id, first.agent.id);
    const updated = catalog.update(first.agent.id, { name: '新版', definition: ' 新设定\n', revision: 1 }, { ownerKey });
    assert.equal(updated.agent.revision, 2);
    assert.equal(create(catalog).agent.id, first.agent.id);
    assert.equal(create(catalog).agent.definition, ' 新设定\n');
    const deleted = catalog.delete(first.agent.id, { revision: 2 }, { ownerKey });
    assert.equal(deleted.deleted, true);
    assert.deepEqual(catalog.delete(first.agent.id, { revision: 2 }, { ownerKey }), deleted);
    assert(!catalog.list().agents.some(agent => agent.id === first.agent.id));
    assert(catalog.list().deletedIds.includes(first.agent.id));
    assert.throws(() => create(catalog), error => error.status === 410);
    const replacement = create(catalog, 'request-2');
    assert.notEqual(replacement.agent.id, first.agent.id);
    assert(catalog.list().deletedIds.includes(first.agent.id));
  } finally { catalog.close(); }
});

test('only the owning browser may edit or delete and stale revisions cannot overwrite changes', () => {
  const catalog = new PublicCatalog();
  try {
    const { agent } = create(catalog);
    const update = { name: '修改', definition: '不同定义', revision: 1 };
    for (const key of [undefined, '', 'not-a-credential', otherKey]) {
      assert.throws(() => catalog.update(agent.id, update, { ownerKey: key }), error => error.status === 403);
      assert.throws(() => catalog.delete(agent.id, { revision: 1 }, { ownerKey: key }), error => error.status === 403);
    }
    assert.equal(catalog.list().revision, 1);
    catalog.update(agent.id, update, { ownerKey });
    assert.throws(() => catalog.update(agent.id, update, { ownerKey }), error => error.status === 409);
    assert.throws(() => catalog.delete(agent.id, { revision: 1 }, { ownerKey }), error => error.status === 409);
    catalog.delete(agent.id, { revision: 2 }, { ownerKey });
    assert.throws(() => catalog.update(agent.id, { ...update, revision: 3 }, { ownerKey }), error => error.status === 410);
    assert.throws(() => catalog.delete(agent.id, { revision: 2 }, { ownerKey: otherKey }), error => error.status === 403);
  } finally { catalog.close(); }
});

test('catalog validates author text and request fields without storing visitor-shaped extra data', () => {
  const catalog = new PublicCatalog();
  try {
    for (const values of [
      { name: '' }, { definition: '' }, { name: 'a'.repeat(81) }, { name: 'line\nline' }, { definition: 'a\0b' },
      { definition: '中'.repeat(19_000) }, { requestId: undefined }, { requestId: '../invalid' },
      { children: [] }, { messages: [] }, { metadata: { private: true } }, { ownerKey },
    ]) assert.throws(() => create(catalog, 'request-1', values), error => error.status === 400);
    assert.deepEqual(catalog.list(), { revision: 0, agents: [], deletedIds: [] });
  } finally { catalog.close(); }
});

test('a legacy visitor database is refused before public tables are added', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'chat-public-catalog-legacy-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'private.sqlite');
  let db = new DatabaseSync(path);
  db.exec("CREATE TABLE children(id TEXT); INSERT INTO children VALUES('private-user')");db.close();
  assert.throws(() => new PublicCatalog({ path }), /独立数据库/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('SELECT id FROM children').get().id, 'private-user');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'public_catalog_%'").get().n, 0);
  db.close();
});

test('active capacity is bounded but deleting a role makes room without reusing its ID', () => {
  const catalog = new PublicCatalog();
  try {
    for (let i = 0; i < 256; i++) create(catalog, 'request-' + i);
    assert.equal(catalog.list().agents.length, 256);
    assert.throws(() => create(catalog, 'over-capacity'), error => error.status === 409);
    const retired = catalog.list().agents[0];
    catalog.delete(retired.id, { revision: retired.revision }, { ownerKey });
    const replacement = create(catalog, 'over-capacity');
    assert.notEqual(replacement.agent.id, retired.id);
    assert.equal(catalog.list().agents.length, 256);
    assert(catalog.list().deletedIds.includes(retired.id));
  } finally { catalog.close(); }
});
