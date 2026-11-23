import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const gallerySource = await readFile(new URL('../public/agent-gallery.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const editorSource = appSource.slice(appSource.indexOf('async function api('), appSource.indexOf('\nfunction selectedScope('));
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

// A small DOM contract harness executes the actual event handlers and rendering
// code. It intentionally leaves browser layout and focus-trapping to UI checks.
class Element {
  constructor(tagName, id = '') {
    Object.assign(this, { tagName, id, children: [], dataset: {}, attributes: {}, listeners: new Map(),
      className: '', value: '', disabled: false, hidden: false, open: false, clientWidth: 0, _text: '' });
    const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...names) => { this.className = [...new Set([...tokens(), ...names])].join(' '); },
      contains: name => tokens().has(name),
      toggle: (name, force) => {
        const next = tokens();
        const enabled = force ?? !next.has(name);
        if (enabled) next.add(name); else next.delete(name);
        this.className = [...next].join(' ');
        return enabled;
      },
    };
  }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  async fire(name, extra = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    await Promise.all((this.listeners.get(name) || []).map(handler => handler(event)));
    return event;
  }
  click() { if (!this.disabled) return this.fire('click'); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close'); }
  querySelectorAll(selector) {
    const matches = child => selector.split(',').some(part => {
      part = part.trim();
      return part.startsWith('.') ? child.classList.contains(part.slice(1)) : child.tagName === part;
    });
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { width: 0, height: 0 }; }
}

function dom() {
  const nodes = new Map();
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1], match[2]);
    element.hidden = /\bhidden\b/.test(match[0]);
    element.disabled = /\bdisabled\b/.test(match[0]);
    nodes.set(element.id, element);
  }
  const document = { getElementById: id => nodes.get(id), createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag) };
  nodes.get('agent-editor-form').reset = () => {
    for (const key of ['agent-editor-name', 'agent-editor-definition', 'agent-editor-voice-id']) nodes.get(key).value = '';
  };
  return { document, nodes };
}

function editorHarness({ respond, onSaved = async () => {}, canOpen = () => true } = {}) {
  const { document, nodes } = dom();
  const requests = [];
  const busy = [];
  const fetch = async (path, options) => {
    requests.push({ path, ...options, ...(options?.body ? { payload: JSON.parse(options.body) } : {}) });
    const result = await respond(path, options);
    return { ok: result.status < 400, status: result.status, json: async () => result.body };
  };
  const install = runInNewContext(`${editorSource}\ninstallAgentEditor;`, {
    document, el: id => document.getElementById(id), fetch,
  });
  return { nodes, requests, busy, editor: install({ canOpen, onSaved, onBusyChanged: value => busy.push(value) }) };
}

test('the creator can bind a voice and blocks duplicate submissions without a selected user', async () => {
  let finish;
  const saved = [];
  const harness = editorHarness({
    respond: () => new Promise(resolve => { finish = resolve; }),
    onSaved: async (agent, options) => saved.push({ agent, options }),
  });
  const { editor, nodes, requests, busy } = harness;
  await editor.open();
  assert.equal(nodes.get('agent-editor').open, true);
  assert.equal(nodes.get('agent-editor-title').textContent, '创建角色');
  const dialogHtml = html.match(/<dialog id="agent-editor"[\s\S]+?<\/dialog>/)[0];
  assert.deepEqual([...dialogHtml.matchAll(/<(input|textarea)\b[^>]*\bname="([^"]+)"/g)].map(match => match[2]), ['name', 'definition', 'videoVoiceId']);
  nodes.get('agent-editor-name').value = '  灯灯  ';
  nodes.get('agent-editor-definition').value = '\n第一段。\n\n  第二段保留缩进。\n';
  nodes.get('agent-editor-voice-id').value = ' S_testVoice ';
  const pending = nodes.get('agent-editor-form').fire('submit');
  await nodes.get('agent-editor-form').fire('submit');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/api/agents');
  assert.deepEqual(requests[0].payload, { name: '灯灯', definition: '\n第一段。\n\n  第二段保留缩进。\n', videoVoiceId: 'S_testVoice' });
  assert.equal(nodes.get('agent-editor-save').disabled, true);
  assert.equal(nodes.get('agent-editor-cancel').disabled, true);
  assert.equal((await nodes.get('agent-editor').fire('cancel')).defaultPrevented, true);
  finish({ status: 201, body: { agent: { id: 'new-agent', name: '灯灯', revision: 1 } } });
  await pending;
  assert.equal(nodes.get('agent-editor').open, false);
  assert.deepEqual(plain(saved), [{ agent: { id: 'new-agent', name: '灯灯', revision: 1 }, options: { created: true } }]);
  assert.deepEqual(busy, [true, false]);
});

test('editing reads saved text and sends PATCH with the hidden revision', async () => {
  const saved = [];
  const { editor, nodes, requests } = editorHarness({
    respond: async (_, options) => ({ status: 200, body: { agent: options?.method === 'PATCH'
      ? { id: 'stable-id', name: '新名字', revision: 8 }
      : { id: 'stable-id', name: '旧名字', definition: '真实原文。\n\n第二段。', revision: 7 } } }),
    onSaved: async (agent, options) => saved.push({ agent, options }),
  });
  await editor.open('stable-id');
  assert.equal(nodes.get('agent-editor-definition').value, '真实原文。\n\n第二段。');
  nodes.get('agent-editor-name').value = '新名字';
  await nodes.get('agent-editor-form').fire('submit');
  assert.equal(requests[0].path, '/api/agents/stable-id');
  assert.equal(requests[0].method, undefined);
  assert.equal(requests[1].method, 'PATCH');
  assert.deepEqual(requests[1].payload, { name: '新名字', definition: '真实原文。\n\n第二段。', revision: 7 });
  assert.equal(saved[0].agent.id, 'stable-id');
  assert.equal(saved[0].options.created, false);
});

test('cancelled drafts never write, and a revision conflict keeps the draft until explicit reload', async () => {
  let revision = 2;
  const { editor, nodes, requests } = editorHarness({ respond: async (_, options) => options?.method === 'PATCH'
    ? { status: 409, body: { error: 'stale revision' } }
    : { status: 200, body: { agent: { id: 'a', name: '服务端名称', definition: `服务端版本${revision}`, revision } } } });
  await editor.open();
  nodes.get('agent-editor-name').value = '未保存草稿';
  await nodes.get('agent-editor-cancel').fire('click');
  assert.equal(requests.length, 0);
  await editor.open('a');
  nodes.get('agent-editor-definition').value = '我的草稿\n仍在这里';
  await nodes.get('agent-editor-form').fire('submit');
  assert.equal(nodes.get('agent-editor-definition').value, '我的草稿\n仍在这里');
  assert.equal(nodes.get('agent-editor').open, true);
  assert.equal(nodes.get('agent-editor-reload').hidden, false);
  assert.match(nodes.get('agent-editor-error').textContent, /草稿已保留/);
  await nodes.get('agent-editor-form').fire('submit');
  assert.equal(requests.length, 2);
  revision = 3;
  await nodes.get('agent-editor-reload').fire('click');
  await tick();
  assert.equal(nodes.get('agent-editor-definition').value, '服务端版本3');
  assert.equal(nodes.get('agent-editor-save').disabled, false);
});

test('a failed state refresh retries only the refresh and does not create a duplicate role', async () => {
  let refreshCalls = 0;
  const { editor, nodes, requests } = editorHarness({
    respond: async () => ({ status: 201, body: { agent: { id: 'created-once', revision: 1 } } }),
    onSaved: async () => { if (++refreshCalls === 1) throw new Error('网络中断'); },
  });
  await editor.open();
  nodes.get('agent-editor-name').value = '一次';
  nodes.get('agent-editor-definition').value = '原文';
  await nodes.get('agent-editor-form').fire('submit');
  assert.match(nodes.get('agent-editor-error').textContent, /已保存/);
  assert.equal(nodes.get('agent-editor-save').textContent, '刷新界面');
  await nodes.get('agent-editor-form').fire('submit');
  assert.equal(requests.length, 1);
  assert.equal(refreshCalls, 2);
  assert.equal(nodes.get('agent-editor').open, false);
});

test('saving an existing role preserves the user, session and history; creating selects only the new role', async () => {
  const source = appSource.slice(appSource.indexOf('async function applyAgentChange('), appSource.indexOf('\nconst agentEditor ='));
  const history = { messages: [{ text: '历史消息' }] };
  const state = { agentId: 'old', childId: 'user', sessionId: 'session', conversation: history };
  const effects = [];
  const apply = runInNewContext(`${source}\napplyAgentChange;`, { state,
    api: async () => ({ agents: [{ id: 'old', name: '改名', revision: 2 }, { id: 'new', name: '新角色', revision: 1 }], model: {} }),
    syncAgentGalleryRoute: { refresh: () => effects.push('cache-refresh') },
    changeScope: async () => effects.push('change-scope'),
    renderSelectors: () => effects.push('render'), saveSelection: () => effects.push('persist-selection'),
  });
  await apply({ id: 'old' }, { created: false });
  assert.equal(state.agentId, 'old');
  assert.equal(state.childId, 'user');
  assert.equal(state.sessionId, 'session');
  assert.equal(state.conversation, history);
  assert.deepEqual(effects, ['cache-refresh', 'render', 'persist-selection']);
  effects.length = 0;
  await apply({ id: 'new' }, { created: true });
  assert.equal(state.agentId, 'new');
  assert.equal(state.childId, 'user');
  assert.deepEqual(effects, ['cache-refresh', 'change-scope']);
});

test('role cards show saved name and definition only, preserve paragraphs and expose edit/expand actions', async () => {
  const { document } = dom();
  const source = gallerySource.slice(gallerySource.indexOf('function element('), gallerySource.indexOf('\nfunction drawConnections('));
  const render = runInNewContext(`${source}\nrenderCard;`, { document });
  const article = new Element('article');
  const edited = [];
  const definition = '第一段。\n\n第二段。' + '设定原文。'.repeat(100);
  render(article, { id: 'a', name: '保存的名称', definition,
    card: { identity: { name: '过时名称', role: '过时身份' }, personality: '过时性格', speakingStyle: '过时说话',
      voice: { mode: 'reference', label: '可选参考', sample: '/assets/voices/owned-reference.mp3' } } },
  '/assets/icons/person-circle.svg', id => edited.push(id));
  assert.equal(article.querySelector('.gallery-character-name').textContent, '保存的名称');
  assert.equal(article.querySelector('.gallery-definition-copy').textContent, definition);
  assert.doesNotMatch(article.textContent, /过时/);
  assert.equal(article.querySelector('audio').src, '/assets/voices/owned-reference.mp3');
  const expand = article.querySelector('.gallery-definition-expand');
  assert.equal(expand.getAttribute('aria-expanded'), 'false');
  await expand.fire('click');
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  assert.equal(article.querySelector('.gallery-definition-copy').classList.contains('is-collapsed'), false);
  await article.querySelector('.gallery-edit-button').fire('click');
  assert.deepEqual(edited, ['a']);
});

test('public role cards expose management only to their creator and keep delete distinct from edit', async () => {
  const { document } = dom();
  const source = gallerySource.slice(gallerySource.indexOf('function element('), gallerySource.indexOf('\nfunction drawConnections('));
  const render = runInNewContext(`${source}\nrenderCard;`, { document });
  const article = new Element('article'), edited = [], removed = [];
  const common = { id: 'public-a', name: '公共角色', definition: '设定', sourceLabel: '公共角色' };
  render(article, { ...common, canEdit: false, canDelete: false }, '/assets/icons/person-circle.svg', id => edited.push(id), id => removed.push(id));
  assert.equal(article.querySelector('.gallery-edit-button'), null);
  assert.equal(article.querySelector('.gallery-delete-button'), null);
  render(article, { ...common, canEdit: true, canDelete: true, sourceLabel: '公共角色 · 我创建的' }, '/assets/icons/person-circle.svg', id => edited.push(id), id => removed.push(id));
  await article.querySelector('.gallery-delete-button').fire('click');
  assert.deepEqual(removed, ['public-a']);
  assert.deepEqual(edited, []);
  assert.match(article.textContent, /我创建的/);
});

test('a catalog unchanged probe retains creator permissions without requesting workspace snapshots', async () => {
  const start = appSource.indexOf('async function refreshCatalogPermissions(');
  const source = appSource.slice(start, appSource.indexOf('\nasync function readEditableAgent', start));
  const state = { catalogRevision: 7, catalogAgents: [{ id: 'mine', canManage: true }], catalogAvailable: true };
  const paths = [];
  const refresh = runInNewContext(`let defaultAgentIds = new Set();${source}\nrefreshCatalogPermissions;`, { state,
    workspaceClient: { catalogRequest: async path => { paths.push(path); return { revision: 7, unchanged: true }; },
      api: async () => { throw new Error('must not send workspace'); } } });
  assert.equal(await refresh({ probe: true }), false);
  assert.deepEqual(paths, ['/api/catalog?revision=7']);
  assert.equal(state.catalogAgents[0].canManage, true);
});

test('saving invalidates real prompt details even when the memory data version is unchanged', async () => {
  const { document, nodes } = dom();
  const location = { href: 'http://localhost/', hash: '' };
  const setUrl = value => {
    const url = new URL(value, location.href);
    location.href = url.href;
    location.hash = url.hash;
  };
  let agent = { id: 'a', name: '名称', definition: '原设定', revision: 1 };
  let calls = 0;
  const install = runInNewContext(gallerySource.replace('export function installAgentGallery', 'function installAgentGallery') + '\ninstallAgentGallery;', {
    document, location, URL, AbortController,
    history: { state: null, pushState: (_, __, url) => setUrl(url), replaceState: (_, __, url) => setUrl(url) },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
    window: { addEventListener() {} },
    fetch: async () => {
      ++calls;
      return { ok: true, json: async () => ({ agentId: 'a', name: agent.name, version: `chat-${agent.revision}`,
        model: 'offline-fixture', system: `真实system-${agent.revision}`, common: '共用', role: agent.definition, dataVersion: 'memory-framework-6' }) };
    },
  });
  nodes.get('agent-select').disabled = false;
  const gallery = install({ trigger: nodes.get('agent-select'), getAgents: () => [agent], getSelectedId: () => 'a',
    getDataVersion: () => 'memory-framework-6', avatarFor: () => '/assets/icons/person-circle.svg', onSelect() {} });
  await nodes.get('agent-select').fire('click');
  await nodes.get('agent-view-prompt').fire('click');
  await tick();
  assert.equal(nodes.get('agent-prompt-content').textContent, '真实system-1');
  await nodes.get('agent-view-overview').fire('click');
  await nodes.get('agent-view-prompt').fire('click');
  await tick();
  assert.equal(calls, 1, 'unchanged details can use the cache');
  agent = { ...agent, name: '修改后', definition: '修改后设定', revision: 2 };
  gallery.refresh();
  await tick();
  assert.equal(calls, 2);
  assert.equal(nodes.get('agent-prompt-content').textContent, '真实system-2');
  assert.equal(nodes.get('agent-gallery-card').querySelector('.gallery-definition-copy').textContent, '修改后设定');
});
