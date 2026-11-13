import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Run the real DOM builders and stream presenter, without the app bootstrap or
// a browser dependency. Layout and native image/network behavior get a browser
// smoke check separately; this small DOM records the actual element contract.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const nodeSource = source.slice(source.indexOf('function node('), source.indexOf('function newRequestId('));
const messageSource = source.slice(source.indexOf('function assistantBubbles('), source.indexOf('function emptyPanel('));
const streamSource = source.slice(source.indexOf('async function requestReply('), source.indexOf('function fitComposer('));

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.dataset = {};
    this.style = {}; this.attributes = {}; this.listeners = new Map(); this.hidden = false;
    this.scrollHeight = 200; this.clientHeight = 200; this.scrollTop = 0; this.value = '';
    this.classList = {
      add: name => { if (!this.className.split(/\s+/).includes(name)) this.className += ' ' + name; },
      toggle: (name, enabled) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) values.add(name); else values.delete(name);
        this.className = [...values].join(' ');
      },
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) {
    for (const child of children) {
      child.remove(); this.children.push(child); child.parentNode = this;
    }
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...children); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  focus() { this.focused = true; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.')
      ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tagName === selector.toUpperCase();
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const attachment = overrides => ({ id: 'reference-1', type: 'reference_image',
  imageUrl: 'https://images.example.com/reference.jpg', sourceUrl: 'https://www.example.com/article',
  title: '资料中的配图', width: 640, height: 480, ...overrides });
const turn = (text, attachments) => ({ role: 'assistant', text, ...(attachments ? { attachments } : {}) });

function harness({ events = [], history = [], motion = false } = {}) {
  const ui = { messages: new Element('div'), 'chat-empty': new Element('div'),
    'chat-input': new Element('textarea'), 'child-dialog': { open: false } };
  const state = { pendingMessages: [], sessionId: 'session-test', sending: false, conversation: null };
  const timers = [];
  const errors = [];
  const context = {
    document: { createElement: tag => new Element(tag) }, URL,
    ui, state, reduceMotion: { matches: !motion },
    imageForAgent: () => '', agent: () => ({ name: '角色' }), fallbackAvatar: '/fallback.svg',
    put() {}, show: (id, text) => { if (id === 'app-error' && text) errors.push(text); },
    renderLiveTools() {}, updateControls() {}, renderUsage() {}, renderContext() {}, recordLiveTool() {},
    fitComposer() {}, saveSelection() {}, selectedScope: () => ({ childId: 'fixture-user', agentId: 'fixture-soul' }),
    scoped: path => path, newRequestId: () => 'fixture-request',
    fetch: async () => ({}),
    readStream: async (_response, onEvent) => { for (const event of events) onEvent(event); },
    api: async () => ({ session: { id: 'session-test', status: 'open' }, messages: history, context: null, usage: null }),
    refreshSessions: async () => {}, refreshMemory: async () => {},
    setTimeout: resolve => { timers.push(resolve); },
  };
  const api = runInNewContext(nodeSource + messageSource + streamSource +
    '\n({chatMessage, renderChat, appendMessageAttachments, requestReply});', context, { filename: 'public/app.js:reference-images' });
  const queue = () => {
    const { row } = api.chatMessage('user', '看看参考图。');
    ui.messages.append(row);
    state.pendingMessages.push({ message: { text: '看看参考图。' }, row });
  };
  return { ...api, ui, state, timers, errors, queue };
}

test('history places one labeled linked image after assistant text and leaves legacy/user messages unchanged', () => {
  const h = harness();
  h.renderChat([
    { role: 'user', text: '用户消息', attachments: [attachment()] },
    turn('旧记录，没有图片。'),
    turn('有图的回答。', [attachment(), attachment(), attachment({ id: 'reference-2' })]),
  ]);
  assert.equal(h.ui.messages.children.length, 3);
  assert.equal(h.ui.messages.children[0].querySelector('a'), null);
  assert.equal(h.ui.messages.children[1].querySelector('a'), null);
  const stack = h.ui.messages.children[2].querySelector('.message-stack');
  assert.equal(stack.children[0].textContent, '有图的回答。');
  const card = stack.children.at(-1);
  assert.equal(card.tagName, 'A');
  assert.equal(card.href, 'https://www.example.com/article');
  assert.equal(card.target, '_blank'); assert.equal(card.rel, 'noopener noreferrer');
  assert.match(card.attributes['aria-label'], /新标签页打开/);
  assert.match(card.textContent, /来源网页配图/); assert.match(card.textContent, /查看来源/);
  assert.equal(card.dataset.attachmentId, 'reference-1');
  assert.equal(stack.querySelectorAll('.message-reference-image').length, 1);
  const picture = card.querySelector('img');
  assert.equal(picture.src, attachment().imageUrl);
  assert.equal(picture.referrerPolicy, 'no-referrer');
  assert.equal(picture.loading, 'lazy'); assert.equal(picture.decoding, 'async');
  assert.equal(picture.width, 640); assert.equal(picture.height, 480);
  h.appendMessageAttachments(stack, [attachment()]);
  assert.equal(stack.querySelectorAll('.message-reference-image').length, 1, 'same attachment replay stays singular');
});

test('broken images disappear but the original answer and source link remain usable', () => {
  const h = harness();
  const { stack } = h.chatMessage('assistant', '正文保留。', false, undefined,
    [attachment({ title: '<script>这只是标题</script>' })]);
  const card = stack.querySelector('a');
  const picture = card.querySelector('img');
  picture.dispatch('error');
  assert.equal(picture.hidden, true);
  assert.equal(card.href, attachment().sourceUrl);
  assert.match(card.textContent, /图片暂不可用，查看来源/);
  assert.match(stack.textContent, /正文保留/);
  assert.match(card.textContent, /<script>这只是标题<\/script>/);
  assert.equal(card.querySelector('script'), null);
});

test('unsafe or malformed attachments are ignored without interpreting Markdown image text', () => {
  const h = harness();
  const unsafe = ['javascript:alert(1)', 'data:image/png;base64,eA==', 'http://images.example.com/x.jpg',
    'https://localhost/x', 'https://host.local/x', 'https://host.internal/x', 'https://host.lan/x',
    'https://router.home.arpa/x', 'https://127.0.0.1/x', 'https://8.8.8.8/x', 'https://127.1/x',
    'https://2130706433/x', 'https://0x7f000001/x', 'https://[::1]/x', 'https://user:secret@images.example.com/x'];
  for (const imageUrl of unsafe) {
    assert.equal(h.chatMessage('assistant', '正文', false, undefined, [attachment({ imageUrl })]).stack.querySelector('a'), null, imageUrl);
  }
  for (const sourceUrl of ['javascript:alert(1)', 'data:text/html,hello', 'https://127.0.0.1/x', 'https://x.local/x',
    'https://user:secret@www.example.com/x']) {
    assert.equal(h.chatMessage('assistant', '正文', false, undefined, [attachment({ sourceUrl })]).stack.querySelector('a'), null, sourceUrl);
  }
  for (const value of [null, {}, attachment({ id: '' }), attachment({ type: 'image' }), attachment({ title: 7 })]) {
    assert.equal(h.chatMessage('assistant', '正文', false, undefined, [value]).stack.querySelector('a'), null);
  }
  const markdown = '![模型写的图片](https://images.example.com/untrusted.jpg)';
  const message = h.chatMessage('assistant', markdown);
  assert.equal(message.stack.textContent, markdown);
  assert.equal(message.stack.querySelector('img'), null);
  const publicSource = h.chatMessage('assistant', '正文', false, undefined,
    [attachment({ sourceUrl: 'http://www.example.com/article' })]);
  assert.equal(publicSource.stack.querySelector('a').href, 'http://www.example.com/article');
});

test('SSE attachments wait behind animated reply parts and duplicate events do not add cards', async () => {
  const text = '第一句。\n第二句。';
  const h = harness({ motion: true, history: [turn(text, [attachment()])], events: [
    { type: 'start', sessionId: 'session-test' },
    { type: 'reply_part', index: 0, text },
    { type: 'reply_attachment', attachment: attachment() },
    { type: 'reply_attachment', attachment: attachment() },
    { type: 'done' },
  ] });
  h.queue();
  const pending = h.requestReply();
  await new Promise(resolve => setImmediate(resolve));
  const stack = h.ui.messages.children.at(-1).querySelector('.message-stack');
  assert.equal(stack.querySelectorAll('.message-bubble').length, 1);
  assert.equal(stack.querySelector('a'), null, 'image is not shown while the second text bubble waits');
  assert.equal(h.timers.length, 1);
  h.timers.shift()();
  await pending;
  assert.equal(stack.children[0].textContent, '第一句。');
  assert.equal(stack.children[1].textContent, '第二句。');
  assert.equal(stack.children.at(-1).tagName, 'A');
  assert.equal(stack.querySelectorAll('a').length, 1);
  assert.deepEqual(h.errors, []);
});

test('delta-only replay keeps its attachment after the fallback text renderer clears the stack', async () => {
  const h = harness({ history: [turn('已保存的回复。', [attachment()])], events: [
    { type: 'start', sessionId: 'session-test' }, { type: 'delta', text: '已保存的回复。' },
    { type: 'reply_attachment', attachment: attachment() }, { type: 'reply_attachment', attachment: attachment() }, { type: 'done' },
  ] });
  h.queue(); await h.requestReply();
  const stack = h.ui.messages.children.at(-1).querySelector('.message-stack');
  assert.equal(stack.children[0].textContent, '已保存的回复。');
  assert.equal(stack.children.at(-1).tagName, 'A');
  assert.equal(stack.querySelectorAll('a').length, 1);
});

test('persisted history restores attachments after a broken stream or a missing attachment event', async () => {
  for (const failed of [false, true]) {
    const h = harness({ history: [turn('已保存的回复。', [attachment()])], events: [
      { type: 'start', sessionId: 'session-test' }, { type: 'reply_part', index: 0, text: '已保存的回复。' },
      failed ? { type: 'error', message: '模拟连接中断' } : { type: 'done' },
    ] });
    h.queue(); await h.requestReply();
    const stack = h.ui.messages.children.at(-1).querySelector('.message-stack');
    assert.equal(stack.children[0].textContent, '已保存的回复。');
    assert.equal(stack.querySelectorAll('a').length, 1);
    assert.equal(stack.querySelector('a').dataset.attachmentId, 'reference-1');
    assert.equal(h.errors.length, failed ? 1 : 0);
  }
});
