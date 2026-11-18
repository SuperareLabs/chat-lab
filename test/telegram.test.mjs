import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotDatabase } from '../lib/telegram/database.mjs';
import { TelegramCore } from '../lib/telegram/core.mjs';
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
  const ready = user => { if (options.requireOnboarding || !core.canUse(String(user))) return; const ws = core.workspace({ userId: String(user), displayName: '测试用户' }); ws.save({ ...ws.state(), onboardingComplete: true }); };
  if (!options.requireOnboarding) for (const id of core.allowed) ready(id);
  const send = async (text, id, user = 111, extra) => { ready(user); core.accept(update(id, text, user, extra)); await core.idle(); return db.db.prepare('SELECT body FROM outbox WHERE update_id=? ORDER BY id').all(id).map(r => JSON.parse(r.body)); };
  const click = async (data, id, user = 111) => { ready(user); core.accept({ update_id: id, callback_query: { id: 'callback-' + id, data,
    from: { id: user, first_name: '测试用户' }, message: { message_id: id, chat: { id: user, type: 'private' }, from: { is_bot: true }, date: Math.floor(Date.now()/1000) } } });
    await core.idle(); return db.db.prepare('SELECT body FROM outbox WHERE update_id=? ORDER BY id').all(id).map(r => JSON.parse(r.body)); };
  t.after(async () => { await core.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, core, config, send, click, requests, count: () => count };
}

test('first use requires a profile and role, with button callbacks and no setup conversation sent to the model', async t => {
  const f = await fixture(t, { requireOnboarding: true });
  const welcome = await f.send('/start', 1);
  assert.match(welcome[0].text, /先建.*资料/);
  await f.click(welcome[0].reply_markup.inline_keyboard[0][0].callback_data, 2);
  await f.send('小桐', 3); await f.click('/setup enter_age', 4); const picker = await f.send('10', 5);
  assert.equal(f.count(), 0);
  const target = picker[0].reply_markup.inline_keyboard.flat().find(b => b.text.includes('鳄鱼爸爸'));
  const done = await f.click(target.callback_data, 6);
  assert.deepEqual(done[0].reply_markup, { remove_keyboard: true });
  const ws = f.core.workspaces.get('111');
  assert.equal(ws.state().onboardingComplete, true); assert.equal(ws.store.child(ws.childId).name, '小桐'); assert.equal(ws.store.child(ws.childId).age, 10);
  await f.send('你好', 7); assert.equal(f.count(), 1);
  assert.equal(ws.store.sql('SELECT count(*) n FROM messages').get().n, 2);
  assert.ok(!JSON.stringify(f.requests[0].messages).includes('怎么称呼你'));
});
test('first voice does not incur recognition or chat before setup; optional age does not unlock adult roles', async t => {
  let recognitions = 0;
  const f = await fixture(t, { requireOnboarding: true, voiceLoader: async () => 'eA==', asr: async () => { recognitions++; return '你好'; } });
  await f.send('', 1, 111, { voice: { duration: 1, file_id: 'x' } });
  assert.equal(recognitions, 0); assert.equal(f.count(), 0);
  await f.click('/setup create', 2); await f.click('/setup use_name', 3); const picker = await f.click('/setup skip_age', 4);
  const lin = picker[0].reply_markup.inline_keyboard.flat().find(b => b.text.includes('林晚晴'));
  const blocked = await f.click(lin.callback_data, 5); assert.match(blocked[0].text, /成年人/);
  assert.equal(f.core.workspaces.get('111').state().onboardingComplete, false);
});
test('profile buttons change name and age without replacing identity or losing history; cancel is a button', async t => {
  const f = await fixture(t); await f.send('我想画鲸鱼', 1);
  const ws = f.core.workspaces.get('111'), profileId = ws.childId;
  const card = await f.send('👤 我的资料', 2); assert.ok(card[0].reply_markup.inline_keyboard);
  await f.click('/useredit name', 3); await f.send('改过的称呼', 4);
  await f.click('/useredit age', 5); await f.send('22', 6);
  assert.equal(ws.childId, profileId); assert.equal(ws.store.child(profileId).name, '改过的称呼'); assert.equal(ws.store.child(profileId).age, 22);
  await f.click('/useredit name', 7); await f.click('/cancel', 8);
  assert.equal(ws.state().draft, undefined); await f.send('接着说刚才的', 9);
  assert.equal(f.count(), 2); assert.ok(JSON.stringify(f.requests.at(-1).messages).includes('我想画鲸鱼'));
});
test('old used workspaces are recognized as already onboarded after upgrade', async t => {
  const f = await fixture(t); await f.send('旧对话', 1);
  const ws = f.core.workspaces.get('111'), old = ws.state(); delete old.onboardingComplete; ws.save(old);
  await ws.runtime.stop(); ws.store.close(); f.core.workspaces.delete('111');
  const reopened = f.core.workspace({ userId: '111', displayName: '测试用户' });
  assert.equal(reopened.state().onboardingComplete, true);
  assert.equal(reopened.childId, ws.childId);
});

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
  assert.deepEqual(f.core.visible(ws).map(a => a.name).sort(), ['大肥鱼','苏清月','林晚晴','鳄鱼爸爸'].sort());
  assert.equal(ws.store.agentRecord('lin-xiaoman').name, '苏清月');
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
test('normal chat and home/role replies remove the legacy six-button keyboard instead of recreating it', async t => {
  const f=await fixture(t);
  for(const [index,text] of ['你好','/start','/role 大肥鱼'].entries()) {
    const out=await f.send(text,index+1);
    assert.equal(out[0].reply_markup.remove_keyboard,true);
    assert.ok(out.every(message=>!message.reply_markup?.keyboard));
  }
  const home=await f.send('/start',4);assert.match(home[0].text,/左下角菜单/);
  const picker=await f.send('/roles',5);assert.ok(picker[0].reply_markup.inline_keyboard);
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
test('a failed extraction stays visible without putting old text back into a new chat', async t => {
  const f = await fixture(t); await f.send('明天我要去画鲸鱼', 1); const ws = f.core.workspaces.get('111'), roleId = ws.state().roleId;
  await f.send('/new', 2); await ws.runtime.worker;
  assert.equal(ws.store.jobList(ws.childId, roleId)[0].status, 'failed');
  await f.send('我们刚才聊了啥', 3);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /明天我要去画鲸鱼/);
  const memory = await f.send('/memory', 4);
  assert.match(memory[0].text, /暂无已整理的经历与计划/);
  assert.match(memory[0].text, /整理任务：failed/);
  const history = await f.send('/history', 5);
  assert.match(history[0].text, /明天我要去画鲸鱼/);
});
test('chat and memory menu use the same latest three event summaries with role and user isolation', async t => {
  let now = new Date();
  const background = input => JSON.parse(input.messages[1].content.split('\n')[1]);
  const f = await fixture(t, { config: { clock: () => now, memoryProvider: { async chat({ messages }) {
    const { userMessages, memoryIndex } = JSON.parse(messages[1].content);
    const creates = [], mentions = [];
    for (const message of userMessages) {
      const [action, summary] = message.text.split('|');
      const sourceMessageIds = [message.id];
      if (action === '记录') creates.push({ kind: 'event', summary, topics: [summary], sourceMessageIds,
        detail: { notes: '详细说明只留在记忆库' } });
      if (action === '再提') mentions.push({ memoryId: memoryIndex.find(item => item.summary === summary).id, sourceMessageIds });
    }
    return { content: JSON.stringify({ creates, updates: [], mentions, retractions: [], overview: null }) };
  } } } });
  const ws = f.core.workspaces.get('111'), roleId = ws.state().roleId;
  let updateId = 0;
  for (const summary of ['画鲸鱼', '周末出门', '继续搭塔', '聊了 AI 查资料的用法']) {
    await f.send(`记录|${summary}|旧会话原话`, ++updateId);
    now = new Date(now.getTime() + 60_000);
  }
  await f.send('/new', ++updateId);
  await ws.runtime.worker;
  await f.send('再提|画鲸鱼', ++updateId);
  await f.send('/new', ++updateId);
  await ws.runtime.worker;
  await f.send('你好', ++updateId);
  const input = f.requests.at(-1);
  const expected = ['画鲸鱼', '聊了 AI 查资料的用法', '继续搭塔'];
  assert.deepEqual(background(input).recentEvents.map(item => item.summary), expected);
  assert.match(input.messages[0].content, /不要从这些摘要里挑旧事来开话题/);
  assert.doesNotMatch(JSON.stringify(input.messages), /旧会话原话|详细说明只留在记忆库|周末出门/);
  const menu = await f.send('/memory', ++updateId);
  const recent = menu[0].text.split('\n\n').find(block => block.startsWith('最近经历与计划'));
  assert.deepEqual(recent.split('\n').slice(1), expected.map(item => '· ' + item));
  assert.equal(menu[0].text.match(/画鲸鱼/g).length, 1);
  await f.send('另一位用户打招呼', ++updateId, 222);
  assert.equal(background(f.requests.at(-1)).recentEvents, undefined);
  await f.send('/role 大肥鱼', ++updateId);
  await f.send('切换角色后打招呼', ++updateId);
  assert.equal(background(f.requests.at(-1)).recentEvents, undefined);
  await f.send('/role 鳄鱼爸爸', ++updateId);
  const confirm = await f.send('/forget', ++updateId);
  await f.click(confirm[0].reply_markup.inline_keyboard[0][0].callback_data, ++updateId);
  assert.ok(ws.store.sessions(ws.childId, roleId).length > 0);
  const cleared = await f.send('/memory', ++updateId);
  assert.match(cleared[0].text, /暂无已整理的经历与计划/);
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
test('voice transcribes straight into chat, persists the original voice source, and deduplicates both paid calls', async t => {
  let asr = 0;
  const f = await fixture(t, { voiceLoader: async () => 'YXVkaW8=', asr: async () => { asr++; return '我想学画画'; } });
  const out = await f.send('', 1, 111, { voice: { duration: 2, file_id: 'a', file_size: 4 } });
  assert.equal(asr, 1); assert.equal(f.count(), 1);
  assert.deepEqual(out.map(m => m.text), ['识别为：我想学画画', '在', '第二段\n\n仍是同一条。']);
  assert.deepEqual(out[0].reply_parameters, { message_id: 1, allow_sending_without_reply: true });
  assert.equal(out[0].disable_notification, true);
  assert.ok(out.every(m => !m.reply_markup?.inline_keyboard));
  assert.ok(JSON.stringify(f.requests[0].messages).includes('我想学画画'));
  const row = f.db.db.prepare('SELECT * FROM inbox WHERE id=1').get();
  assert.equal(row.text, '我想学画画'); assert.equal(JSON.parse(row.source).kind, 'voice');
  await f.send('', 1, 111, { voice: { duration: 2, file_id: 'a', file_size: 4 } });
  assert.equal(asr, 1); assert.equal(f.count(), 1);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM message_cleanup').get().n, 0);
});
test('voice stays with the preceding role when a role switch arrives during recognition', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { voiceLoader: async () => 'eA==', asr: async () => { await gate; return '这是一段语音'; } });
  f.core.accept(update(1, '', 111, { voice: { duration: 1, file_id: 'a' } }));
  f.core.accept(update(2, '/role 大肥鱼'));
  release(); await f.core.idle();
  const ws = f.core.workspaces.get('111');
  assert.equal(ws.store.agentRecord(ws.state().roleId).name, '大肥鱼');
  const run = ws.store.sql('SELECT agent_id FROM runs').get();
  assert.equal(ws.store.agentRecord(run.agent_id).name, '鳄鱼爸爸');
});
test('quoted transcription is available before generation finishes and only the transcription expires', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const generating = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { voiceLoader: async () => 'eA==', asr: async () => '我想画鲸鱼',
    config: { provider: { async chat() { started(); await gate; return answer(['想画哪种鲸鱼？']); } } } });
  f.core.accept(update(1, '', 111, { voice: { duration: 2, file_id: 'a' } }));
  await generating;
  try {
    const transcript = f.db.claim();
    assert.equal(transcript.body.text, '识别为：我想画鲸鱼');
    assert.deepEqual(transcript.body.reply_parameters, { message_id: 1, allow_sending_without_reply: true });
    f.db.receipt({ id: transcript.id, state: 'sent', telegramId: 101 });
    assert.deepEqual(f.db.db.prepare('SELECT message_id FROM message_cleanup').all().map(r=>r.message_id), [101]);
  } finally { release(); }
  await f.core.idle();
  const reply = f.db.claim(); assert.equal(reply.body.text, '想画哪种鲸鱼？');
  assert.equal(reply.body.reply_parameters, undefined);
  f.db.receipt({ id: reply.id, state: 'sent', telegramId: 102 });
  assert.deepEqual(f.db.db.prepare('SELECT message_id FROM message_cleanup').all().map(r=>r.message_id), [101]);
});
test('transcription outbox remains idempotent across a saved-text restart gap and preserves its delivery receipt', async t => {
  const f = await fixture(t, { voiceLoader: async () => 'eA==', asr: async () => '识别出来的文字' });
  await f.send('', 1, 111, { voice: { duration: 2, file_id: 'a' } });
  const transcript = f.db.claim(); f.db.receipt({ id: transcript.id, state: 'sent', telegramId: 101 });
  const row = f.db.db.prepare('SELECT * FROM inbox WHERE id=1').get();
  f.db.queueTranscription(row, row.text, 1);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM outbox WHERE update_id=1 AND logical_index=-1').get().n, 1);
  assert.equal(f.db.db.prepare('SELECT state FROM outbox WHERE logical_index=-1').get().state, 'sent');
  assert.equal(f.count(), 1);
});
test('transcription resumes after a restart gap without recognizing the voice a second time', async t => {
  let asr = 0;
  const f = await fixture(t, { voiceLoader: async () => 'eA==', asr: async () => { asr++; return '不能再识别'; } });
  await f.send('/start', 1);
  const voice = update(2, '', 111, { voice: { duration: 1, file_id: 'a' } });
  f.db.accept(voice, privateUpdate(voice));
  f.db.bind(2, f.core.workspaces.get('111').state().roleId, '/forget');
  f.core.kick('111'); await f.core.idle();
  assert.equal(asr, 0); assert.equal(f.count(), 1);
  assert.ok(JSON.stringify(f.requests[0].messages).includes('/forget'));
  assert.ok(!f.db.db.prepare('SELECT body FROM outbox WHERE update_id=2').all().some(r => JSON.parse(r.body).reply_markup?.inline_keyboard));
});
test('old voice confirmation state does not trap new text or voice in a confirmation flow', async t => {
  const f = await fixture(t); await f.send('/start', 1);
  const ws = f.core.workspaces.get('111'), state = ws.state();
  state.draft = { type: 'voice', text: '旧语音', roleId: state.roleId, nonce: 'old', expires: Date.now()+600000 };
  ws.save(state); await f.send('继续聊天', 2);
  assert.equal(f.count(), 1); assert.equal(ws.state().draft, undefined);
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
test('management cards and their text commands expire, but voice and character messages never do', async t => {
  const f = await fixture(t);
  await f.send('你好', 1);
  await f.send('/memory', 2);
  const normal = f.db.db.prepare('SELECT * FROM outbox WHERE update_id=1').all();
  const card = f.db.db.prepare('SELECT * FROM outbox WHERE update_id=2').get();
  assert.ok(normal.every(r => r.ephemeral === 0)); assert.equal(card.ephemeral, 1);
  for (const row of normal) f.db.receipt({ id: row.id, state: 'sent', telegramId: 100 + row.id });
  f.db.receipt({ id: card.id, state: 'sent', telegramId: 200 });
  const scheduled = f.db.db.prepare('SELECT * FROM message_cleanup ORDER BY message_id').all();
  assert.deepEqual(scheduled.map(r => r.message_id), [2, 200]);
  assert.ok(scheduled.every(r => r.due_at > Date.now() + 58_000));
  assert.equal(f.db.nextCleanup(), undefined);
  assert.ok(f.db.nextCleanup(Date.now() + 61_000));
});
test('resend keeps real answer copies while the resend notice is temporary', async t => {
  const f = await fixture(t); await f.send('你好', 1); await f.send('/resend', 2);
  const out = f.db.db.prepare('SELECT ephemeral FROM outbox WHERE update_id=2 ORDER BY id').all();
  assert.deepEqual(out.map(r => r.ephemeral), [1, 0, 0]);
});
test('scheduled deletion persists across connections and deletes only the recorded management message', async t => {
  const f = await fixture(t); await f.send('/status', 1);
  f.db.db.prepare('UPDATE message_cleanup SET due_at=0').run();
  const reopened = new BotDatabase(join(f.dir, 'bot.sqlite'));
  try {
    const calls = [];
    const app = new TelegramApp({ env: {}, config: f.config, database: reopened, core: f.core,
      api: { async call(method, body) { calls.push({ method, body }); return true; } } });
    assert.equal(await app.cleanupOnce(), true);
    assert.deepEqual(calls, [{ method: 'deleteMessage', body: { chat_id: '111', message_id: 1 } }]);
    assert.equal(reopened.db.prepare('SELECT state FROM message_cleanup').get().state, 'done');
    assert.equal(await app.cleanupOnce(), false);
  } finally { reopened.close(); }
});
test('delete retries are idempotent on timeouts/429 and stop on permanent refusal', async t => {
  const f = await fixture(t); await f.send('/status', 1);
  const errors = [Object.assign(new Error(), { unknown: true }), Object.assign(new Error(), { code: 429, retryAfter: 3 }), Object.assign(new Error(), { code: 403 })];
  const app = new TelegramApp({ env: {}, config: f.config, database: f.db, core: f.core,
    api: { async call() { throw errors.shift(); } } });
  for (const expected of ['pending','pending','failed']) {
    f.db.db.prepare('UPDATE message_cleanup SET due_at=0').run();
    await app.cleanupOnce(); assert.equal(f.db.db.prepare('SELECT state FROM message_cleanup').get().state, expected);
  }
  assert.equal(await app.cleanupOnce(), false); assert.equal(f.count(), 0);
});
test('old management responses migrate once; old character answers and resend copies remain', async t => {
  const f = await fixture(t);
  await f.send('你好', 1); await f.send('/memory', 2); await f.send('/resend', 3);
  const rows = f.db.db.prepare('SELECT * FROM outbox ORDER BY id').all();
  for (const row of rows) f.db.receipt({ id: row.id, state: 'sent', telegramId: 100 + row.id });
  f.db.db.prepare('DELETE FROM message_cleanup').run();
  f.db.db.prepare('UPDATE outbox SET ephemeral=0').run();
  f.db.expireExistingControls();
  const controls = f.db.db.prepare('SELECT telegram_id FROM outbox WHERE update_id=2').all();
  assert.deepEqual(f.db.db.prepare('SELECT message_id FROM message_cleanup').all().map(r=>r.message_id), controls.map(r=>r.telegram_id));
  f.db.expireExistingControls(); assert.equal(f.db.db.prepare('SELECT count(*) n FROM message_cleanup').get().n, controls.length);
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
