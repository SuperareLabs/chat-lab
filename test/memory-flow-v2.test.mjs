import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createLabServer } from '../server.mjs';

const empty = () => ({ creates: [], updates: [], mentions: [], retractions: [], overview: null });
const answer = content => ({ content, toolCalls: [], receipt: { finish_reason: 'stop' } });
const invoke = (name, args) => ({ content: '我找找。', toolCalls: [{ id: crypto.randomUUID(), type: 'function',
  function: { name, arguments: JSON.stringify(args) } }], receipt: { finish_reason: 'tool_calls' } });

test('HTTP lifecycle maintains overview, recalls event details, refreshes original IDs, corrects and withdraws overview facts', async t => {
  let instant = new Date('2026-11-12T00:00:00.000Z');
  let extraction = 0;
  const traces = [];
  const provider = { async chat(options) {
    traces.push(structuredClone(options.messages));
    if (options.responseFormat) {
      assert.equal(options.responseFormat.json_schema.name, 'general_chat_memory_v2');
      extraction++;
      const { userMessages: users, memoryIndex } = JSON.parse(options.messages[1].content);
      const last = users.at(-1);
      const src = m => ({ sourceMessageIds: [m.id] });
      const find = term => memoryIndex.find(x => x.summary.includes(term));
      const plan = empty();
      if (extraction === 1) {
        plan.creates = [
          { kind: 'understanding', topics: ['称呼'], summary: '用户希望被称呼为阿澈。', ...src(users[0]) },
          { kind: 'understanding', topics: ['饮品偏好'], summary: '用户喜欢陈皮白茶。', ...src(users[0]) },
          { kind: 'event', topics: ['南京城墙', '姐姐'], summary: '用户2025年10月4日和姐姐在南京城墙走错出口。',
            detail: { occurredAt: '2025-10-04', place: '南京城墙', event: '按姐姐的导航走错出口，最后从玄武门出去。' }, ...src(users[0]) },
        ];
        plan.overview = { summary: '用户希望被称呼为阿澈，喜欢陈皮白茶。', memoryIds: [], createIndexes: [0, 1] };
      } else if (extraction === 2) {
        plan.updates = [{ memoryId: find('陈皮白茶').id, changeType: 'correction',
          summary: '用户已不喝陈皮白茶，饮品偏好改为桂花乌龙。', ...src(last) }];
        plan.mentions = [{ memoryId: find('南京城墙').id, ...src(last) }];
        plan.overview = { summary: '用户希望被称呼为阿澈，饮品偏好已改为桂花乌龙。',
          memoryIds: [find('阿澈').id, find('陈皮白茶').id], createIndexes: [] };
      } else if (extraction === 3) {
        plan.retractions = memoryIndex.filter(x => x.kind === 'understanding')
          .map(x => ({ memoryId: x.id, reason: '用户明确要求忘记称呼与饮品偏好。', ...src(last) }));
        plan.overview = { summary: '', memoryIds: [], createIndexes: [] };
      }
      return answer(JSON.stringify(plan));
    }
    const last = options.messages.at(-1);
    if (last.role === 'tool') {
      const result = JSON.parse(last.content);
      if (result.status === 'matched') return invoke('get_memory_detail', { memoryId: result.items[0].memoryId });
      assert.equal(result.status, 'found');
      assert(result.item.detail.event.includes('玄武门'));
      return answer('找到了，最后是从玄武门出去的。');
    }
    if (last.content === '从旧记忆里找南京城墙那次，再读详情。') return invoke('recall_memory', { query: '南京城墙' });
    return answer('在，咱们接着聊。');
  } };
  const lab = createLabServer({ provider, dbPath: ':memory:', clock: () => new Date(instant) });
  const { port } = await lab.listen(0);
  t.after(() => lab.close());
  const origin = 'http://127.0.0.1:' + port;
  const scope = { childId: lab.runtime.state().children[0].id, agentId: lab.runtime.state().agents[0].id };
  const suffix = '?' + new URLSearchParams(scope);
  const json = async (path, body) => {
    const r = await fetch(origin + path, body === undefined ? undefined : { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(r.ok, path + ' ' + r.status);
    return r.json();
  };
  const open = () => json('/api/sessions', scope);
  const chat = async (sessionId, text) => {
    instant = new Date(instant.getTime() + 60_000);
    const r = await fetch(origin + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, sessionId, text, requestId: crypto.randomUUID() }) });
    assert(r.ok);
    const events = (await r.text()).trim().split('\n\n').map(block => JSON.parse(block.slice(6)));
    assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
    return json('/api/sessions/' + sessionId + suffix);
  };
  const settled = async n => {
    for (let i = 0; i < 100; i++) {
      const data = await json('/api/memory' + suffix);
      const completed = data.jobs.filter(x => x.status === 'succeeded').length;
      assert(!data.jobs.some(x => x.status === 'failed'), JSON.stringify(data.jobs));
      if (completed >= n) return data;
      await pause(5);
    }
    assert.fail('memory job did not complete');
  };

  const first = (await open()).session;
  await chat(first.id, '以后叫我阿澈，我喜欢陈皮白茶。2025年10月4日和姐姐在南京城墙走错出口，最后从玄武门出去。');
  const second = (await open()).session;
  const initial = await settled(1);
  assert.equal(initial.items.length, 3);
  assert(initial.overview.summary.includes('阿澈'));
  assert(!initial.overview.summary.includes('南京城墙'));
  const event = initial.items.find(x => x.kind === 'event');
  const tea = initial.items.find(x => x.summary.includes('陈皮白茶'));
  const greeting = await chat(second.id, '在吗');
  const material = JSON.parse(greeting.context.requestMessages[1].content.split('\n')[1]);
  assert(material.userOverview.includes('阿澈'));
  assert(!greeting.context.requestMessages[1].content.includes('南京城墙'));
  assert.equal(material.recentMemories, undefined);
  const read = await chat(second.id, '从旧记忆里找南京城墙那次，再读详情。');
  assert.deepEqual(read.context.toolCalls.map(x => x.name), ['recall_memory', 'get_memory_detail']);
  assert.equal(lab.store.memoryDetail(event.memoryId, scope.childId, scope.agentId).lastMentionedAt, event.lastMentionedAt,
    'read tools must not perform user-mention writes');
  await chat(second.id, '刚才南京城墙还是那件事。更正一下，我不喝陈皮白茶了，改喝桂花乌龙。');
  const third = (await open()).session;
  const changed = await settled(2);
  assert.equal(changed.items.length, 3, 'same event and corrected preference keep original IDs');
  assert(changed.overview.summary.includes('桂花乌龙'));
  assert(changed.overview.summary.includes('不喝陈皮白茶'));
  assert.equal(changed.items.find(x => x.summary.includes('桂花乌龙')).memoryId, tea.memoryId);
  const refreshed = lab.store.memoryDetail(event.memoryId, scope.childId, scope.agentId);
  assert(Date.parse(refreshed.lastMentionedAt) > Date.parse(event.lastMentionedAt));
  assert.equal(refreshed.detail.occurredAt, '2025-10-04');
  assert(refreshed.mentions.length >= 2);
  const newGreeting = await chat(third.id, '在吗');
  assert(newGreeting.context.userOverview.summary.includes('桂花乌龙'));
  await chat(third.id, '请忘掉阿澈这个称呼，也忘掉我的饮品偏好。');
  const fourth = (await open()).session;
  const withdrawn = await settled(3);
  assert.equal(withdrawn.overview.summary, '');
  assert.equal(withdrawn.counts.retracted, 2);
  assert.equal(lab.store.recall(scope.childId, scope.agentId, { query: '桂花乌龙' }).items.length, 0);
  const after = await chat(fourth.id, '在吗');
  assert.equal(after.context.userOverview.summary, '');
  assert(!after.context.requestMessages[1].content.includes('桂花乌龙'));
  assert.equal(extraction, 3);
  for (const session of [first, second, third]) {
    const calls = lab.store.usage(session.id).calls.filter(call => call.kind === 'memory');
    assert.equal(calls.length, 1, 'each complete memory update uses one extraction request');
    assert.equal(calls[0].name, 'extraction');
  }
  assert(traces.length > 3);
});
