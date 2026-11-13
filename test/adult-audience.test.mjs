import { loadSouls } from '../lib/prompts.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLabServer } from '../server.mjs';

test('adult character gates both session creation and direct chat before persisting or calling models', async t => {
  let calls = 0;
  const lab = createLabServer({ souls: loadSouls(), provider: { async chat(options) {
    calls++;
    options.onDelta?.('那我可当真了。');
    return { content: '那我可当真了。', toolCalls: [], receipt: { finish_reason: 'stop' } };
  } } });
  const { port } = await lab.listen(0);
  t.after(() => lab.close());
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(lab.runtime.state().agents.find(a => a.id === 'lin-xiaoman').minimumAge, 18);
  assert.match(lab.runtime.promptDetail('lin-xiaoman').role, /22岁/);
  const minor = lab.store.children()[0];
  const unknown = lab.store.createChild({ name: '年龄未填', age: null, interests: [] }, lab.runtime.now());
  const seventeen = lab.store.createChild({ name: '17岁', age: 17, interests: [] }, lab.runtime.now());
  const adult = lab.store.createChild({ name: '18岁', age: 18, interests: [] }, lab.runtime.now());
  const before = () => Object.fromEntries(['children', 'sessions', 'messages', 'runs'].map(table =>
    [table, lab.store.sql(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const saved = before();
  for (const child of [minor, unknown, seventeen]) {
    const scope = { childId: child.id, agentId: 'lin-xiaoman' };
    for (const path of ['/api/sessions', '/api/chat']) {
      const r = await post(path, { ...scope, text: '你好', requestId: crypto.randomUUID() });
      assert.equal(r.status, 403);
      assert.match((await r.json()).error, /18岁/);
    }
  }
  assert.equal(calls, 0);
  assert.deepEqual(before(), saved, 'blocked requests do not write records or alter age');
  // Existing histories remain readable; the gate controls new interactions.
  const history = await fetch(`http://127.0.0.1:${port}/api/sessions?${new URLSearchParams({ childId: minor.id, agentId: 'lin-xiaoman' })}`);
  assert.equal(history.status, 200);
  const scope = { childId: adult.id, agentId: 'lin-xiaoman' };
  const opened = await post('/api/sessions', scope);
  assert.equal(opened.status, 201);
  const { session } = await opened.json();
  const chat = await post('/api/chat', { ...scope, sessionId: session.id, text: '想你了', requestId: crypto.randomUUID() });
  assert.equal(chat.status, 200);
  assert.match(await chat.text(), /那我可当真了/);
  assert.equal(calls, 1);
  const family = await post('/api/sessions', { childId: minor.id, agentId: 'pinecone-lab' });
  assert.equal(family.status, 201, 'ordinary roles remain available to child profiles');
});
