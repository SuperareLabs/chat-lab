// All visitor state stays in this origin's IndexedDB. The server receives one
// temporary snapshot per operation and never becomes the workspace owner.
const DATABASE = 'all-agent-browser-workspace';
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 10_000;
const clone = value => value == null ? value : structuredClone(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identifier = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
  : [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export function canonicalPath(path) {
  const url = new URL(path, 'http://workspace.local');
  const params = new URLSearchParams();
  for (const key of ['childId', 'agentId']) if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key));
  for (const [key, value] of [...url.searchParams].sort(([a], [b]) => a.localeCompare(b))) {
    if (!['childId', 'agentId'].includes(key)) params.append(key, value);
  }
  return `${url.pathname}${params.size ? `?${params}` : ''}`;
}

export class BrowserWorkspaceStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.promise = null; }
  open() {
    if (!this.indexedDB) throw new Error('当前浏览器无法使用本地数据库。请使用普通浏览窗口，并允许网站保存数据。');
    return this.promise ||= new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('records'); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.promise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('无法打开本地数据库。'));
      request.onblocked = () => reject(new Error('请关闭此体验版的旧标签页后重试。'));
    });
  }
  async transact(keys, update) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('records', 'readwrite');
      const records = transaction.objectStore('records');
      const values = {};
      let remaining = keys.length;
      let result;
      let failure;
      for (const key of keys) {
        const request = records.get(key);
        request.onsuccess = () => {
          values[key] = request.result;
          if (--remaining) return;
          try {
            const change = update(values);
            result = change.result;
            for (const [name, value] of Object.entries(change.put || {})) records.put(value, name);
            for (const name of change.remove || []) records.delete(name);
          } catch (error) { failure = error; transaction.abort(); }
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(failure || transaction.error || new Error('本地保存失败，请检查浏览器可用空间。'));
    });
  }
  read(key) { return this.transact([key], values => ({ result: values[key] })); }
  updateMeta(update) { return this.transact(['meta'], ({ meta = {} }) => {
    const next = update(meta); return { put: { meta: next }, result: next };
  }); }
  acquire(owner, now = Date.now()) {
    return this.transact(['lease', 'workspace'], ({ lease, workspace }) => {
      if (lease && lease.owner !== owner && lease.expiresAt > now) return { result: false };
      if (workspace?.operation && workspace.operation.owner !== owner) {
        const error = new Error('上个标签页的操作没有完成保存。请先查看保留的草稿，再继续使用。');
        error.needsRecovery = true;
        throw error;
      }
      const token = { owner, expiresAt: now + LEASE_MS };
      return { put: { lease: token }, result: token };
    });
  }
  renew(owner, now = Date.now()) {
    return this.transact(['lease'], ({ lease }) => {
      if (lease?.owner !== owner) return { result: false };
      return { put: { lease: { owner, expiresAt: now + LEASE_MS } }, result: true };
    });
  }
  release(owner) {
    return this.transact(['lease'], ({ lease }) => lease?.owner === owner ? { remove: ['lease'], result: true } : { result: false });
  }
  begin(owner, revision, operation) {
    return this.transact(['lease', 'workspace'], ({ lease, workspace }) => {
      if (lease?.owner !== owner || (workspace?.revision || 0) !== revision) throw new Error('本地数据已更新，请重试。');
      return { put: { workspace: { ...workspace, revision, operation: { ...operation, owner } } } };
    });
  }
  commit(owner, revision, result, { clearViews = false, clearOutbox = false } = {}) {
    return this.transact(['lease', 'workspace', 'meta'], ({ lease, workspace, meta = {} }) => {
      if (lease?.owner !== owner || (workspace?.revision || 0) !== revision) throw new Error('另一个标签页已更新数据，本次旧响应未覆盖新记录。');
      const views = clearViews ? {} : { ...workspace?.views };
      for (const prefix of result.invalidates || []) for (const key of Object.keys(views)) {
        if (key.startsWith(prefix)) delete views[key];
      }
      for (const [path, value] of Object.entries(result.views || {})) views[canonicalPath(path)] = value;
      const next = { revision: revision + 1, snapshot: result.snapshot, views,
        nextDeadline: result.nextDeadline ?? null, updatedAt: Date.now(), operation: null };
      const outboxes = { ...meta.outboxes };
      if (clearOutbox) delete outboxes[owner];
      return { put: { workspace: next, ...(clearOutbox ? { meta: { ...meta, outboxes } } : {}) }, result: next };
    });
  }
  clearOperation(owner) {
    return this.transact(['workspace'], ({ workspace }) => workspace?.operation?.owner === owner
      ? { put: { workspace: { ...workspace, operation: null } } } : {});
  }
  recoverOperation(now = Date.now()) {
    return this.transact(['workspace', 'lease'], ({ workspace, lease }) => {
      if (lease?.expiresAt > now) throw new Error('另一个标签页仍在处理，请回到该标签页，或稍后再试。');
      return { put: { workspace: { ...workspace, operation: null } }, remove: ['lease'] };
    });
  }
}

async function readEvents(response, onEvent) {
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    const error = new Error(data?.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lines = [];
  const line = async value => {
    if (!value) {
      if (lines.length) await onEvent(JSON.parse(lines.join('\n')));
      lines = [];
    } else if (value.startsWith('data:')) lines.push(value.slice(5).trimStart());
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        await line(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
      if (done) break;
    }
    if (buffer) await line(buffer.replace(/\r$/, ''));
    await line('');
  } finally { await reader.cancel().catch(() => {}); }
}

export class LocalWorkspace {
  constructor({ store = new BrowserWorkspaceStore(), fetcher = globalThis.fetch.bind(globalThis), getScope = () => ({}),
    onUnauthorized = () => {}, onChange = () => {}, onError = () => {}, channel = true } = {}) {
    Object.assign(this, { store, fetcher, getScope, onUnauthorized, onChange, onError });
    this.owner = identifier();
    this.queue = Promise.resolve();
    this.timer = null;
    this.active = false;
    this.channel = channel && typeof BroadcastChannel === 'function' ? new BroadcastChannel(DATABASE) : null;
    if (this.channel) this.channel.onmessage = () => { if (this.active) this.onChange(); };
  }
  async initialize() {
    const [record, meta] = await Promise.all([this.store.read('workspace'), this.store.read('meta')]);
    this.active = true;
    this.meta = meta || {};
    if (!record?.operation) this.schedule(record?.nextDeadline);
    return this;
  }
  stop() { this.active = false; clearTimeout(this.timer); this.abortChat(); }
  abortChat() { this.chatController?.abort(); }
  async metadata() { return await this.store.read('meta') || {}; }
  async saveSelection(selection) { await this.store.updateMeta(meta => ({ ...meta, selection: clone(selection) })); }
  async saveGuide() { await this.store.updateMeta(meta => ({ ...meta, guideSeen: true })); }
  async catalogOwnerKey(create = false) {
    const valid = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
    if (!create) {
      const key = (await this.metadata()).catalogOwnerKey;
      if (key === undefined) return null;
      if (!valid(key)) throw new Error('本机角色管理凭证无法读取，请保留网站数据并联系维护者。');
      return key;
    }
    const candidate = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const meta = await this.store.updateMeta(meta => {
      if (meta.catalogOwnerKey !== undefined && !valid(meta.catalogOwnerKey)) throw new Error('本机角色管理凭证无法读取，已停止创建。');
      return { ...meta, catalogOwnerKey: meta.catalogOwnerKey || candidate };
    });
    if (!valid(meta.catalogOwnerKey)) throw new Error('角色管理凭证未能保存，已停止创建。');
    return meta.catalogOwnerKey;
  }
  async catalogRequest(path = '/api/catalog', { method = 'GET', body, ownerKey } = {}) {
    const key = ownerKey ?? await this.catalogOwnerKey();
    const response = await this.fetcher(path, { method, cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'X-Chat-Lab-Owner': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => null);
    if (response.status === 401) this.onUnauthorized();
    if (!response.ok || !value) {
      const error = new Error(value?.error || `公共角色库请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return value;
  }
  async createPublicAgent({ name, definition, videoVoiceId }) {
    const ownerKey = await this.catalogOwnerKey(true);
    const matches = item => item.name === name && item.definition === definition && (item.videoVoiceId || '') === (videoVoiceId || '');
    const meta = await this.store.updateMeta(meta => {
      const pending = [...(meta.catalogPendingCreates || [])];
      if (!pending.some(matches)) pending.push({ name, definition, ...(videoVoiceId ? { videoVoiceId } : {}), requestId: identifier() });
      return { ...meta, catalogPendingCreates: pending };
    });
    const request = meta.catalogPendingCreates.find(matches);
    if (!request?.requestId) throw new Error('创建请求未能保存，已停止公开创建。');
    const result = await this.catalogRequest('/api/catalog/agents', { method: 'POST', body: request, ownerKey });
    if (!result.agent?.id) throw new Error('公共角色已提交，但返回结果不完整；请保留设定后重试。');
    await this.store.updateMeta(meta => ({ ...meta,
      catalogPendingCreates: (meta.catalogPendingCreates || []).filter(item => item.requestId !== request.requestId) }));
    return result;
  }
  async updatePublicAgent(id, body) {
    const ownerKey = await this.catalogOwnerKey();
    if (!ownerKey) throw new Error('当前浏览器没有这个角色的管理凭证。');
    return this.catalogRequest(`/api/catalog/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body, ownerKey });
  }
  async deletePublicAgent(id, revision) {
    const ownerKey = await this.catalogOwnerKey();
    if (!ownerKey) throw new Error('当前浏览器没有这个角色的管理凭证。');
    return this.catalogRequest(`/api/catalog/agents/${encodeURIComponent(id)}`, { method: 'DELETE', body: { revision }, ownerKey });
  }
  async saveDraft(draft) {
    await this.store.updateMeta(meta => {
      const drafts = { ...meta.drafts };
      const key = value => value?.childId && value?.agentId ? JSON.stringify([value.childId, value.agentId]) : null;
      const previousKey = key(meta.draft);
      if (previousKey && meta.draft.text) drafts[previousKey] = clone(meta.draft);
      const currentKey = key(draft || this.getScope());
      if (currentKey) {
        if (draft?.text) drafts[currentKey] = clone(draft);
        else delete drafts[currentKey];
      }
      return { ...meta, draft: clone(draft), drafts };
    });
  }
  async draftForScope(scope = this.getScope()) {
    const meta = await this.metadata();
    const key = JSON.stringify([scope.childId, scope.agentId]);
    return meta.drafts?.[key] || (meta.draft?.childId === scope.childId && meta.draft?.agentId === scope.agentId ? meta.draft : null);
  }
  async saveOutbox(outbox, owner = this.owner) {
    await this.store.updateMeta(meta => {
      const outboxes = { ...meta.outboxes };
      if (outbox) outboxes[owner] = clone(outbox); else delete outboxes[owner];
      return { ...meta, outboxes };
    });
  }
  async resumeDeadlines() { const record = await this.store.read('workspace'); this.schedule(record?.nextDeadline); }
  async entryState() {
    const [record, recovery] = await Promise.all([this.store.read('workspace'), this.recovery({ includeActive: true })]);
    return { ...recovery, hasState: Boolean(record?.snapshot && record.views?.['/api/state']) };
  }
  async recovery({ includeActive = false } = {}) {
    const [meta, record, lease] = await Promise.all([this.metadata(), this.store.read('workspace'), this.store.read('lease')]);
    const activeOwner = lease?.expiresAt > Date.now() ? lease.owner : null;
    const candidates = Object.entries(meta.outboxes || {});
    const found = candidates.find(([owner]) => owner === this.owner) || candidates.find(([owner]) => owner !== activeOwner)
      || (includeActive ? candidates[0] : null);
    return { outbox: found?.[1] || null, outboxOwner: found?.[0],
      operation: !includeActive && activeOwner && activeOwner !== this.owner ? null : record?.operation,
      activeUntil: activeOwner ? lease.expiresAt : null };
  }
  async acknowledgeRecovery() { await this.store.recoverOperation(); }
  serialize(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  async lock(action) {
    if (!this.active) throw new Error('请先进入体验版。');
    let lease;
    const started = Date.now();
    while (!(lease = await this.store.acquire(this.owner))) {
      if (!this.active) throw new Error('请先进入体验版。');
      if (Date.now() - started > 125_000) throw new Error('另一个标签页仍在处理，请稍后重试。');
      await delay(180 + Math.random() * 100);
    }
    let lost = false;
    const heartbeat = setInterval(() => { void this.store.renew(this.owner).then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }); }, HEARTBEAT_MS);
    try { return await action(() => { if (lost) throw new Error('本地数据锁已失效，本次旧响应不会覆盖新记录。'); }); }
    finally { clearInterval(heartbeat); await this.store.release(this.owner); }
  }
  schedule(deadline) {
    clearTimeout(this.timer);
    if (!this.active || !Number.isFinite(deadline)) return;
    this.timer = setTimeout(() => {
      if (!this.active) return;
      void this.api('/api/state', undefined, 'GET', { force: true }).then(() => this.onChange()).catch(error => this.onError(error));
    }, Math.max(100, Math.min(deadline - Date.now() + 80, 2_147_483_647)));
  }
  async api(path, body, method = body === undefined ? 'GET' : 'POST', { force = false } = {}) {
    const key = canonicalPath(path);
    const capturedScope = clone(this.getScope());
    if (method === 'GET' && !force) {
      const record = await this.store.read('workspace');
      if (record?.views && Object.hasOwn(record.views, key)) return clone(record.views[key]);
    }
    return this.serialize(() => this.lock(async assertLease => {
      const record = await this.store.read('workspace');
      // A previous tab may have populated this view while this operation waited.
      if (method === 'GET' && !force && Object.hasOwn(record?.views || {}, key)) return clone(record.views[key]);
      const revision = record?.revision || 0;
      await this.store.begin(this.owner, revision, { path: key, kind: 'request', startedAt: Date.now() });
      try {
        const response = await this.fetcher('/api/local', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, path: key, ...(body === undefined ? {} : { body }), snapshot: record?.snapshot || null, scope: capturedScope }) });
        const result = await response.json().catch(() => null);
        if (response.status === 401) this.onUnauthorized();
        if ((!response.ok && !result?.snapshot) || !result) {
          const error = new Error(result?.error || `请求失败 (${response.status})`); error.status = response.status; throw error;
        }
        assertLease();
        if (!result.snapshot) throw new Error('服务未返回可保存的本地数据，请保留页面并重试。');
        const saved = await this.store.commit(this.owner, revision, result, { clearViews: method !== 'GET' });
        this.schedule(saved.nextDeadline);
        this.channel?.postMessage({ revision: saved.revision });
        if (result.status >= 400) { const error = new Error(result.value?.error || '操作失败'); error.status = result.status; throw error; }
        return clone(result.value);
      } finally { await this.store.clearOperation(this.owner); }
    }));
  }
  chat(body, onEvent) {
    return this.serialize(() => this.lock(async assertLease => {
      const record = await this.store.read('workspace');
      const revision = record?.revision || 0;
      let outbox = { body: clone(body), assistant: '', startedAt: Date.now(), dispatched: true };
      await this.saveOutbox(outbox);
      await this.store.begin(this.owner, revision, { path: '/api/chat', kind: 'chat', requestId: body.requestId, startedAt: Date.now() });
      const controller = new AbortController();
      this.chatController = controller;
      let persisted = false;
      let began = false;
      let failure;
      let checkpoint = 0;
      let deltaText = '';
      const replyParts = new Map();
      try {
        const response = await this.fetcher('/api/local', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: controller.signal, body: JSON.stringify({ method: 'POST', path: '/api/chat', body, snapshot: record?.snapshot || null, scope: { childId: body.childId, agentId: body.agentId, sessionId: body.sessionId } }) });
        if (response.status === 401) this.onUnauthorized();
        await readEvents(response, async event => {
          if (event.type === 'workspace') {
            assertLease();
            if (!event.snapshot) throw new Error('回复已收到，但本地保存数据不完整。');
            const saved = await this.store.commit(this.owner, revision, event, { clearViews: true, clearOutbox: began });
            persisted = true;
            this.schedule(saved.nextDeadline);
            this.channel?.postMessage({ revision: saved.revision });
          } else {
            if (event.type === 'start') began = true;
            if (event.sessionId) outbox.body.sessionId = event.sessionId;
            if (event.type === 'delta' && typeof event.text === 'string') deltaText += event.text;
            if (event.type === 'reply_part' && Number.isInteger(event.index) && typeof event.text === 'string') replyParts.set(event.index, event.text);
            outbox.assistant = deltaText || [...replyParts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n');
            if (event.type === 'error') failure = new Error(event.message || event.error || '本轮回复失败');
            // Keep reading after an error: the final workspace contains the user
            // messages, partial reply and recorded model usage for this attempt.
            else onEvent(event);
            if (Date.now() - checkpoint > 300 && !persisted) { checkpoint = Date.now(); await this.saveOutbox(outbox); }
          }
        });
        if (!persisted) throw new Error('回复连接中断。你发出的消息和已收到的回复已保留在本机，可恢复草稿。');
        if (failure) throw failure;
      } catch (error) {
        if (!persisted) await this.saveOutbox(outbox);
        throw error;
      } finally {
        if (this.chatController === controller) this.chatController = null;
        await this.store.clearOperation(this.owner);
      }
    }));
  }
}
