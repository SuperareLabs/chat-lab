import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { BrowserWorkspaceStore, LocalWorkspace, canonicalPath } from '../public/local-workspace.js';

// Exercise the production lease/CAS methods over a serial transactional store.
// IndexedDB has the same atomic readwrite semantics, including between tabs.
class MemoryStore extends BrowserWorkspaceStore {
  constructor() { super(null); this.records = new Map(); this.queue = Promise.resolve(); }
  transact(keys, update) {
    const result = this.queue.then(() => {
      const values = Object.fromEntries(keys.map(key => [key, structuredClone(this.records.get(key))]));
      const change = update(values);
      for (const [key, value] of Object.entries(change.put || {})) this.records.set(key, structuredClone(value));
      for (const key of change.remove || []) this.records.delete(key);
      return structuredClone(change.result);
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
const result = (count = 1, extra = {}) => ({ status: 200, value: { count }, snapshot: { count }, views: { '/api/state': { count } }, nextDeadline: null, ...extra });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const events = values => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const client = async (store, fetcher, extra = {}) => {
  const workspace = new LocalWorkspace({ store, fetcher, channel: false, ...extra });
  await workspace.initialize();
  return workspace;
};

test('public creator credentials persist atomically between tabs and never enter workspace snapshots', async t => {
  const store = new MemoryStore(), envelopes = [];
  const fetcher = async (path, options) => { envelopes.push({ path, ...options }); return json(result()); };
  const a = await client(store, fetcher), b = await client(store, fetcher);
  t.after(() => { a.stop(); b.stop(); });
  const [keyA, keyB] = await Promise.all([a.catalogOwnerKey(true), b.catalogOwnerKey(true)]);
  assert.match(keyA, /^[a-f0-9]{64}$/);
  assert.equal(keyA, keyB);
  assert.equal(await b.catalogOwnerKey(), keyA);
  await a.api('/api/state');
  assert(!envelopes[0].body.includes(keyA));
  assert.equal(JSON.parse(envelopes[0].body).snapshot, null);
  assert(!(await store.read('workspace')).snapshot.catalogOwnerKey);
});

test('a dropped public create response retries the same persisted request without publishing a duplicate', async t => {
  const store = new MemoryStore(), requests = [];
  let drop = true;
  const fetcher = async (path, options) => {
    assert.equal(path, '/api/catalog/agents');
    const body = JSON.parse(options.body);
    requests.push({ body, key: options.headers['X-Chat-Lab-Owner'] });
    if (drop) { drop = false; throw new Error('response lost'); }
    return json({ agent: { id: 'public-a', ...body }, catalogRevision: 1 });
  };
  const first = await client(store, fetcher);
  t.after(() => first.stop());
  const input = { name: '公开搭子', definition: '  定义原文\n保留换行  ' };
  await assert.rejects(first.createPublicAgent(input), /response lost/);
  const reopened = await client(store, fetcher);
  t.after(() => reopened.stop());
  const result = await reopened.createPublicAgent(input);
  assert.equal(result.agent.id, 'public-a');
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].body.definition, input.definition);
  assert.deepEqual((await reopened.metadata()).catalogPendingCreates, []);
});

test('failed credential persistence prevents any public create request', async t => {
  const store = new MemoryStore();
  let calls = 0;
  const workspace = await client(store, async () => { calls++; throw new Error('must not request'); });
  t.after(() => workspace.stop());
  store.updateMeta = async () => { throw new Error('quota'); };
  await assert.rejects(workspace.createPublicAgent({ name: '名字', definition: '设定' }), /quota/);
  assert.equal(calls, 0);
});

test('entering a default role preserves another role legacy draft and restores drafts by user and role', async t => {
  const store = new MemoryStore();
  const original = { childId: 'u1', agentId: 'croc', sessionId: 's1', text: '原角色未发送内容' };
  await store.updateMeta(meta => ({ ...meta, draft: original }));
  let scope = { childId: 'u1', agentId: 'lin-xiaoman', sessionId: 's2' };
  const workspace = await client(store, async () => { throw new Error('no network needed'); }, { getScope: () => scope });
  t.after(() => workspace.stop());
  assert.equal(await workspace.draftForScope(), null);
  await workspace.saveDraft({ ...scope, text: '小满的草稿' });
  assert.equal((await workspace.draftForScope()).text, '小满的草稿');
  assert.deepEqual(await workspace.draftForScope(original), original);
  await workspace.saveDraft(null);
  assert.equal(await workspace.draftForScope(), null);
  assert.deepEqual(await workspace.draftForScope(original), original);
  scope = { childId: 'u2', agentId: 'croc' };
  assert.equal(await workspace.draftForScope(), null);
  scope = original;
  assert.deepEqual(await workspace.draftForScope(), original);
});

test('bootstrap starts with no server workspace and repeated GETs use saved views without network polling', async t => {
  const store = new MemoryStore();
  const requests = [];
  const workspace = await client(store, async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return json(result()); });
  t.after(() => workspace.stop());
  assert.deepEqual(await workspace.api('/api/state'), { count: 1 });
  assert.deepEqual(await workspace.api('/api/state'), { count: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/local');
  assert.equal(requests[0].body.snapshot, null);
  assert.equal(requests[0].body.path, '/api/state');
  assert.equal(canonicalPath('/api/memory?agentId=a&childId=c'), '/api/memory?childId=c&agentId=a');
});

test('two tabs serialize mutations and each sends the latest committed snapshot', async t => {
  const store = new MemoryStore();
  let active = 0;
  let maximum = 0;
  const inputs = [];
  const fetcher = async (_, options) => {
    maximum = Math.max(maximum, ++active);
    const input = JSON.parse(options.body); inputs.push(input.snapshot?.count || 0);
    await new Promise(resolve => setTimeout(resolve, 15));
    --active;
    return json(result((input.snapshot?.count || 0) + 1));
  };
  const first = await client(store, fetcher);
  const second = await client(store, fetcher);
  t.after(() => { first.stop(); second.stop(); });
  await Promise.all([first.api('/api/children', { name: '一' }), second.api('/api/children', { name: '二' })]);
  assert.equal(maximum, 1);
  assert.deepEqual(inputs, [0, 1]);
  assert.equal((await store.read('workspace')).snapshot.count, 2);
  assert.equal((await store.read('workspace')).revision, 2);
});

test('CAS fences old responses and an abandoned operation requires explicit recovery', async () => {
  const store = new MemoryStore();
  await store.acquire('first', 0);
  await store.begin('first', 0, { kind: 'chat' });
  await assert.rejects(store.acquire('second', 200_000), /没有完成保存/);
  await store.recoverOperation(200_000);
  await store.acquire('second', 200_000);
  await store.commit('second', 0, result(9));
  await assert.rejects(store.commit('first', 0, result(2)), /旧响应未覆盖/);
  assert.equal((await store.read('workspace')).snapshot.count, 9);
});

test('done without a final workspace is interrupted and retains user text and streamed reply', async t => {
  const store = new MemoryStore();
  const workspace = await client(store, async () => events([
    { type: 'start', sessionId: 's' }, { type: 'delta', text: '收到的片段' }, { type: 'done' },
  ]));
  t.after(() => workspace.stop());
  await assert.rejects(workspace.chat({ requestId: 'one', childId: 'c', agentId: 'a', messages: [{ text: '刚说的话' }] }, () => {}), /回复连接中断/);
  const recovery = await workspace.recovery();
  assert.equal(recovery.outbox.body.messages[0].text, '刚说的话');
  assert.equal(recovery.outbox.assistant, '收到的片段');
  assert.equal(recovery.outbox.body.sessionId, 's');
  assert.equal((await store.read('workspace')).snapshot, undefined);
});

test('an error event still consumes and commits the final workspace before reporting failure', async t => {
  const store = new MemoryStore();
  const delivered = [];
  const workspace = await client(store, async () => events([
    { type: 'start', sessionId: 's' }, { type: 'delta', text: '部分回复' },
    { type: 'error', message: '模型超时' }, { type: 'workspace', ...result(3) },
  ]));
  t.after(() => workspace.stop());
  await assert.rejects(workspace.chat({ requestId: 'one', messages: [{ text: '用户输入' }] }, event => delivered.push(event.type)), /模型超时/);
  assert.equal((await store.read('workspace')).snapshot.count, 3);
  assert.equal((await workspace.recovery()).outbox, null);
  assert.deepEqual(delivered, ['start', 'delta']);
});

test('failed local save retains received reply and user input for recovery', async t => {
  const store = new MemoryStore();
  store.commit = async () => { throw new Error('空间不足'); };
  const workspace = await client(store, async () => events([
    { type: 'reply_part', index: 0, text: '第一段' }, { type: 'reply_part', index: 1, text: '第二段' },
    { type: 'done' }, { type: 'workspace', ...result() },
  ]));
  t.after(() => workspace.stop());
  await assert.rejects(workspace.chat({ requestId: 'one', messages: [{ text: '还在这里' }] }, () => {}), /空间不足/);
  const recovery = await workspace.recovery();
  assert.equal(recovery.outbox.assistant, '第一段\n\n第二段');
  assert.equal(recovery.outbox.body.messages[0].text, '还在这里');
});

test('memory clear invalidates old cached context and keeps server-returned replacement views', async t => {
  const store = new MemoryStore();
  const workspace = await client(store, async (_, options) => {
    const input = JSON.parse(options.body);
    return json(input.path === '/api/state' ? result(1, { views: { '/api/state': {}, '/api/sessions/s?childId=c&agentId=a': { context: 'old' } } })
      : result(2, { value: { cleared: true }, invalidates: ['/api/sessions/', '/api/memory'], views: { '/api/state': {}, '/api/sessions/s?childId=c&agentId=a': { context: null } } }));
  });
  t.after(() => workspace.stop());
  await workspace.api('/api/state');
  await workspace.api('/api/memory/clear', { childId: 'c', agentId: 'a' });
  assert.deepEqual(await workspace.api('/api/sessions/s?childId=c&agentId=a'), { context: null });
});

test('401 returns to the entrance and never replaces local state', async t => {
  const store = new MemoryStore();
  let unauthorized = 0;
  const workspace = await client(store, async () => new Response('{"error":"请先登录"}', { status: 401 }), { onUnauthorized: () => ++unauthorized });
  t.after(() => workspace.stop());
  await assert.rejects(workspace.api('/api/state'), /请先登录/);
  assert.equal(unauthorized, 1);
  assert.equal((await store.read('workspace')).snapshot, undefined);
});

test('each tab keeps its own outbox when another tab commits a reply', async t => {
  const store = new MemoryStore();
  const first = await client(store, async () => events([{ type: 'done' }, { type: 'workspace', ...result() }]));
  const second = await client(store, async () => json(result()));
  t.after(() => { first.stop(); second.stop(); });
  await second.saveOutbox({ body: { messages: [{ text: '第二个标签页尚未发送' }] } });
  await first.chat({ messages: [{ text: '第一个标签页' }] }, () => {});
  assert.equal((await second.recovery()).outbox.body.messages[0].text, '第二个标签页尚未发送');
});

test('an HTTP error envelope still saves its returned workspace before throwing', async t => {
  const store = new MemoryStore();
  const workspace = await client(store, async () => new Response(JSON.stringify(result(7, { status: 409, value: { error: '角色版本已更新' } })), { status: 409 }));
  t.after(() => workspace.stop());
  await assert.rejects(workspace.api('/api/agents/a', { name: '改名' }, 'PATCH'), /角色版本已更新/);
  assert.equal((await store.read('workspace')).snapshot.count, 7);
});

test('aborting a live chat keeps its durable message and does not retry the network', async t => {
  const store = new MemoryStore();
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let calls = 0;
  const workspace = await client(store, (_, { signal }) => new Promise((resolve, reject) => {
    ++calls; began();
    signal.addEventListener('abort', () => reject(new DOMException('已中止', 'AbortError')), { once: true });
  }));
  t.after(() => workspace.stop());
  const pending = workspace.chat({ messages: [{ text: '退出也不会丢' }] }, () => {});
  await started;
  workspace.abortChat();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal((await workspace.recovery()).outbox.body.messages[0].text, '退出也不会丢');
});

test('a first bootstrap interrupted before commit can recover and bootstrap a fresh workspace', async t => {
  const store = new MemoryStore();
  await store.acquire('closed-tab', 0);
  await store.begin('closed-tab', 0, { kind: 'request', path: '/api/state' });
  const envelopes = [];
  const workspace = await client(store, async (_, options) => { envelopes.push(JSON.parse(options.body)); return json(result()); });
  t.after(() => workspace.stop());
  const entry = await workspace.entryState();
  assert.equal(entry.hasState, false);
  assert.equal(entry.operation.owner, 'closed-tab');
  assert.equal(entry.activeUntil, null);
  await workspace.acknowledgeRecovery();
  assert.deepEqual(await workspace.api('/api/state'), { count: 1 });
  assert.equal(envelopes[0].snapshot, null);
  assert.equal((await workspace.entryState()).hasState, true);
  assert.equal((await store.read('workspace')).operation, null);
});

test('entry preflight reports a live owner and cannot discard its operation or saved outbox', async t => {
  const store = new MemoryStore();
  await store.acquire('live-tab');
  await store.begin('live-tab', 0, { kind: 'chat', path: '/api/chat' });
  const workspace = await client(store, async () => { throw new Error('must not dispatch during preflight'); });
  t.after(() => workspace.stop());
  await workspace.saveOutbox({ body: { messages: [{ text: '保留草稿' }] } }, 'live-tab');
  const entry = await workspace.entryState();
  assert.ok(entry.activeUntil > Date.now());
  assert.equal(entry.operation.owner, 'live-tab');
  await assert.rejects(workspace.acknowledgeRecovery(), /另一个标签页仍在处理/);
  assert.equal((await workspace.entryState()).outbox.body.messages[0].text, '保留草稿');
  await store.clearOperation('live-tab');
  await store.release('live-tab');
  assert.equal((await workspace.entryState()).operation, null);
});

test('a pre-start rejection saves the workspace but retains the message not archived by the server', async t => {
  const store = new MemoryStore();
  const workspace = await client(store, async () => events([
    { type: 'error', message: '模型尚未配置' },
    { type: 'workspace', ...result(4, { status: 503, value: { error: '模型尚未配置' } }) },
  ]));
  t.after(() => workspace.stop());
  await assert.rejects(workspace.chat({ messages: [{ text: '尚未归档的输入' }] }, () => {}), /模型尚未配置/);
  assert.equal((await store.read('workspace')).snapshot.count, 4);
  assert.equal((await workspace.recovery()).outbox.body.messages[0].text, '尚未归档的输入');
});

test('the real entry controller reaches recovery before loadState, then resumes the first bootstrap', async t => {
  const store = new MemoryStore();
  await store.acquire('closed-tab', 0);
  await store.begin('closed-tab', 0, { kind: 'request', path: '/api/state' });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const entrySource = source.slice(source.indexOf('async function enterWorkspace('), source.indexOf('\nlet refreshingLocal'));
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: '', open: false,
      showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const loaded = [];
  const logout = { hidden: false };
  let workspace;
  const controller = runInNewContext(`
    let workspaceClient = null, localSelection = {}, bootstrapSerial = 0;
    let pendingEntry = null, entryRecoveryTimer, recoveryData;
    const api = (...args) => workspaceClient.api(...args);
    ${entrySource}
    ({ enterWorkspace, resumeEntryRecovery,
      pending: () => Boolean(pendingEntry), busy: () => state.busy });
  `, {
    LocalWorkspace: function (options) {
      workspace = new LocalWorkspace({ ...options, store, channel: false, fetcher: async () => json(result()) });
      return workspace;
    },
    state: { authenticated: false, busy: false }, selectedScope: () => ({}),
    loadState: async data => loaded.push(data), updateControls() {}, fitComposer() {},
    refreshCatalogPermissions: async () => false,
    offerRecovery: async () => false, openGuide() {}, refreshLocalView() {}, show() {}, showEntrance() {},
    ui: { 'chat-input': { value: '' }, logout }, el, Date,
    document: { body: { classList: { remove() {} } } },
    setTimeout: () => 1, clearTimeout() {},
  });
  t.after(() => workspace?.stop());
  await controller.enterWorkspace({ storageMode: 'browser', passwordRequired: false });
  assert.equal(logout.hidden, true, 'local password-free entry has no logout gate');
  assert.equal(loaded.length, 0, 'state loading must not run behind an abandoned lock');
  assert.equal(controller.pending(), true);
  assert.equal(controller.busy(), true);
  assert.equal(el('recovery-dialog').open, true);
  assert.equal(el('entrance').hidden, true, 'successful authentication must not loop back to the password card');
  await controller.resumeEntryRecovery();
  assert.equal(loaded.length, 1);
  assert.equal(controller.pending(), false);
  assert.equal(controller.busy(), false);
  assert.equal((await store.read('workspace')).revision, 1);
});

test('a queued request keeps the business scope captured when it was called', async t => {
  const store = new MemoryStore();
  let finishFirst;
  const firstGate = new Promise(resolve => { finishFirst = resolve; });
  let startedFirst;
  const firstStarted = new Promise(resolve => { startedFirst = resolve; });
  const envelopes = [];
  const currentScope = { childId: 'user-a', agentId: 'agent-a', sessionId: 'session-a' };
  const workspace = await client(store, async (_, options) => {
    const envelope = JSON.parse(options.body);
    envelopes.push(envelope);
    if (envelopes.length === 1) { startedFirst(); await firstGate; }
    return json(result(envelopes.length));
  }, { getScope: () => currentScope });
  t.after(() => workspace.stop());
  const first = workspace.api('/api/sessions', { childId: 'user-a', agentId: 'agent-a' });
  await firstStarted;
  const queued = workspace.api('/api/memory/clear', { childId: 'user-a', agentId: 'agent-a' });
  Object.assign(currentScope, { childId: 'user-b', agentId: 'agent-b', sessionId: 'session-b' });
  finishFirst();
  await Promise.all([first, queued]);
  assert.equal(envelopes[1].path, '/api/memory/clear');
  assert.deepEqual(envelopes[1].scope, { childId: 'user-a', agentId: 'agent-a', sessionId: 'session-a' });
  assert.deepEqual(envelopes[1].body, { childId: 'user-a', agentId: 'agent-a' });
});
