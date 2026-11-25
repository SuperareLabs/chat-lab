import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const statusCode = source.slice(source.indexOf('function cancelSessionStatus()'), source.indexOf('\nasync function openSession('));

test('the deadline checks the current server status before greying history cards', async () => {
  const cards = [{ id: 'card', state: 'available' }, { id: 'visited', state: 'visited' }];
  const state = {
    authenticated: true, sessionId: 's1', pendingMessages: [],
    conversation: { session: { id: 's1', status: 'open' }, mentorCards: cards },
    sessions: [{ id: 's1', status: 'open' }],
  };
  const queries = [], timers = [], changes = [];
  const responses = [
    { sessionId: 's1', status: 'open', serverNow: '2026-11-24T10:14:00Z', expiresAt: '2026-11-24T10:15:00Z' },
    { sessionId: 's1', status: 'open', serverNow: '2026-11-24T10:15:00Z', expiresAt: '2026-11-24T10:29:30Z' },
    { sessionId: 's1', status: 'closed', serverNow: '2026-11-24T10:29:30Z', expiresAt: '2026-11-24T10:29:30Z' },
  ];
  const refresh = runInNewContext(`let sessionStatusTimer, sessionStatusRequest = 0;\n${statusCode}\nrefreshSessionStatus`, {
    state, document: { hidden: false }, scoped: path => `${path}?childId=kid&agentId=mentor`,
    workspaceClient: { api: async (...args) => { queries.push(args); return responses.shift(); } },
    clearTimeout() {}, setTimeout: (fire, delay) => { timers.push({ fire, delay }); return timers.length; },
    renderSelectors() {}, updateControls() {},
    applyMentorCardState: (id, status) => {
      changes.push({ id, status });
      cards.find(card => card.id === id).state = status;
    },
  });

  await refresh();
  assert.equal(queries[0][0], '/api/sessions/s1/status?childId=kid&agentId=mentor');
  assert.equal(queries[0][2], 'GET');
  assert.equal(queries[0][3].force, true);
  assert.equal(timers[0].delay, 60_000);
  assert.deepEqual(changes, []);
  await timers[0].fire();
  assert.equal(timers[1].delay, 870_000);
  assert.deepEqual(changes, [], 'a renewed server session keeps its available card');
  await timers[1].fire();
  assert.equal(state.conversation.session.status, 'closed');
  assert.equal(state.sessions[0].status, 'closed');
  assert.deepEqual(changes, [{ id: 'card', status: 'expired' }]);
  assert.equal(cards[1].state, 'visited');
  assert.equal(timers.length, 2);
});
