import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotDatabase } from '../lib/telegram/database.mjs';
import { TelegramCore, pendingConversationBridge } from '../lib/telegram/core.mjs';
import { TelegramApi, privateUpdate, splitTelegramText } from '../lib/telegram/platform.mjs';
import { TelegramApp } from '../lib/telegram/app.mjs';
import { createVoiceRecognizer } from '../lib/telegram/asr.mjs';

const update = (id, text, user = 111, extra = {}) => ({ update_id: id,
  message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: user, type: 'private' },
    from: { id: user, first_name: '测试用户', is_bot: false }, text, ...extra } });
const answer = messages => ({ content: JSON.stringify({ messages }), toolCalls: [], receipt: { model: 'mock', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } });
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chatlab-telegram-test-'));
  let count = 0;
  const requests = [];
  const config = { provider: { async chat(request) { count++; requests.push(request); return answer(['在', '第二段\n\n仍是同一条。']); } },
    model: { name: 'mock', configured: true, thinking: 'disabled' },
    memoryModel: { name: 'memory-mock', configured: true }, memoryProvider: { async chat() { throw new Error('memory-test-offline'); } }, ...options.config };
  const db = new BotDatabase(join(dir, 'bot.sqlite'));
  const core = new TelegramCore({ database: db, dataDir: dir, botId: 123456, allowedUsers: ['111', '222'], ...options, config });
  const send = async (text, id, user = 111, extra) => { core.accept(update(id, text, user, extra)); await core.idle(); return db.db.prepare('SELECT body FROM outbox WHERE update_id=? ORDER BY id').all(id).map(r => JSON.parse(r.body)); };
  t.after(async () => { await core.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, core, config, send, requests, count: () => count };
}

test('Telegram rejects groups, bots and forged private identity; handles callback actor', () => {
  const u = update(1, 'hi'); assert.equal(privateUpdate(u).userId, '111');
  for (const altered of [update(1, 'x', 111, { chat: { id: -22, type: 'group' } }), update(1, 'x', 111, { from: { id: 222 } }), update(1, 'x', 111, { from: { id: 111, is_bot: true } })]) assert.equal(privateUpdate(altered), null);
  assert.equal(privateUpdate({ update_id: 2, callback_query: { from: u.message.from, data: '/roles', message: { ...u.message, from: { is_bot: true } } } }).text, '/roles');
});
test('transport keeps paragraphs in one message, splits Unicode only at platform limit', () => {
  assert.deepEqual(splitTelegramText('第一段\n\n第二段'), ['第一段\n\n第二段']);
  const text = '🐊'.repeat(4097); const chunks = splitTelegramText(text);
  assert.equal(chunks.length, 2); assert.equal(Array.from(chunks[0]).length, 4096); assert.equal(chunks.join(''), text);
});
test('uninvited user only receives onboarding/id, cannot claim owner or incur model cost', async t => {
  const f = await fixture(t); const out = await f.send('/start', 1, 333);
  assert.match(out[0].text, /333/); await f.send('你好', 2, 333);
  assert.equal(f.count(), 0); assert.equal(f.core.workspaces.has('333'), false);
});
test('public testing admits users outside the whitelist and still isolates their workspaces', async t => {
  const f = await fixture(t, { publicAccess: true });
  await f.send('我的昵称是小熊', 1, 333);
  await f.send('你好', 2, 444);
  assert.equal(f.count(), 2);
  assert.notEqual(f.core.workspaces.get('333').childId, f.core.workspaces.get('444').childId);
  assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('我的昵称是小熊'));
});
test('public user capacity is a resident-store limit; idle users reopen with their original history', async t => {
  const f = await fixture(t, { publicAccess: true, maxUsers: 1 });
  await f.send('我想学画鲸鱼', 1, 333);
  const first = f.core.workspaces.get('333').childId;
  await f.send('你好', 2, 444);
  assert.equal(f.core.workspaces.size, 1);
  await f.send('刚才那个话题', 3, 333);
  assert.equal(f.core.workspaces.get('333').childId, first);
  assert.ok(JSON.stringify(f.requests.at(-1).messages).includes('我想学画鲸鱼'));
  assert.equal(f.count(), 3);
});
test('turning public access off restores the whitelist without removing public users data', async t => {
  const f = await fixture(t, { publicAccess: true });
  await f.send('我的话要保留', 1, 333); const ws = f.core.workspaces.get('333');
  f.core.publicAccess = false;
  const denied = await f.send('第二句', 2, 333);
  assert.match(denied[0].text, /邀请测试/); assert.equal(f.count(), 1);
  assert.equal(ws.store.sql('SELECT count(*) n FROM messages').get().n, 2);
  await f.send('你好', 3, 111); assert.equal(f.count(), 2);
});
test('maintenance extracts an idle evicted users session without requiring another message', async t => {
  let now = new Date();
  const f = await fixture(t, { publicAccess: true, maxUsers: 1, config: { clock: () => now } });
  await f.send('我明天想学画鲸鱼', 1, 333);
  await f.send('/start', 2, 444);
  assert.equal(f.core.workspaces.has('333'), false);
  now = new Date(now.getTime() + 16 * 60_000);
  f.core.maintain();
  const ws = f.core.workspaces.get('333');
  await ws.runtime.worker;
  assert.equal(ws.store.jobList(ws.childId, ws.state().roleId)[0].status, 'failed');
  assert.equal(ws.store.sessions(ws.childId, ws.state().roleId)[0].status, 'closed');
});
test('public access requires an explicit valid configuration flag', async t => {
  const f = await fixture(t);
  const options = { config: f.config, database: f.db, api: {}, core: f.core };
  assert.equal(new TelegramApp({ ...options, env: {} }).publicAccess, false);
  assert.equal(new TelegramApp({ ...options, env: { TELEGRAM_PUBLIC_ACCESS: '1' } }).publicAccess, true);
  assert.throws(() => new TelegramApp({ ...options, env: { TELEGRAM_PUBLIC_ACCESS: 'yes' } }), /0或1/);
});
test('explicit initialization has four roles, no demo profile or inferred age; data is private', async t => {
  const f = await fixture(t); await f.send('/start', 1);
  const ws = f.core.workspaces.get('111');
  assert.deepEqual(f.core.visible(ws).map(a => a.name).sort(), ['大肥鱼','林小满','林晚晴','鳄鱼爸爸'].sort());
  assert.equal(ws.store.children().length, 1); assert.equal(ws.store.child(ws.childId).age, null);
  assert.equal(statSync(join(f.dir, 'users', '123456', '111.sqlite')).mode & 0o777, 0o600);
});
test('real runtime receives messages contract and thinking disabled; output remains separate and idempotent', async t => {
  const f = await fixture(t); const a = await f.send('你好', 1);
  assert.deepEqual(a.map(m => m.text), ['在', '第二段\n\n仍是同一条。']);
  assert.equal(f.requests[0].thinking, 'disabled'); assert.equal(f.requests[0].responseFormat.type, 'json_object');
  await f.send('你好', 1); assert.equal(f.count(), 1);
  const ws = f.core.workspaces.get('111'); assert.equal(ws.store.sql('SELECT count(*) n FROM messages').get().n, 2);
});
test('user identities and same-name private roles never share workspace or history', async t => {
  const f = await fixture(t);
  await f.send('/create', 1); await f.send('同名角色', 2); await f.send('你是一个简短回复的朋友。', 3);
  await f.send('我的秘密是星星', 4);
  await f.send('/create', 5, 222); await f.send('同名角色', 6, 222); await f.send('你是另一个朋友。', 7, 222); await f.send('你好', 8, 222);
  const [a,b] = ['111','222'].map(id => f.core.workspaces.get(id));
  assert.notEqual(a.state().roleId, b.state().roleId);
  assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('我的秘密是星星'));
  assert.equal(a.store.agentRecord(b.state().roleId), null);
});
test('switching roles retains own sessions and rejects adult roles without explicit age', async t => {
  const f = await fixture(t); await f.send('我叫小石头', 1);
  let out = await f.send('/role 林晚晴', 2); assert.match(out[0].text, /18|成年|年龄/);
  await f.send('/role 大肥鱼', 3); await f.send('鲸鱼你好', 4);
  assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('我叫小石头'));
  await f.send('/role 鳄鱼爸爸', 5); await f.send('还记得刚才吗', 6);
  assert.ok(JSON.stringify(f.requests.at(-1).messages).includes('我叫小石头'));
  await f.send('/profile age 22', 7); out = await f.send('/role 林晚晴', 8); assert.match(out[0].text, /已切换/);
});
test('private create/edit is atomic across update replay; default roles cannot be deleted', async t => {
  const f = await fixture(t); await f.send('/create', 1); await f.send('小伙伴', 2); await f.send('原始设定', 3);
  const ws = f.core.workspaces.get('111'), roleId = ws.state().roleId;
  await f.send('原始设定', 3); assert.equal(f.core.visible(ws).length, 5);
  await f.send('/editrole', 4); await f.send('新的完整设定', 5);
  assert.equal(ws.store.agentRecord(roleId).definition, '新的完整设定'); assert.equal(ws.state().roleId, roleId);
  await f.send('/role 鳄鱼爸爸', 6); const out = await f.send('/deleterole', 7); assert.match(out[0].text, /不能删除/);
});
test('new session queues extraction; failed/pending extraction bridges original history until forget', async t => {
  const f = await fixture(t); await f.send('明天我要去画鲸鱼', 1); const ws = f.core.workspaces.get('111'), roleId = ws.state().roleId;
  await f.send('/new', 2); await ws.runtime.worker;
  assert.equal(ws.store.jobList(ws.childId, roleId)[0].status, 'failed');
  assert.ok(pendingConversationBridge(ws.store, ws.childId, roleId, ws.runtime.now()).some(m => m.text.includes('画鲸鱼')));
  await f.send('你记得我接下来干嘛吗', 3); assert.ok(f.requests.at(-1).messages[0].content.includes('明天我要去画鲸鱼'));
  const confirm = await f.send('/forget', 4); const callback = confirm[0].reply_markup.inline_keyboard[0][0].callback_data;
  await f.send(callback, 5); assert.deepEqual(pendingConversationBridge(ws.store, ws.childId, roleId, ws.runtime.now()), []);
  assert.ok(ws.store.sessions(ws.childId, roleId).length > 0);
  await f.send('重新开始', 6); assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('明天我要去画鲸鱼'));
});
test('memory bridge never crosses role/user scopes or successful extraction', async t => {
  const f = await fixture(t); await f.send('我的私事', 1); await f.send('/new', 2);
  const ws = f.core.workspaces.get('111'); await ws.runtime.worker;
  const roleId = ws.state().roleId;
  assert.deepEqual(pendingConversationBridge(ws.store, 'another', roleId, ws.runtime.now()), []);
  assert.deepEqual(pendingConversationBridge(ws.store, ws.childId, 'another', ws.runtime.now()), []);
  ws.store.sql("UPDATE jobs SET status='succeeded'").run();
  assert.deepEqual(pendingConversationBridge(ws.store, ws.childId, roleId, ws.runtime.now()), []);
});
test('model-result/outbox crash gap recovers from saved run, not another model request', async t => {
  const f = await fixture(t); await f.send('测试断电', 1); const ws = f.core.workspaces.get('111');
  f.db.db.prepare('DELETE FROM outbox').run(); f.db.db.prepare("UPDATE inbox SET state='running',payload=? WHERE id=1").run(JSON.stringify(update(1, '测试断电')));
  f.core.kick('111'); await f.core.idle();
  assert.equal(f.count(), 1); assert.equal(f.db.db.prepare('SELECT count(*) n FROM outbox').get().n, 2);
  assert.equal(ws.store.sql('SELECT count(*) n FROM runs').get().n, 1);
});
test('restart recovers incomplete provider attempts as failed, never silently regenerates', async t => {
  const f = await fixture(t); await f.send('/start', 1); const ws = f.core.workspaces.get('111');
  const u = update(2, '中断的请求'); f.db.accept(u, privateUpdate(u)); f.db.bind(2, ws.state().roleId, '中断的请求');
  ws.runtime.beginChat({ childId: ws.childId, agentId: ws.state().roleId, requestId: 'telegram:123456:2', text: '中断的请求' });
  ws.store.recover(ws.runtime.now()); f.core.kick('111'); await f.core.idle();
  assert.equal(f.count(), 0); assert.equal(ws.store.sql('SELECT status FROM runs').get().status, 'failed');
});
test('outbox preserves order, retries only explicit 429, and does not retry unknown deliveries', async t => {
  const f = await fixture(t); await f.send('你好', 1);
  const one = f.db.claim(); assert.equal(one.body.text, '在'); assert.equal(f.db.claim(), null);
  f.db.receipt({ id: one.id, state: 'unknown' }); const two = f.db.claim(); assert.equal(two.body.text, '第二段\n\n仍是同一条。');
  f.db.receipt({ id: two.id, state: 'pending', retryAfter: 1 }); assert.equal(f.db.claim(), null);
  assert.equal(f.db.claim(Date.now() + 1500).id, two.id);
  f.db.receipt({ id: two.id, state: 'sent', telegramId: 88 }); f.db.receipt({ id: two.id, state: 'unknown' });
  assert.equal(f.db.db.prepare('SELECT state FROM outbox WHERE id=?').get(two.id).state, 'sent');
});
test('voice is persisted then transcribed and confirmed; correction precedes paid chat and role changes cancel pending voice', async t => {
  let asr = 0;
  const f = await fixture(t, { voiceLoader: async () => 'YXVkaW8=', asr: async () => { asr++; return '原识别'; } });
  await f.send('', 1, 111, { voice: { duration: 2, file_id: 'a', file_size: 4 } });
  assert.equal(asr, 1); assert.equal(f.count(), 0);
  const corrected = await f.send('/correct 改正识别', 2); const confirm = corrected[0].reply_markup.inline_keyboard[0][0].callback_data;
  await f.send(confirm, 3); assert.equal(f.count(), 1); assert.ok(JSON.stringify(f.requests[0].messages).includes('改正识别'));
  await f.send(confirm, 3); assert.equal(f.count(), 1);
  const out = await f.send('', 4, 111, { voice: { duration: 2, file_id: 'a' } });
  await f.send('/role 大肥鱼', 5); const expired = await f.send(out[0].reply_markup.inline_keyboard[0][0].callback_data, 6);
  assert.match(expired[0].text, /过期/); assert.equal(f.count(), 1);
});
test('unconfigured ASR, unknown voice attempt and recognition failure never reach chat model', async t => {
  const f = await fixture(t); const out = await f.send('', 1, 111, { voice: { duration: 1, file_id: 'x' } });
  assert.match(out[0].text, /没配置/); assert.equal(f.count(), 0);
  f.core.asr = async () => { throw new Error('offline'); }; f.core.voiceLoader = async () => 'eA==';
  await f.send('', 2, 111, { voice: { duration: 1, file_id: 'x' } }); assert.equal(f.count(), 0);
});
test('daily paid-call limit excludes command handling and stored replay', async t => {
  const f = await fixture(t, { dailyLimit: 1 }); await f.send('一', 1); await f.send('一', 1);
  const out = await f.send('二', 2); assert.match(out[0].text, /额度/); assert.equal(f.count(), 1);
  const status = await f.send('/status', 3); assert.match(status[0].text, /disabled/);
});
test('API errors redact token, download URL and provider error bodies', async () => {
  const token = '123456:' + 'a'.repeat(35);
  const api = new TelegramApi(token, { fetchImpl: async url => { throw new Error(url); } });
  await assert.rejects(api.call('getMe'), error => !error.message.includes(token) && error.unknown === true);
  const denied = new TelegramApi(token, { fetchImpl: async () => ({ status: 401, json: async () => ({ ok: false, error_code: 401, description: token }) }) });
  await assert.rejects(denied.call('getMe'), error => !error.message.includes(token));
});
test('ASR sends audio bytes without Telegram URL and preserves literal speech; empty/error output is rejected', async () => {
  let captured;
  const recognize = createVoiceRecognizer({ TELEGRAM_ASR_API_KEY: 'private' }, async (url, options) => {
    captured = JSON.parse(options.body); return { ok: true, headers: new Headers({ 'X-Api-Status-Code': '20000000' }), json: async () => ({ result: { text: '你好' } }) };
  });
  assert.equal(await recognize('eA=='), '你好'); assert.deepEqual(captured.audio, { data: 'eA==' }); assert.equal(captured.request.enable_ddc, false);
  assert.equal(createVoiceRecognizer({}), null);
  const broken = createVoiceRecognizer({ TELEGRAM_ASR_API_KEY: 'private' }, async () => ({ ok: true, headers: new Headers(), json: async () => ({ result: { text: '' } }) }));
  await assert.rejects(broken('eA=='));
});
test('app refuses pre-existing webhook without deleting it', async t => {
  const f = await fixture(t); const calls = [];
  const api = { async call(method) { calls.push(method); return method === 'getMe' ? { id: 123456 } : { url: 'https://existing.example/hook' }; }, close() {} };
  const app = new TelegramApp({ env: { TELEGRAM_ALLOWED_USER_IDS: '111' }, config: f.config, database: f.db, api, core: f.core });
  await assert.rejects(app.initialize(), /Webhook/); assert.deepEqual(calls, ['getMe','getWebhookInfo']);
});
