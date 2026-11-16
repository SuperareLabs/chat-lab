import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLabServer } from '../server.mjs';

const password = 'public-test-password';
async function fixture(t, overrides = {}) {
  let calls = 0;
  const directory = await mkdtemp(join(tmpdir(), 'public-chat-test-'));
  const dbPath = join(directory, 'never-created', 'private.sqlite');
  const lab = createLabServer({ storageMode: 'browser', accessPassword: password, dbPath,
    defaultAgents: [{ id: 'public-guide', name: '公开搭子', definition: '自然聊天。', metadata: {} }],
    defaultChildren: [{ name: '访客', age: null, interests: [] }],
    provider: { async chat({ onDelta }) { calls++; onDelta?.('听见了。'); return { content: '听见了。', toolCalls: [],
      receipt: { model: 'test', finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } }; } },
    memoryModel: { name: 'disabled', configured: false }, ...overrides });
  const { port } = await lab.listen(0);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    // Node fetch may normalize the Host header. Use a raw HTTP request when
    // testing the actual reverse-proxy Host boundary rather than the fetch API.
    if (Object.hasOwn(headers, 'Host')) return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ hostname: '127.0.0.1', port, path, method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}), ...headers } }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode,
          headers: { get: key => {
            const value = incoming.headers[key.toLowerCase()];
            return Array.isArray(value) ? value.join('; ') : value ?? null;
          } },
          json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      outgoing.on('error', reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response;
  };
  const login = async (headers = {}) => {
    const response = await request('/api/auth/login', { method: 'POST', body: { password }, headers });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  return { lab, request, login, dbPath, calls: () => calls };
}

test('the public server defaults to an adult visitor test profile', async t => {
  const f = await fixture(t, { defaultChildren: undefined });
  const cookie = await f.login();
  const result = await (await f.request('/api/local', { method: 'POST', cookie, body: { method: 'GET', path: '/api/state' } })).json();
  assert.equal(result.value.children.length, 1);
  assert.equal(result.value.children[0].name, '访客');
  assert.equal(result.value.children[0].age, 22);
  assert.equal(f.calls(), 0);
});

test('public APIs all require login and cannot fall back to the server-owned database', async t => {
  const f = await fixture(t);
  assert.equal(f.lab.runtime, null); assert.equal(f.lab.store, null);
  for (const path of ['/api/state', '/api/agents', '/api/children', '/api/sessions', '/api/memory', '/api/chat', '/api/local', '/api/unknown']) {
    for (const method of ['GET', 'POST', 'PATCH']) {
      const response = await f.request(path, { method }); assert.equal(response.status, 401, `${method} ${path}`);
    }
  }
  const initial = await (await f.request('/api/auth/session')).json();
  assert.deepEqual(initial, { authenticated: false, passwordRequired: true, storageMode: 'browser' });
  const wrong = await f.request('/api/auth/login', { method: 'POST', body: { password: 'wrong' } }); assert.equal(wrong.status, 401);
  const cookie = await f.login();
  assert.equal((await f.request('/api/state', { cookie })).status, 404);
  assert.equal((await f.request('/api/memory', { cookie })).status, 404);
  const a = await (await f.request('/api/local', { method: 'POST', cookie, body: { method: 'GET', path: '/api/state' } })).json();
  const b = await (await f.request('/api/local', { method: 'POST', cookie, body: { method: 'GET', path: '/api/state' } })).json();
  assert.equal(a.value.children[0].name, '访客');
  assert.notEqual(a.value.children[0].id, b.value.children[0].id);
  assert.equal(a.snapshot.tables.messages.length, 0);
  assert.equal(f.calls(), 0); assert.equal(existsSync(f.dbPath), false);
  const loggedOut = await f.request('/api/auth/logout', { method: 'POST', cookie }); assert.equal(loggedOut.status, 200);
  assert.equal((await f.request('/api/local', { method: 'POST', cookie, body: { method: 'GET', path: '/api/state' } })).status, 401);
});

test('SSE ends with the browser workspace and no server user file is written', async t => {
  const f = await fixture(t); const cookie = await f.login();
  const bootstrap = await (await f.request('/api/local', { method: 'POST', cookie,
    body: { method: 'GET', path: '/api/state' } })).json();
  const scope = { childId: bootstrap.value.children[0].id, agentId: bootstrap.value.agents[0].id };
  const response = await f.request('/api/local', { method: 'POST', cookie, body: {
    method: 'POST', path: '/api/chat', snapshot: bootstrap.snapshot, scope,
    body: { ...scope, text: '仅我的浏览器消息', requestId: 'one-private-request' },
  } });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
  assert(events.some(event => event.type === 'done'));
  assert.equal(events.at(-1).type, 'workspace');
  assert(events.at(-1).snapshot.tables.messages.some(row => row.text === '仅我的浏览器消息'));
  assert.equal(f.calls(), 1); assert.equal(existsSync(f.dbPath), false);
});

test('external origins are explicit and forwarded headers cannot bypass host or CSRF checks', async t => {
  const f = await fixture(t, { publicOrigins: ['https://chat.example.test'] });
  const hostile = await f.request('/api/auth/login', { method: 'POST', body: { password },
    headers: { Origin: 'https://evil.example.test' } }); assert.equal(hostile.status, 403);
  const spoofed = await f.request('/api/auth/session', { headers: { Host: 'evil.example.test',
    'X-Forwarded-Host': 'chat.example.test', 'X-Forwarded-Proto': 'https' } }); assert.equal(spoofed.status, 403);
  const response = await f.request('/api/auth/login', { method: 'POST', body: { password },
    headers: { Host: 'chat.example.test', Origin: 'https://chat.example.test' } });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure$/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert(!response.headers.get('set-cookie').includes(password));
  const defaultPort = await f.request('/api/auth/session', { headers: { Host: 'chat.example.test:443', Origin: 'https://chat.example.test' } });
  assert.equal(defaultPort.status, 200, 'default HTTPS port in a legitimate proxy Host is normalized');
});

test('public catalog is shared across entrance sessions but mutation belongs to the creating browser', async t => {
  const f = await fixture(t);
  const firstKey = 'c'.repeat(64), secondKey = 'd'.repeat(64);
  assert.equal((await f.request('/api/catalog')).status, 401);
  assert.equal((await f.request('/api/catalog/agents', { method: 'POST', body: {} })).status, 401);
  const firstCookie = await f.login(), secondCookie = await f.login();
  const firstHeaders = { 'X-Chat-Lab-Owner': firstKey }, secondHeaders = { 'X-Chat-Lab-Owner': secondKey };
  const initial = await (await f.request('/api/catalog', { cookie: secondCookie })).json();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.defaultAgentIds, ['public-guide']);
  const createBody = { name: '大家的角色', definition: ' 按眼前的话自然回应。\n', requestId: 'shared-create-1' };
  const deniedOrigin = await f.request('/api/catalog/agents', { cookie: firstCookie, method: 'POST', body: createBody,
    headers: { ...firstHeaders, Origin: 'https://evil.example.test' } });
  assert.equal(deniedOrigin.status, 403);
  const createdResponse = await f.request('/api/catalog/agents', { cookie: firstCookie, method: 'POST', body: createBody, headers: firstHeaders });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json(), id = created.agent.id;
  const again = await (await f.request('/api/catalog/agents', { cookie: firstCookie, method: 'POST', body: createBody, headers: firstHeaders })).json();
  assert.equal(again.agent.id, id);
  const visible = await (await f.request('/api/catalog', { cookie: secondCookie, headers: secondHeaders })).json();
  assert.equal(visible.agents[0].id, id);
  assert.equal(visible.agents[0].canManage, false);
  assert(!JSON.stringify(visible).includes(firstKey));
  assert.equal((await (await f.request('/api/catalog', { cookie: firstCookie, headers: firstHeaders })).json()).agents[0].canManage, true);
  const unchanged = await (await f.request('/api/catalog?revision=1', { cookie: secondCookie, headers: secondHeaders })).json();
  assert.deepEqual(unchanged, { revision: 1, unchanged: true });
  for (const query of ['?revision=-1', '?revision=x', '?revision=9007199254740992', '?revision=1&revision=1', '?unknown=1']) {
    assert.equal((await f.request('/api/catalog' + query, { cookie: secondCookie })).status, 400, query);
  }
  const edit = { name: '新版角色', definition: '新的设定。', revision: 1 };
  assert.equal((await f.request('/api/catalog/agents/' + id, { cookie: secondCookie, method: 'PATCH', body: edit, headers: secondHeaders })).status, 403);
  assert.equal((await f.request('/api/catalog/agents/' + id, { cookie: secondCookie, method: 'DELETE', body: { revision: 1 }, headers: secondHeaders })).status, 403);
  assert.equal((await f.request('/api/catalog/agents/' + id, { cookie: firstCookie, method: 'PATCH', body: edit, headers: firstHeaders })).status, 200);
  assert.equal((await f.request('/api/catalog/agents/' + id, { cookie: firstCookie, method: 'DELETE', body: { revision: 1 }, headers: firstHeaders })).status, 409);
  assert.equal((await f.request('/api/catalog/agents/' + id, { cookie: firstCookie, method: 'DELETE', body: { revision: 2 }, headers: firstHeaders })).status, 200);
  assert.equal((await f.request('/api/catalog/agents/' + id, { cookie: firstCookie, method: 'DELETE', body: { revision: 2 }, headers: firstHeaders })).status, 200);
  const retired = await (await f.request('/api/catalog?revision=1', { cookie: secondCookie })).json();
  assert.equal(retired.revision, 3);
  assert.deepEqual(retired.agents, []);
  assert.deepEqual(retired.deletedIds, [id]);
  assert.equal(f.calls(), 0);
  assert.equal(existsSync(f.dbPath), false);
});
