import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotDatabase } from '../lib/telegram/database.mjs';
import { privateUpdate } from '../lib/telegram/platform.mjs';
import { createTelegramAdmin } from '../lib/telegram/admin.mjs';
import { request as httpRequest } from 'node:http';
import { TelegramApp } from '../lib/telegram/app.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chatlab-admin-test-')), db = new BotDatabase(join(dir,'bot.sqlite'));
  db.loadAccessPolicy({ publicAccess: true, allowedUserIds: ['111'] });
  t.after(() => { db.close(); rmSync(dir,{recursive:true,force:true}); });
  return db;
}
async function web(t) {
  const db = fixture(t), applied = [];
  const admin = createTelegramAdmin({ database: db, password: 'admin-test-password', origin: 'http://127.0.0.1:9988',
    getBotState: () => ({ healthy: true, username: 'test_bot', thinking: 'disabled' }), applyPolicy: policy => applied.push(policy) });
  const address = await admin.listen(0,'127.0.0.1'), origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await admin.close(); });
  const post = (path, body, cookie = '', headers = {}) => fetch(origin+path,{ method:'POST',headers:{'Content-Type':'application/json','X-Chatlab-Admin':'1',Origin:origin,Cookie:cookie,...headers},body:JSON.stringify(body) });
  const login = async () => { const response = await post('/api/login',{password:'admin-test-password'}); assert.equal(response.status,200); return response.headers.get('set-cookie').split(';')[0]; };
  return { db, applied, origin, post, login };
}

test('user activity is deduplicated and admin snapshots exclude message content', t => {
  const db=fixture(t);
  const update={update_id:1,message:{message_id:1,date:Math.floor(Date.now()/1000),chat:{id:333,type:'private'},from:{id:333,first_name:'小明',last_name:'同学',username:'ming'},text:'private-chat-secret'}};
  assert.equal(db.accept(update,privateUpdate(update)),true);assert.equal(db.accept(update,privateUpdate(update)),false);
  const snapshot=db.adminSnapshot();assert.equal(snapshot.counts.total,1);assert.equal(snapshot.counts.active5m,1);assert.equal(snapshot.users[0].messages,1);
  assert.equal(snapshot.users[0].name,'小明 同学');assert.equal(snapshot.users[0].username,'ming');assert.ok(!JSON.stringify(snapshot).includes('private-chat-secret'));
});
test('policy survives restart defaults and rejects stale or invalid updates', t => {
  const db=fixture(t);const saved=db.saveAccessPolicy({publicAccess:false,allowedUserIds:['222'],revision:0});
  assert.equal(saved.revision,1);assert.equal(db.loadAccessPolicy({publicAccess:true,allowedUserIds:[]}).publicAccess,false);
  assert.throws(()=>db.saveAccessPolicy({publicAccess:true,allowedUserIds:['333'],revision:0}),error=>error.status===409);
  assert.throws(()=>db.saveAccessPolicy({publicAccess:true,allowedUserIds:['not-an-id'],revision:1}));
  assert.deepEqual(db.loadAccessPolicy().allowedUserIds,['222']);
});
test('app startup honors the saved web policy instead of overwriting it from the original env defaults', async t => {
  const db=fixture(t);db.saveAccessPolicy({publicAccess:false,allowedUserIds:['222'],revision:0});
  let effective;
  const app=new TelegramApp({env:{TELEGRAM_PUBLIC_ACCESS:'1',TELEGRAM_ALLOWED_USER_IDS:'111'},database:db,
    config:{model:{name:'mock',thinking:'disabled'}},core:{setAccessPolicy(value){effective=value;},start(){}},
    api:{async call(method){return method==='getMe'?{id:123456,username:'test_bot'}:method==='getWebhookInfo'?{url:''}:true;}}});
  await app.initialize();assert.equal(app.publicAccess,false);assert.deepEqual(app.allowed,['222']);assert.equal(effective.publicAccess,false);
});
test('management data requires password and logout revokes the session', async t => {
  const f=await web(t);assert.equal((await fetch(f.origin+'/api/state')).status,401);
  assert.equal((await f.post('/api/login',{password:'wrong'})).status,401);
  const cookie=await f.login();assert.ok(!cookie.includes('admin-test-password'));
  const state=await fetch(f.origin+'/api/state',{headers:{Cookie:cookie}});assert.equal(state.status,200);assert.equal((await state.json()).policy.publicAccess,true);
  await f.post('/api/logout',{},cookie);assert.equal((await fetch(f.origin+'/api/state',{headers:{Cookie:cookie}})).status,401);
});
test('authenticated policy updates apply immediately, remain persistent and reject cross-site mutation', async t => {
  const f=await web(t),cookie=await f.login();const value={publicAccess:false,allowedUserIds:['111','222'],revision:0};
  assert.equal((await f.post('/api/access',value,cookie,{Origin:'https://foreign.example'})).status,403);
  assert.equal(f.db.loadAccessPolicy().revision,0);
  const response=await f.post('/api/access',value,cookie);assert.equal(response.status,200);
  assert.equal(f.applied[0].publicAccess,false);assert.deepEqual(f.db.loadAccessPolicy().allowedUserIds,['111','222']);
  assert.equal((await f.post('/api/access',value,cookie)).status,409);
});
test('admin serves a local UI with a restrictive content policy and no HTML injection rendering', async t => {
  const f=await web(t);const page=await fetch(f.origin+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const js=await(await fetch(f.origin+'/admin.js')).text();assert.ok(!js.includes('innerHTML'));assert.match(js,/textContent/);
  const status = await new Promise((resolve,reject) => { const request=httpRequest(f.origin+'/api/state',{headers:{Host:'untrusted.example'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end(); });
  assert.equal(status,403);
});
