import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const refreshCode = source.slice(source.indexOf('let refreshingLocal = false;'), source.indexOf('\nconst guideSteps ='));
const clone = value => structuredClone(value);

function fixture() {
  const conversation = { messages: [{ id: 'm1', role: 'user', text: '合成消息' }], context: { model: 'mock' }, usage: { total: 1 } };
  const data = { agents: [{ id: 'a' }], children: [{ id: 'u' }], model: { configured: true }, dataVersion: 'v' };
  const sessions = [{ id: 's1', status: 'open' }];
  const state = { ...clone(data), agentId: 'a', childId: 'u', sessionId: 's1', sessions: clone(sessions), conversation: clone(conversation),
    authenticated: true, scopeVersion: 1, sessionVersion: 1, pendingMessages: [], memoryFilter: 'archived', memoryOpen: new Set(['one']) };
  const input = { value: '还没发出的草稿', selectionStart: 3, selectionEnd: 3 };
  const calls = { chat: [], context: 0, usage: 0, selectors: 0, reset: 0, memory: 0, errors: [] };
  const f = { data, state, sessions, conversation, input, calls };
  f.fetch = async path => path === '/api/state' ? clone(data) : path === '/api/sessions' ? { sessions: clone(f.sessions) } : clone(f.conversation);
  f.refresh = runInNewContext(`${refreshCode}\nrefreshLocalView`, {
    state, workspaceClient: {}, pendingEntry: null, document: { hidden: false },
    api: path => f.fetch(path), scoped: path => path, el: () => ({ open: false }),
    ui: { 'chat-input': input }, syncAgentGalleryRoute: { refresh() {} },
    renderChat: (...args) => calls.chat.push(args), renderContext: () => calls.context++, renderUsage: () => calls.usage++,
    renderSelectors: () => calls.selectors++, saveSelection() {}, updateControls() {},
    refreshMemory: async () => calls.memory++, show: (_id, message) => calls.errors.push(message), offerRecovery() {},
    runAction: async fn => { calls.reset++; return fn(); }, loadState: async () => { throw new Error('unexpected full reload'); },
    clearTimeout() {}, setTimeout: () => 1,
  });
  return f;
}

test('background notifications with unchanged content never clear and reload the conversation or composer', async () => {
  const f = fixture(), open = f.state.memoryOpen;
  await f.refresh(); await f.refresh();
  assert.equal(f.calls.reset, 0);
  assert.equal(f.calls.chat.length, 0);
  assert.equal(f.calls.context, 0);
  assert.equal(f.calls.usage, 0);
  assert.equal(f.calls.selectors, 0);
  assert.equal(f.input.value, '还没发出的草稿');
  assert.equal(f.input.selectionStart, 3);
  assert.equal(f.state.memoryFilter, 'archived');
  assert.equal(f.state.memoryOpen, open);
  assert.deepEqual(f.calls.errors, []);
});

test('another tab adding a conversation does not steal selection and real new messages preserve the viewport', async () => {
  const f = fixture();
  f.sessions.unshift({ id: 'another-tabs-session', status: 'open' });
  f.conversation.messages.push({ id: 'm2', role: 'assistant', text: '合成回复' });
  await f.refresh();
  assert.equal(f.state.sessionId, 's1');
  assert.equal(f.calls.chat.length, 1);
  assert.equal(f.calls.chat[0][0].length, 2);
  assert.equal(f.calls.chat[0][2].preserveScroll, true);
  assert.equal(f.calls.reset, 0);
  assert.equal(f.input.value, '还没发出的草稿');
  await f.refresh();
  assert.equal(f.calls.chat.length, 1, 'the same messages do not replay arrival or loading UI');
});

test('a background read finishing after the user starts sending cannot replace the live conversation', async () => {
  const f = fixture();
  let finish;
  f.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = f.refresh();
  f.state.sending = true; f.input.value = '新输入';
  finish(clone(f.data)); await pending;
  assert.equal(f.calls.chat.length, 0);
  assert.equal(f.calls.reset, 0);
  assert.equal(f.input.value, '新输入');
});
