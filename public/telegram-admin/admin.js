const $ = id => document.getElementById(id);
let snapshot, saving = false, noticeTimer, pendingMode;
const rowNodes = new Map(), chipNodes = new Map();
async function api(path, data) {
  const response = await fetch(path, { cache: 'no-store', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chatlab-Admin': '1' }, body: JSON.stringify(data) }) });
  const value = await response.json();
  if (response.status === 401) showLogin();
  if (!response.ok) throw new Error(value.error || '暂时连接不上，请稍后重试');
  return value;
}
function notify(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 4000); }
function showLogin() { $('login').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true; $('health').textContent = '管理台'; if ($('mode-dialog').open) $('mode-dialog').close(); snapshot = undefined; rowNodes.clear(); chipNodes.clear(); $('users').replaceChildren(); $('whitelist').replaceChildren(); }
function date(value) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '待下次互动更新'; }
function button(text, fn) { const b = document.createElement('button'); b.textContent = text; b.className = 'small-action'; b.addEventListener('click', fn); b.disabled = saving; return b; }
async function save(publicAccess, allowedUserIds) {
  if (saving || !snapshot) return;
  saving = true;
  try { snapshot = { ...snapshot, ...await api('/api/access', { publicAccess, allowedUserIds, revision: snapshot.policy.revision }) }; render(); notify('已生效，重启后也会保留'); }
  catch (error) { notify(error.message); try { snapshot = await api('/api/state'); } catch {} }
  finally { saving = false; render(); }
}
function toggle(id) { const ids = new Set(snapshot.policy.allowedUserIds); ids.has(id) ? ids.delete(id) : ids.add(id); return save(snapshot.policy.publicAccess, [...ids]); }
function render() {
  if (!snapshot) return;
  const { counts, policy, bot } = snapshot;
  $('total').textContent = counts.total; $('active').textContent = counts.active5m; $('today').textContent = counts.today; $('whitelist-count').textContent = counts.whitelist;
  $('mode').textContent = policy.publicAccess ? '公开测试' : '白名单模式';
  $('mode-title').textContent = policy.publicAccess ? '所有人都可以开始聊天' : '仅白名单用户可以聊天';
  $('mode-detail').textContent = policy.publicAccess ? '现在不限制账号。先加入白名单，之后切换限制即可。' : '未开通的人仍可获取自己的 ID；现有聊天和记忆都会保留。';
  $('mode-toggle').textContent = policy.publicAccess ? '开启白名单限制' : '开放所有人测试'; $('mode-toggle').disabled = saving;
  $('updated').textContent = `更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 每 5 秒自动刷新`;
  $('health').textContent = bot?.healthy ? 'Bot 运行正常' : 'Bot 正在连接';
  const search = $('search').value.trim().toLowerCase();
  let visible = 0;
  const put = (node, value) => { if (node.textContent !== String(value)) node.textContent = value; };
  const present = new Set(snapshot.users.map(u=>u.id));
  for (const [id, node] of rowNodes) if (!present.has(id)) { node.row.remove(); rowNodes.delete(id); }
  for (const [index,user] of snapshot.users.entries()) {
    let node = rowNodes.get(user.id);
    if (!node) {
      const row = document.createElement('tr'), name = document.createElement('td'), strong = document.createElement('span'), handle = document.createElement('span');
      strong.className='user-name';handle.className='user-handle';name.append(strong,handle);row.append(name);
      const cells=Array.from({length:5},()=>document.createElement('td'));cells[0].className='mono';row.append(...cells);
      const action=document.createElement('td'), toggleButton=button('',()=>toggle(user.id));action.append(toggleButton);row.append(action);
      node={row,strong,handle,cells,toggleButton};rowNodes.set(user.id,node);
    }
    put(node.strong,user.name);put(node.handle,user.username?'@'+user.username:'');node.handle.hidden=!user.username;
    [user.id,date(user.firstSeenAt),date(user.lastSeenAt),user.messages,user.canChat?'可使用':'未开通'].forEach((v,i)=>put(node.cells[i],v));
    put(node.toggleButton,user.whitelisted?'移出白名单':'加入白名单');node.toggleButton.disabled=saving;
    node.row.hidden=![user.name,user.username,user.id].filter(Boolean).join(' ').toLowerCase().includes(search);
    if (!node.row.hidden) visible++;
    const current=$('users').children[index];if(current!==node.row)$('users').insertBefore(node.row,current??null);
  }
  $('empty').hidden=visible!==0;
  const allowed=new Set(policy.allowedUserIds);
  for(const[id,node]of chipNodes)if(!allowed.has(id)){node.chip.remove();chipNodes.delete(id);}
  for(const id of policy.allowedUserIds){let node=chipNodes.get(id);if(!node){const chip=document.createElement('span');chip.className='chip';chip.append(document.createTextNode(id));const remove=button('×',()=>toggle(id));remove.setAttribute('aria-label',`移出 ${id}`);chip.append(remove);node={chip,remove};chipNodes.set(id,node);$('whitelist').append(chip);}node.remove.disabled=saving;}
}
async function refresh() { if (saving || $('dashboard').hidden) return; snapshot = await api('/api/state'); render(); }
async function enter() { $('login').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false; await refresh(); }
$('login-form').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/login', { password: $('password').value }); $('password').value = ''; await enter(); } catch (error) { notify(error.message); } });
$('logout').addEventListener('click', async () => { try { await api('/api/logout', {}); showLogin(); } catch (error) { notify(error.message); } });
$('refresh').addEventListener('click', () => refresh().catch(error => notify(error.message)));
$('search').addEventListener('input', render);
$('mode-toggle').addEventListener('click', () => { pendingMode=!snapshot.policy.publicAccess; $('mode-dialog-title').textContent=pendingMode?'开放所有人测试？':'开启白名单限制？';$('mode-dialog-detail').textContent=pendingMode?'所有 Telegram 用户都可以开始聊天。':'未加入白名单的用户将无法继续聊天，现有资料、聊天和记忆都会保留。';$('mode-dialog').showModal(); });
$('mode-cancel').addEventListener('click',()=> $('mode-dialog').close());
$('mode-confirm').addEventListener('click',async()=>{$('mode-dialog').close();await save(pendingMode,snapshot.policy.allowedUserIds);});
$('add-form').addEventListener('submit', async event => { event.preventDefault(); const id = $('user-id').value.trim(); if (!/^[1-9]\d{0,15}$/.test(id)) return notify('请输入正确的数字 ID'); await save(snapshot.policy.publicAccess, [...new Set([...snapshot.policy.allowedUserIds, id])]); $('user-id').value = ''; });
setInterval(() => { if (!document.hidden) void refresh().catch(() => { $('health').textContent = '刷新暂时中断'; }); }, 5000);
try { if ((await api('/api/auth')).authenticated) await enter(); } catch (error) { notify(error.message); }
