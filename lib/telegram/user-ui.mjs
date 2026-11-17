import { problem } from '../store.mjs';

export const CHAT_KEYBOARD = { keyboard: [
  [{ text: '🎭 切换角色' }, { text: '👤 我的资料' }],
  [{ text: '💬 新会话' }, { text: '🧠 记忆' }],
  [{ text: '✏️ 创建角色' }, { text: '⚙️ 设置' }],
], resize_keyboard: true, is_persistent: true, input_field_placeholder: '直接聊天，或点下方功能' };
export const BUTTON_COMMANDS = { '🎭 切换角色': 'roles', '👤 我的资料': 'profile', '💬 新会话': 'new', '🧠 记忆': 'memory', '✏️ 创建角色': 'create', '⚙️ 设置': 'settings' };
export const HOME_MENU = { inline_keyboard: [
  [{ text: '切换角色', callback_data: '/roles' }, { text: '我的资料', callback_data: '/profile' }],
  [{ text: '新会话', callback_data: '/new' }, { text: '记忆', callback_data: '/memory' }],
  [{ text: '创建角色', callback_data: '/create' }, { text: '我的角色', callback_data: '/myroles' }],
] };
export const CANCEL_BUTTON = { inline_keyboard: [[{ text: '取消', callback_data: '/cancel' }]] };
export function rolePicker(roles, currentId, { onboarding = false } = {}) {
  return { text: onboarding ? '最后，选一个想聊天的角色。' : '想和谁聊？每个角色的聊天和记忆独立。',
    reply_markup: { inline_keyboard: roles.map(a => [{ text: `${a.id === currentId && !onboarding ? '✓ ' : ''}${a.name}${a.metadata?.audience?.minimumAge ? ' · 18+' : ''}`, callback_data: `/role ${a.id}` }]) } };
}
export function profileCard(ws) {
  const profile = ws.store.child(ws.childId);
  return { text: `你的聊天资料\n\n称呼：${profile.name}\n年龄：${profile.age ?? '未填写'}\n\n修改资料会保留原来的聊天和记忆。`,
    reply_markup: { inline_keyboard: [
      [{ text: '修改称呼', callback_data: '/useredit name' }, { text: '修改年龄', callback_data: '/useredit age' }],
      [{ text: '不填写年龄', callback_data: '/useredit clear_age' }, { text: '选择角色', callback_data: '/roles' }],
    ] } };
}
const welcome = () => [{ text: '欢迎来到 ChatLab。\n先建一份聊天资料，再选一个角色。', reply_markup: { inline_keyboard: [[{ text: '创建聊天资料', callback_data: '/setup create' }]] } }];
const ageCard = () => [{ text: '年龄可以填，也可以先跳过。部分角色只面向成年人。', reply_markup: { inline_keyboard: [
  [{ text: '填写年龄', callback_data: '/setup enter_age' }, { text: '暂不填写', callback_data: '/setup skip_age' }],
  [{ text: '返回称呼', callback_data: '/setup create' }],
] } }];
function setName(ws, value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 48 || value.includes('\0')) throw problem('称呼请写1–48字。');
  ws.store.sql('UPDATE children SET name=?,version=version+1 WHERE id=?').run(value.trim(), ws.childId);
}
function setAge(ws, value) {
  if (value !== null && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 120)) throw problem('年龄请填1–120的整数。');
  ws.store.sql('UPDATE children SET age=?,version=version+1 WHERE id=?').run(value === null ? null : Number(value), ws.childId);
}

// All setup/profile changes run inside the caller's durable action transaction.
export function handleUserUi(ws, input, cmd, state, roles) {
  if (cmd?.name === 'useredit' && state.onboardingComplete) {
    if (cmd.arg === 'clear_age') { setAge(ws, null); delete state.draft; return [profileCard(ws)]; }
    if (!['name', 'age'].includes(cmd.arg)) throw problem('请选择要修改的资料。');
    state.draft = { type: cmd.arg === 'name' ? 'profile_name' : 'profile_age' };
    return [{ text: cmd.arg === 'name' ? '想改成什么称呼？直接发给我。' : '请输入实际年龄（1–120的整数）。', reply_markup: CANCEL_BUTTON }];
  }
  if (state.onboardingComplete && ['profile_name','profile_age'].includes(state.draft?.type)) {
    if (cmd?.name === 'cancel') { delete state.draft; return [profileCard(ws)]; }
    if (cmd) { delete state.draft; return null; }
    if (input.voice) return [{ text: '这里先用文字填写资料。', reply_markup: CANCEL_BUTTON }];
    if (state.draft.type === 'profile_name') setName(ws, input.text); else setAge(ws, input.text.trim());
    delete state.draft; return [profileCard(ws)];
  }
  if (state.onboardingComplete) return cmd?.name === 'setup' ? [profileCard(ws)] : null;
  if (['id','status'].includes(cmd?.name)) return null;
  if (cmd?.name === 'cancel') { delete state.setupStage; delete state.draft; return welcome(); }
  if (cmd?.name === 'setup') {
    switch (cmd.arg) {
      case 'create': state.setupStage = 'name'; return [{ text: '怎么称呼你？直接输入一个名字。', reply_markup: { inline_keyboard: [[{ text: '用我的电报名', callback_data: '/setup use_name' }]] } }];
      case 'use_name': setName(ws, input.displayName); state.setupStage = 'age'; return ageCard();
      case 'enter_age': state.setupStage = 'enter_age'; return [{ text: '请输入实际年龄（1–120的整数）。', reply_markup: { inline_keyboard: [[{ text: '先跳过', callback_data: '/setup skip_age' }]] } }];
      case 'skip_age': setAge(ws, null); state.setupStage = 'role'; return [rolePicker(roles, null, { onboarding: true })];
      case 'pick_role': state.setupStage = 'role'; return [rolePicker(roles, null, { onboarding: true })];
      default: return welcome();
    }
  }
  if (state.setupStage === 'role' && cmd?.name === 'role') {
    const role = roles.find(a => a.id === cmd.arg || a.name === cmd.arg);
    if (!role) throw problem('请选择一个可用角色。');
    const minimum = ws.runtime.souls.get(role.id)?.audience?.minimumAge;
    const age = ws.store.child(ws.childId).age;
    if (minimum && (age === null || age < minimum)) return [{ text: age === null ? '这个角色仅面向成年人。请先填写年龄，或选其他角色。' : '这个角色仅面向成年人，请选其他角色。',
      reply_markup: { inline_keyboard: [...(age === null ? [[{ text: '填写年龄', callback_data: '/setup enter_age' }]] : []), [{ text: '选择其他角色', callback_data: '/setup pick_role' }]] } }];
    ws.runtime.assertAudience(ws.childId, role.id);
    state.roleId = role.id; state.onboardingComplete = true; delete state.setupStage; delete state.draft;
    return [{ text: `资料建好了，已选${role.name}。\n直接发文字或语音开始聊吧。`, reply_markup: CHAT_KEYBOARD }];
  }
  if (!cmd && !input.voice && state.setupStage === 'name') { setName(ws, input.text); state.setupStage = 'age'; return ageCard(); }
  if (!cmd && !input.voice && state.setupStage === 'enter_age') { setAge(ws, input.text.trim()); state.setupStage = 'role'; return [rolePicker(roles, null, { onboarding: true })]; }
  if (state.setupStage === 'age') return ageCard();
  if (state.setupStage === 'role') return [rolePicker(roles, null, { onboarding: true })];
  if (state.setupStage === 'name' || state.setupStage === 'enter_age') return [{ text: '这一步先用文字填写资料。', reply_markup: CANCEL_BUTTON }];
  return welcome();
}
