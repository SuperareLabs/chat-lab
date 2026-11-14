import assert from 'node:assert/strict';
import test from 'node:test';
import { installMotionIntro } from '../public/motion-ui.js';

class Events {
  listeners = new Map();
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  fire(type, options = {}) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    return event;
  }
}
class Element extends Events {
  constructor(tag, doc) { super(); Object.assign(this, { tag, doc, dataset: {}, attributes: new Map(), children: [], open: false, isConnected: false }); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(child) { this.children.push(child); child.parent = this; child.isConnected = true; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.isConnected = false; }
  set innerHTML(value) {
    this.content = value;
    this.skip = new Element('button', this.doc);
    this.subtitle = new Element('p', this.doc);
  }
  querySelector(selector) { return selector === '.lab-intro-skip' ? this.skip : selector === '.lab-intro-subtitle' ? this.subtitle : null; }
  showModal() { if (this.doc.modalError) throw new Error('dialog failed'); this.open = true; this.doc.activeElement = this.skip; }
  close() { this.open = false; this.fire('close'); }
  focus() { this.doc.activeElement = this; }
}
function harness({ reduced = false, seen = false, blockedStorage = false, cssLoaded = true, hidden = false, modalError = false } = {}) {
  const doc = new Events();
  Object.assign(doc, { hidden, modalError });
  doc.documentElement = new Element('html', doc);
  doc.body = new Element('body', doc);
  doc.activeElement = doc.body;
  const replay = new Element('button', doc); replay.isConnected = true;
  doc.getElementById = id => id === 'intro-replay' ? replay : null;
  doc.querySelector = selector => selector === 'dialog[open]' ? doc.body.children.find(n => n.tag === 'dialog' && n.open) ?? null : null;
  doc.createElement = tag => new Element(tag, doc);
  const win = new Events();
  const media = new Events(); media.matches = reduced;
  win.matchMedia = () => media;
  const values = new Map(seen ? [['chat-lab:opening:v1', '1']] : []);
  Object.defineProperty(win, 'sessionStorage', { get() {
    if (blockedStorage) throw new Error('storage denied');
    return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  } });
  win.getComputedStyle = () => ({ getPropertyValue: () => cssLoaded ? '1' : '' });
  let time = 0, nextId = 0;
  const timers = new Map();
  win.setTimeout = (handler, after) => { const id = ++nextId; timers.set(id, { handler, at: time + after }); return id; };
  win.clearTimeout = id => timers.delete(id);
  const advance = delta => {
    const end = time + delta;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].handler();
    }
    time = end;
  };
  const controller = installMotionIntro({ doc, win });
  return { doc, win, replay, media, values, timers, advance, controller, opening: () => doc.body.children.find(n => n.tag === 'dialog') };
}

test('the first visit draws an optional opening and releases dialog modality on a bounded timer', () => {
  const h = harness();
  assert.equal(h.opening().open, true);
  assert.match(h.opening().content, /对话，/);
  assert.equal(h.values.get('chat-lab:opening:v1'), '1');
  h.win.fire('pageshow', { persisted: false });
  assert.equal(h.opening().open, true, 'the normal initial pageshow must not cancel the entrance');
  h.advance(1150);
  assert.equal(h.opening().dataset.state, 'leaving');
  h.advance(350);
  assert.equal(h.opening(), undefined);
  assert.equal(h.doc.documentElement.attributes.has('data-lab-enter'), true);
  h.advance(720);
  assert.equal(h.doc.documentElement.attributes.has('data-lab-enter'), false);
  assert.equal(h.timers.size, 0, 'all presentation timers are cleaned after the final state');
  h.controller.destroy();
});

test('repeat visits do not play an opening, while replay is deliberate and restores keyboard focus', () => {
  const h = harness({ seen: true });
  assert.equal(h.opening(), undefined);
  h.replay.focus();
  h.replay.fire('click');
  assert.equal(h.opening().open, true);
  assert.equal(h.controller.play({ manual: true }), false, 'cannot open duplicate dialogs');
  h.opening().skip.fire('click');
  assert.equal(h.opening(), undefined);
  assert.equal(h.doc.activeElement, h.replay);
  h.advance(2000);
  assert.equal(h.timers.size, 0);
  h.controller.destroy();
});

test('skip button and native Escape cancel release the application immediately without animation events', () => {
  for (const kind of ['skip', 'escape']) {
    const h = harness();
    const dialog = h.opening();
    if (kind === 'skip') dialog.skip.fire('click');
    else assert.equal(dialog.fire('cancel').defaultPrevented, true);
    assert.equal(h.opening(), undefined, kind);
    assert.equal(dialog.open, false, kind);
    assert.equal(dialog.listeners.get('cancel').size, 0, 'per-opening listeners are released');
    h.advance(3000);
    assert.equal(h.opening(), undefined);
    assert.equal(h.timers.size, 0);
    h.controller.destroy();
  }
});

test('reduced motion never automatically blocks the page and a manual replay is static and short', () => {
  const h = harness({ reduced: true });
  assert.equal(h.opening(), undefined);
  assert.equal(h.doc.documentElement.attributes.has('data-lab-enter'), false);
  h.replay.fire('click');
  assert.equal(h.opening().dataset.motion, 'reduced');
  h.advance(200);
  assert.equal(h.opening(), undefined);
  assert.equal(h.timers.size, 0);
  h.controller.destroy();
});

test('blocked storage, unavailable styles, unsupported modal opening and showModal errors fail open', () => {
  const blocked = harness({ blockedStorage: true });
  blocked.advance(3000);
  assert.equal(blocked.opening(), undefined);
  assert.equal(blocked.timers.size, 0);
  blocked.controller.destroy();
  for (const options of [{ cssLoaded: false }, { modalError: true }]) {
    const h = harness(options);
    assert.equal(h.opening(), undefined);
    h.advance(3000);
    assert.equal(h.timers.size, 0);
    h.controller.destroy();
  }
  const h = harness({ seen: true });
  h.doc.createElement = tag => { const node = new Element(tag, h.doc); node.showModal = undefined; return node; };
  assert.equal(h.controller.play({ manual: true }), false);
  assert.equal(h.opening(), undefined);
  h.controller.destroy();
});

test('hidden pages, BFCache restoration and a changed motion preference cannot leave a blocking dialog', () => {
  for (const event of ['visibility', 'pageshow', 'pagehide', 'motion']) {
    const h = harness();
    if (event === 'visibility') { h.doc.hidden = true; h.doc.fire('visibilitychange'); }
    if (event === 'pageshow') h.win.fire('pageshow', { persisted: true });
    if (event === 'pagehide') h.win.fire('pagehide');
    if (event === 'motion') { h.media.matches = true; h.media.fire('change'); }
    assert.equal(h.opening(), undefined, event);
    assert.equal(h.doc.documentElement.attributes.has('data-lab-enter'), false, event);
    assert.equal(h.timers.size, 0, event);
    h.controller.destroy();
  }
});

test('destroy removes presentation handlers, timers and active dialogs without touching application data', () => {
  const h = harness();
  h.controller.destroy();
  assert.equal(h.opening(), undefined);
  assert.equal(h.timers.size, 0);
  assert.equal(h.replay.listeners.get('click').size, 0);
  assert.equal(h.doc.listeners.get('visibilitychange').size, 0);
  assert.equal(h.win.listeners.get('pageshow').size, 0);
  assert.equal(h.win.listeners.get('pagehide').size, 0);
  h.replay.fire('click');
  assert.equal(h.opening(), undefined);
  assert.equal(h.controller.play(), false);
});
