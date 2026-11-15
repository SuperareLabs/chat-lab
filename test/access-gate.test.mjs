import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessGate } from '../lib/access-gate.mjs';

const password = 'test-private-password';
const request = cookie => ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress: '127.0.0.1' } });
const cookieFor = result => result.cookie.split(';')[0];

test('gate checks the server-side password and issues an opaque HttpOnly session', async () => {
  const gate = createAccessGate({ password });
  assert.equal(gate.status(request()).authenticated, false);
  assert.throws(() => gate.require(request()), error => error.status === 401);
  await assert.rejects(gate.login(request(), { password: 'incorrect' }), error => error.status === 401);
  const result = await gate.login(request(), { password });
  assert.equal(result.value.authenticated, true);
  assert.match(result.cookie, /HttpOnly; SameSite=Strict/);
  assert(!result.cookie.includes(password));
  assert(!result.cookie.includes('Secure'));
  const browser = request(cookieFor(result));
  assert.doesNotThrow(() => gate.require(browser));
  assert.equal(gate.status(browser).storageMode, 'browser');
  assert.throws(() => gate.require(request(cookieFor(result) + 'x')), error => error.status === 401);
  assert.throws(() => gate.require(request(cookieFor(result) + '; ' + cookieFor(result))), error => error.status === 401);
});

test('logout revokes the cookie and expiry and server restart require login again', async () => {
  let now = 1000;
  const gate = createAccessGate({ password, clock: () => now, ttlMs: 2000 });
  const a = await gate.login(request(), { password }, { secure: true });
  const b = await gate.login(request(), { password });
  assert.match(a.cookie, /; Secure$/);
  assert.notEqual(cookieFor(a), cookieFor(b));
  const logout = gate.logout(request(cookieFor(a)), { secure: true });
  assert.match(logout.cookie, /Max-Age=0; Secure$/);
  assert.equal(gate.status(request(cookieFor(a))).authenticated, false);
  assert.equal(gate.status(request(cookieFor(b))).authenticated, true);
  now += 2001;
  assert.equal(gate.status(request(cookieFor(b))).authenticated, false);
  const c = await gate.login(request(), { password });
  gate.close();
  assert.equal(gate.status(request(cookieFor(c))).authenticated, false);
});

test('failed attempts are bounded and invalid login fields never become credentials', async () => {
  let now = 0;
  const gate = createAccessGate({ password, clock: () => now, maxAttempts: 2, attemptWindowMs: 1000 });
  await assert.rejects(gate.login(request(), { password, metadata: {} }), error => error.status === 400);
  for (let i = 0; i < 2; i++) await assert.rejects(gate.login(request(), { password: 'wrong' }), error => error.status === 401);
  await assert.rejects(gate.login(request(), { password }), error => error.status === 429);
  now = 1001;
  assert.equal((await gate.login(request(), { password })).value.authenticated, true);
  assert.throws(() => createAccessGate({ password: '' }), /CHAT_ACCESS_PASSWORD/);
});
