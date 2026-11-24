import { installAgentGallery } from './agent-gallery.js';
import { LocalWorkspace } from './local-workspace.js';
import { replyMessages } from './reply-layout.js';

const el = id => document.getElementById(id);
const ui = Object.fromEntries([
  'agent-select', 'agent-select-avatar', 'agent-select-label', 'child-select', 'session-select', 'new-child', 'new-session', 'agent-avatar',
  'agent-name', 'agent-description', 'messages', 'chat-empty', 'chat-empty-title', 'chat-empty-description',
  'chat-form', 'chat-input', 'send-button', 'model-status', 'chat-status', 'composer-hint', 'session-usage',
  'context-content', 'memory-content', 'child-dialog', 'child-form', 'child-name', 'child-age',
  'child-interests', 'child-error', 'child-cancel', 'app-error', 'context-toggle', 'memory-toggle',
  'context-panel', 'memory-panel', 'new-agent', 'clear-memory', 'guide-open', 'logout',
].map(id => [id, el(id)]));

const state = {
  agents: [], children: [], sessions: [], model: {}, agentId: '', childId: '', sessionId: '',
  dataVersion: '',
  scopeVersion: 0, sessionVersion: 0, sending: false, busy: false, conversation: null,
  editorSaving: false, queueSaving: false, authenticated: false,
  pendingMessages: [], pendingTimer: null,
  memorySignature: null, memoryOpen: new Set(), memoryDetails: new Map(), memoryData: null, memoryFilter: 'active', polling: false,
  sessionUsage: null, liveToolCalls: null,
  mentorRecommendation: null,
  catalogRevision: null, catalogAvailable: false, catalogAgents: [],
};
const selectionKey = 'croco-lab-v1.selection';
let workspaceClient = null;
let localSelection = {};
let bootstrapSerial = 0;
let pendingEntry = null;
let entryRecoveryTimer;
const avatars = new Map([['9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65', '/assets/benny.png']]);
const defaultPortraits = new Map([['2faddbf5-f25c-4972-9cb2-e57ee021ac12', '/assets/zhou-yu-portrait.png']]);
const agentDisplayOrder = new Map([['lin-xiaoman', 0], ['9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65', 1]]);
let defaultAgentIds = new Set(['lin-xiaoman', '9a15fadb-1fa5-437d-aeee-6f2a3e1e8d65', 'pinecone-lab',
  '2faddbf5-f25c-4972-9cb2-e57ee021ac12', '4fbfe444-659b-4915-ac3f-1842b6617b54',
  '90377140-008d-45d6-a2a1-61760514cdf9', 'f29db1e7-c667-4044-a37e-38254830d405', 'a1338cd3-e952-4f52-98b9-7ee6c8280fe7']);
const fallbackAvatar = '/assets/icons/person-circle.svg';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const sendPauseMs = 750;
const maxBatchMessages = 40;
const maxBatchChars = 16_000;
const statusLabels = {
  queued: '待整理', pending: '待整理', running: '整理中', processing: '整理中',
  complete: '已整理', completed: '已整理', committed: '已整理', done: '已整理', succeeded: '已整理', failed: '整理失败',
};
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function put(id, text) { if (ui[id]) ui[id].textContent = text; }
function show(id, text) {
  if (!ui[id]) return;
  ui[id].textContent = text || '';
  ui[id].hidden = !text;
}

async function api(path, body, method = 'POST') {
  if (typeof workspaceClient !== 'undefined' && workspaceClient) return workspaceClient.api(path, body, body === undefined ? 'GET' : method);
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    if (response.status === 401 && typeof showEntrance === 'function') showEntrance();
    const error = new Error(data?.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function installAgentEditor({ canOpen, onSaved, onBusyChanged = () => {},
  readAgent = id => api(`/api/agents/${encodeURIComponent(id)}`),
  writeAgent = (id, body) => api(id ? `/api/agents/${encodeURIComponent(id)}` : '/api/agents', body, id ? 'PATCH' : 'POST'),
  getNote = () => '' }) {
  const fields = Object.fromEntries(['title', 'form', 'name', 'definition', 'note', 'error', 'reload', 'cancel', 'save']
    .map(key => [key, el(`agent-editor-${key}`)]));
  const dialog = el('agent-editor');
  let editingId = '';
  let revision;
  let loading = false;
  let saving = false;
  let conflicted = false;
  let pendingSaved = null;
  let loadSerial = 0;

  function errorMessage(message = '') {
    fields.error.textContent = message;
    fields.error.hidden = !message;
  }

  function renderControls() {
    fields.name.disabled = fields.definition.disabled = loading || saving || Boolean(pendingSaved);
    fields.save.disabled = loading || saving || conflicted || Boolean(editingId && revision == null);
    fields.cancel.disabled = saving;
    fields.reload.disabled = loading || saving;
    fields.save.textContent = saving ? '保存中…' : pendingSaved ? '刷新界面' : '保存';
    dialog.setAttribute('aria-busy', String(loading || saving));
  }

  async function loadSaved() {
    if (!editingId || saving) return;
    const serial = ++loadSerial;
    loading = true;
    errorMessage();
    renderControls();
    try {
      const { agent } = await readAgent(editingId);
      if (serial !== loadSerial || !dialog.open) return;
      if (!agent || agent.id !== editingId || typeof agent.name !== 'string' || typeof agent.definition !== 'string' || agent.revision == null) {
        throw new Error('角色数据不完整，请重新载入。');
      }
      fields.name.value = agent.name;
      fields.definition.value = agent.definition;
      revision = agent.revision;
      conflicted = false;
      fields.reload.hidden = true;
    } catch (error) {
      if (serial !== loadSerial || !dialog.open) return;
      errorMessage(error.message || '读取角色失败，请重试。');
      fields.reload.hidden = false;
    } finally {
      if (serial === loadSerial) {
        loading = false;
        renderControls();
      }
    }
  }

  async function open(id = '') {
    if (!canOpen() || saving) return;
    ++loadSerial;
    fields.form.reset();
    editingId = id;
    revision = undefined;
    loading = false;
    conflicted = false;
    pendingSaved = null;
    fields.title.textContent = id ? '编辑角色' : '创建角色';
    if (fields.note) { fields.note.textContent = getNote(id); fields.note.hidden = !fields.note.textContent; }
    fields.reload.hidden = true;
    errorMessage();
    renderControls();
    dialog.showModal();
    if (id) await loadSaved();
    if (dialog.open) fields.name.focus();
  }

  fields.form.addEventListener('submit', async event => {
    event.preventDefault();
    if (loading || saving || conflicted || !dialog.open) return;
    const name = fields.name.value.trim();
    const definition = fields.definition.value;
    if (!pendingSaved && (!name || !definition.trim())) {
      errorMessage('请填写名称和角色设定。');
      (!name ? fields.name : fields.definition).focus();
      return;
    }
    if (editingId && revision == null) {
      errorMessage('请先重新载入角色，再保存。');
      fields.reload.hidden = false;
      return;
    }
    saving = true;
    onBusyChanged(true);
    errorMessage();
    renderControls();
    try {
      if (!pendingSaved) {
        const result = await writeAgent(editingId, { name, definition, ...(editingId ? { revision } : {}) });
        if (!result.agent?.id) throw new Error('保存结果不完整，请重新载入角色列表。');
        pendingSaved = { agent: result.agent, created: !editingId };
      }
      await onSaved(pendingSaved.agent, { created: pendingSaved.created });
      dialog.close();
    } catch (error) {
      if (error.status === 409) {
        conflicted = true;
        fields.reload.hidden = false;
        errorMessage('此角色已在别处更新。你的草稿已保留；可先复制草稿，再重新载入已保存版本。');
      } else {
        errorMessage(pendingSaved ? `角色已保存，但界面刷新失败：${error.message}。请点击“刷新界面”重试。` : error.message);
      }
    } finally {
      saving = false;
      onBusyChanged(false);
      renderControls();
    }
  });
  fields.reload.addEventListener('click', () => void loadSaved());
  fields.cancel.addEventListener('click', () => { if (!saving) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++loadSerial; });
  return { open };
}

function selectedScope() { return { childId: state.childId, agentId: state.agentId }; }
function scoped(path, scope = selectedScope()) { return `${path}?${new URLSearchParams(scope)}`; }
function hasScope() { return Boolean(state.agentId && state.childId); }
function agent() { return state.agents.find(item => item.id === state.agentId); }
function child() { return state.children.find(item => item.id === state.childId); }
function audienceBlocked(selected = agent()) {
  const minimumAge = selected?.minimumAge;
  return Boolean(minimumAge && (!Number.isInteger(child()?.age) || child().age < minimumAge));
}
function imageForAgent(selected = agent()) {
  return selected ? selected.avatar || avatars.get(selected.id) || selected.card?.portrait || defaultPortraits.get(selected.id) || fallbackAvatar : '';
}

function savedSelection() {
  if (workspaceClient) return localSelection;
  try { return JSON.parse(localStorage.getItem(selectionKey)) || {}; } catch { return {}; }
}

function saveSelection() {
  if (workspaceClient) {
    localSelection = { ...selectedScope(), sessionId: state.sessionId };
    void workspaceClient.saveSelection(localSelection).catch(error => show('app-error', error.message));
    return;
  }
  try { localStorage.setItem(selectionKey, JSON.stringify({ ...selectedScope(), sessionId: state.sessionId })); }
  catch { /* The current selection works without browser storage. */ }
}

function dateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? dateFormatter.format(date) : String(value);
}

function dateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : value || '日期未记录';
}

function optionList(select, items, value, label, placeholder) {
  const options = items.map(item => new Option(label(item), item.id));
  if (!options.length) options.push(new Option(placeholder, ''));
  select.replaceChildren(...options);
  select.value = value || options[0].value;
}

function renderSelectors() {
  optionList(ui['child-select'], state.children, state.childId, item => item.name, '选择用户');
  optionList(ui['session-select'], state.sessions, state.sessionId, item => {
    return item.title && item.title !== '新会话' ? item.title : (dateTime(item.createdAt) || '新会话');
  }, '暂无会话');
  const selected = agent();
  const avatar = imageForAgent();
  put('agent-select-label', selected?.name || '暂无角色');
  ui['agent-select'].setAttribute('aria-label', selected ? `选择角色，当前为${selected.name}` : '选择角色');
  if (avatar) ui['agent-select-avatar'].src = avatar;
  else ui['agent-select-avatar'].removeAttribute('src');
  ui['agent-select-avatar'].hidden = !avatar;
  if (ui['agent-avatar']) {
    if (avatar) ui['agent-avatar'].src = avatar;
    else ui['agent-avatar'].removeAttribute('src');
    ui['agent-avatar'].hidden = !avatar;
    ui['agent-avatar'].classList.toggle('is-fallback', avatar === fallbackAvatar);
  }
  put('agent-name', selected?.name || '选择 Agent');
  put('agent-description', selected?.description || selected?.definition?.replace(/\s+/g, ' ').slice(0, 72) || '');
  const modelName = state.model.name || '聊天模型';
  const text = state.model.mode === 'demo' ? `演示模式 · ${modelName}`
    : state.model.configured ? modelName : (state.agents.length ? '模型尚未配置' : '正在连接');
  const statusLabel = ui['model-status']?.querySelector('[data-model-label]');
  if (statusLabel) statusLabel.textContent = text;
  else put('model-status', text);
  if (ui['model-status']) {
    ui['model-status'].dataset.state = state.model.configured ? 'online' : 'offline';
    ui['model-status'].title = text;
  }
  const emptyAvatar = ui['chat-empty']?.querySelector('.empty-avatar');
  if (emptyAvatar) {
    if (avatar) emptyAvatar.src = avatar;
    else emptyAvatar.removeAttribute('src');
    emptyAvatar.hidden = !avatar;
    emptyAvatar.classList.toggle('is-fallback', avatar === fallbackAvatar);
  }
  updateControls();
}

function updateControls() {
  const locked = state.sending || state.busy || state.editorSaving || state.queueSaving;
  const scopeLocked = locked || state.pendingMessages.length > 0;
  const closed = state.conversation?.session?.status === 'closed';
  const minimumAge = agent()?.minimumAge;
  const blocked = audienceBlocked();
  ui['agent-select'].disabled = scopeLocked || !state.agents.length;
  ui['child-select'].disabled = scopeLocked || !state.children.length;
  ui['session-select'].disabled = scopeLocked || !state.sessions.length;
  ui['new-child'].disabled = scopeLocked;
  ui['new-agent'].disabled = scopeLocked;
  ui['new-session'].disabled = scopeLocked || !hasScope() || blocked;
  if (ui['clear-memory']) ui['clear-memory'].disabled = scopeLocked || !hasScope();
  ui['chat-input'].disabled = !hasScope() || closed || blocked || state.busy || state.queueSaving;
  ui['chat-input'].placeholder = !state.agentId ? '先创建或选择角色' : !state.childId ? '先选择或创建用户' : blocked ? `此角色仅限${minimumAge}岁及以上，请切换或创建成年用户` : closed ? '此会话已结束，可开启新会话' : `给${agent()?.name || 'Agent'}发消息…`;
  ui['send-button'].disabled = locked || !hasScope() || closed || blocked || !ui['chat-input'].value.trim();
  const recommendationButton = ui.messages.querySelector('.mentor-recommendation button');
  if (recommendationButton) recommendationButton.disabled = scopeLocked || !availableMentor(state.mentorRecommendation?.mentor.id);
  syncAgentGalleryRoute();
}


function chatMessage(role, text, animate = false, replyParts) {
  const assistant = role === 'assistant';
  const row = node('div', `message-row ${assistant ? 'is-assistant' : 'is-user'}`);
  if (assistant && imageForAgent()) {
    const avatar = node('img', 'message-avatar');
    avatar.src = imageForAgent();
    avatar.classList.toggle('is-fallback', avatar.src.endsWith(fallbackAvatar));
    avatar.alt = '';
    row.append(avatar);
  }
  const stack = node('div', 'message-stack');
  const bubbles = assistant ? replyMessages(text, replyParts) : text === undefined ? [] : [text];
  for (const part of bubbles) stack.append(messageBubble(part, animate));
  row.append(stack);
  return { row, stack };
}

function messageBubble(text, animate = false) {
  return node('div', animate ? 'message-bubble is-arriving' : 'message-bubble', text);
}

function availableMentor(id) {
  const target = state.agents.find(item => item.id === id && item.id !== state.agentId);
  return target && !audienceBlocked(target) ? target : null;
}

function appendMentorRecommendation(stack, mentor) {
  const target = availableMentor(mentor?.id);
  if (!target) return false;
  const name = mentor.name || target.name;
  const card = node('section', 'mentor-recommendation');
  card.setAttribute('aria-label', '推荐导师');
  const avatar = node('img', 'mentor-recommendation-avatar');
  avatar.alt = '';
  avatar.src = mentor.avatarUrl || imageForAgent(target);
  avatar.addEventListener('error', () => { avatar.src = fallbackAvatar; }, { once: true });
  const details = node('div', 'mentor-recommendation-details');
  details.append(node('div', 'mentor-recommendation-label', '推荐导师'), node('strong', '', name));
  const description = mentor.description || target.description;
  if (description) details.append(node('p', '', description));
  const action = node('button', 'primary-button mentor-recommendation-action', '去聊聊');
  action.type = 'button';
  action.disabled = ui['agent-select'].disabled;
  action.addEventListener('click', () => void selectAgent(target.id, mentor));
  card.append(avatar, details, action);
  stack.append(card);
  return true;
}

function clearMentorRecommendation() {
  state.mentorRecommendation = null;
  ui.messages.querySelector('.mentor-recommendation')?.remove();
}

function clearMentorArrival() {
  el('mentor-arrival')?.remove();
}

function showMentorArrival(source, target, mentor) {
  clearMentorArrival();
  const card = node('section', 'mentor-arrival');
  card.id = 'mentor-arrival';
  card.tabIndex = -1;
  card.setAttribute('role', 'status');
  const check = node('span', 'mentor-arrival-check', '✓');
  check.setAttribute('aria-hidden', 'true');
  const copy = node('div');
  copy.append(
    node('strong', '', '已通过推荐进入'),
    node('p', 'mentor-arrival-route', `由${source.name}推荐，正在和${target.name}聊天。`),
  );
  if (mentor.description) copy.append(node('p', 'mentor-arrival-specialty', mentor.description));
  card.append(check, copy);
  ui.messages.parentElement.before(card);
  card.focus({ preventScroll: true });
}

function appendTyping(stack) {
  if (stack.querySelector('.message-typing')) return;
  const typing = node('div', 'message-bubble message-typing');
  typing.setAttribute('aria-hidden', 'true');
  typing.append(node('span'), node('span'), node('span'));
  stack.insertBefore(typing, stack.querySelector('.mentor-recommendation'));
}

function removeTyping(stack) {
  for (const typing of stack.querySelectorAll('.message-typing')) typing.remove();
}

async function appendReplyPart(stack, text, keepWaiting = () => false) {
  removeTyping(stack);
  const follow = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 64;
  stack.insertBefore(messageBubble(text, true), stack.querySelector('.mentor-recommendation'));
  if (follow) scrollLatest(true);
  if (keepWaiting()) appendTyping(stack);
}

function scrollLatest(force = false) {
  const list = ui.messages;
  if (force || list.scrollHeight - list.scrollTop - list.clientHeight < 150) list.scrollTop = list.scrollHeight;
}

function renderChat(messages = [], loading = false, { preserveScroll = false } = {}) {
  const scrollTop = ui.messages.scrollTop;
  const followLatest = ui.messages.scrollHeight - scrollTop - ui.messages.clientHeight < 150;
  const empty = ui['chat-empty'];
  const recommendation = state.mentorRecommendation;
  const rows = messages.map(message => {
    const { row, stack } = chatMessage(message.role, message.text ?? message.content ?? '', false, message.parts);
    if (message.role === 'assistant' && message.id && recommendation?.sessionId === state.sessionId && recommendation.messageId === message.id) {
      appendMentorRecommendation(stack, recommendation.mentor);
    }
    return row;
  });
  if (empty) {
    empty.hidden = Boolean(rows.length);
    put('chat-empty-title', loading ? '正在加载会话…' : !state.agents.length ? '创建第一个角色' : (state.childId ? `和${agent()?.name || 'Agent'}聊聊` : '选择用户，开始试聊'));
    put('chat-empty-description', loading ? '' : !state.agents.length ? '点击“创建角色”，填写名称和角色设定。' : (state.childId ? '发一条消息，就可以开始这次对话。' : '右上角可以创建一个用户，填写姓名、年龄和兴趣。'));
    ui.messages.replaceChildren(...rows);
  } else if (rows.length) ui.messages.replaceChildren(...rows);
  else ui.messages.replaceChildren(node('div', 'panel-empty', state.childId ? '发一条消息开始聊天。' : '先选择或创建用户。'));
  if (preserveScroll && !followLatest) ui.messages.scrollTop = scrollTop;
  else scrollLatest(true);
}

function emptyPanel(title, description = '') {
  const element = node('div', 'panel-empty');
  element.append(node('strong', '', title));
  if (description) element.append(node('p', '', description));
  return element;
}

function section(title, content, open = false, count) {
  const details = node('details', 'inspector-section');
  details.open = open;
  const summary = node('summary', '', title);
  if (count !== undefined) summary.append(node('span', 'section-count', String(count)));
  const body = node('div', 'section-body');
  body.append(...(Array.isArray(content) ? content : [content]));
  details.append(summary, body);
  return details;
}

function tokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString('en-US') : '—';
}

function money(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '¥0';
  return value < 0.000001 ? '<¥0.000001' : '¥' + value.toFixed(6);
}

function briefModel(model) {
  if (!model) return '本地';
  if (model.includes('doubao-seed-2-0-mini')) return '豆包 2.0 Mini';
  if (model.includes('doubao-seed-2-1-lite')) return '豆包 2.1 Lite';
  if (model.includes('deepseek-v4-1-flash')) return 'DeepSeek V4.1';
  return model.length > 24 ? model.slice(0, 23) + '…' : model;
}

function usageUncertain(usage) {
  return !usage || usage.missingUsage || usage.unpriced || usage.missingUsageCalls > 0 || usage.unpricedCalls > 0 ||
    (usage.usageStatus && !['reported', 'not_applicable'].includes(usage.usageStatus)) ||
    (usage.pricingStatus && !['estimated', 'not_applicable'].includes(usage.pricingStatus)) ||
    !Number.isFinite(usage.totalCostCny);
}

function knownCost(usage) {
  const values = [usage?.totalCostCny, usage?.knownCostCny].filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function costLabel(usage) {
  if (!usage) return '待统计';
  if (usage.pending) return '统计中';
  const amount = knownCost(usage);
  return usageUncertain(usage) ? amount > 0 ? '≥' + money(amount) : '待估' : money(amount);
}

function compactTokens(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const unit = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1;
  return unit === 1 ? tokenCount(value) : (value / unit).toFixed(1).replace(/\.0$/, '') + (unit === 1_000 ? 'K' : 'M');
}

function usageCoverage(usage) {
  if (!usage) return hasScope() ? '发送消息后显示实际用量。' : '选择用户和角色后显示会话用量。';
  const notes = [
    usage.untrackedTurns > 0 ? `${tokenCount(usage.untrackedTurns)} 轮历史对话未记录用量。` : '',
    usage.missingUsageCalls > 0 ? `${tokenCount(usage.missingUsageCalls)} 次调用未返回完整用量。` : '',
    usage.unpricedCalls > 0 ? `${tokenCount(usage.unpricedCalls)} 次调用暂缺适用价格。` : '',
    usage.untrackedMemoryJobs > 0 ? `${tokenCount(usage.untrackedMemoryJobs)} 次历史记忆整理未记录用量。` : '',
  ].filter(Boolean);
  if (usage.partial && !notes.length) notes.push('仅统计已有用量回执。');
  if (notes.length) notes.push('缺失部分不按零消耗处理。');
  return notes.join(' ');
}

function usageComponentCost(usage, kind) {
  const calls = usage.calls;
  if (!Array.isArray(calls)) return '—';
  const entries = calls.filter(call => call.kind === kind);
  const values = entries.map(call => call.modelCostCny).filter(Number.isFinite);
  const uncertain = values.length !== entries.length;
  const amount = values.reduce((sum, value) => sum + value, 0);
  return uncertain ? amount > 0 ? '≥' + money(amount) : '待估' : money(amount);
}

function usageMetricDetails(usage) {
  const observed = usage?.recordedCalls > 0;
  const partial = Boolean(usage && (usage.partial || usage.untrackedTurns > 0 || usage.untrackedMemoryJobs > 0 || usageUncertain(usage)));
  const coverage = usageCoverage(usage);
  const latest = usage?.latestContext;
  const hasContext = latest && Number.isFinite(latest.inputTokens) && latest.inputTokens >= 0;
  const windowTokens = latest?.contextWindowTokens;
  const percent = hasContext && Number.isFinite(windowTokens) && windowTokens > 0
    ? (latest.inputTokens / windowTokens * 100).toFixed(2) + '%' : '—';
  const amount = knownCost(usage);
  const totalFee = !observed ? '—' : partial ? amount > 0 ? '≥' + money(amount) : '待估' : costLabel(usage);
  const uncertainPlugin = usage?.unpricedCalls > 0 || usage?.missingUsageCalls > 0;
  const pluginFee = !observed ? '—' : uncertainPlugin
    ? usage.toolCostCny > 0 ? '≥' + money(usage.toolCostCny) : '待估' : money(usage.toolCostCny);
  const snapshots = [...new Set((usage?.calls || []).map(call => call.asOf).filter(Boolean))];
  const rates = [...new Set((usage?.calls || []).filter(call => call.model && call.rates).map(call => {
    const rate = call.rates;
    return `${briefModel(call.model)}：输入/缓存/输出 ¥${rate.inputPerMillion}/${rate.cachedInputPerMillion}/${rate.outputPerMillion} / 百万 tokens`;
  }))];
  const priceNotes = [...new Set((usage?.calls || []).map(call => call.basis).filter(Boolean))];
  return [
    { key: 'context', title: '当前上下文', value: percent, partial: Boolean(usage && !hasContext),
      rows: [['最近输入', hasContext ? tokenCount(latest.inputTokens) + ' tokens' : '未记录'],
        ['模型窗口', tokenCount(windowTokens) + ' tokens'], ['预留输出', tokenCount(latest?.outputReserveTokens) + ' tokens'],
        ['模型', latest?.model || '—']],
      note: hasContext ? '最近一次已记录的聊天请求输入，占用率不包含预留输出，也不是会话累计用量。' : coverage || '发送消息后显示最近一次聊天请求的实际上下文。' },
    { key: 'tokens', title: '本会话 Token', value: observed ? compactTokens(usage.totalTokens) : '—', partial,
      rows: [['合计', observed ? tokenCount(usage.totalTokens) : '—'], ['输入', observed ? tokenCount(usage.inputTokens) : '—'],
        ['输出', observed ? tokenCount(usage.outputTokens) : '—'], ['缓存命中', observed ? tokenCount(usage.cachedTokens) : '—'],
        ['推理输出', observed ? tokenCount(usage.reasoningTokens) : '—'],
        ['统计范围', observed ? `${tokenCount(usage.recordedCalls)} 次已记录模型调用` : '尚无用量回执']],
      note: [coverage, observed ? '包含聊天、工具和后台整理的模型调用。缓存与推理已包含在输入和输出中。' : ''].filter(Boolean).join(' ') },
    { key: 'cost', title: '本会话费用预估', value: totalFee, partial,
      rows: [['合计', totalFee], ['聊天模型', observed ? usageComponentCost(usage, 'chat') : '—'],
        ['搜索模型', observed ? usageComponentCost(usage, 'search') : '—'], ['记忆模型', observed ? usageComponentCost(usage, 'memory') : '—'],
        ...(usage?.calls?.some(call => call.kind === 'mentor_trigger')
          ? [['语义工具触发判断', usageComponentCost(usage, 'mentor_trigger')]] : []),
        ...(usage?.calls?.some(call => call.kind === 'mentor_decision')
          ? [['导师推荐判定', usageComponentCost(usage, 'mentor_decision')]] : []),
        ...(usage?.calls?.some(call => call.kind === 'mentor_history_review')
          ? [['导师推荐记录复核', usageComponentCost(usage, 'mentor_history_review')]] : []),
        ...(usage?.calls?.some(call => call.kind === 'context_brief')
          ? [['历史概括整理', usageComponentCost(usage, 'context_brief')]] : []),
        ['联网等插件', pluginFee]],
      note: [coverage, '模型与插件费用均已计入合计。按实际用量及适用刊例价预估，未扣免费额度、优惠或折扣，最终以方舟账单为准。',
        snapshots.length ? '价格快照 ' + snapshots.join('、') + '。' : '', ...rates, ...priceNotes].filter(Boolean).join('\n') },
  ];
}

function usageIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const shapes = kind === 'context' ? [['path', { d: 'M5 18a9 9 0 1 1 14 0M12 3v2M5.6 7.1l1.5 1.5M18.4 7.1l-1.5 1.5M12 12l3-3M8 20h8' }], ['circle', { cx: '12', cy: '12', r: '1' }]]
    : kind === 'tokens' ? [['path', { d: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5' }]]
      : [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'm8.5 7 3.5 5L15.5 7M12 12v6M8.5 12h7M8.5 15h7' }]];
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}

function hideUsageTooltip(footer) {
  clearTimeout(footer.closeTimer);
  footer.closeTimer = null;
  footer.active?.removeAttribute('aria-describedby');
  footer.active = null;
  if (footer.tooltip) footer.tooltip.hidden = true;
}

function scheduleUsageTooltipClose(footer) {
  clearTimeout(footer.closeTimer);
  footer.closeTimer = setTimeout(() => {
    footer.closeTimer = null;
    const focused = [...footer.buttons.values()].includes(document.activeElement);
    if (!footer.pinned && !footer.hovered && !footer.tooltipHovered && !focused) hideUsageTooltip(footer);
  }, 120);
}

function positionUsageTooltip(footer) {
  if (!footer.active || !footer.tooltip || footer.tooltip.hidden) return;
  const anchor = footer.active.getBoundingClientRect();
  const bounds = footer.tooltip.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  const left = Math.max(12, Math.min(anchor.left + anchor.width / 2 - bounds.width / 2, width - bounds.width - 12));
  const above = anchor.top - bounds.height - 10;
  const top = Math.max(12, Math.min(above >= 12 ? above : anchor.bottom + 10, height - bounds.height - 12));
  footer.tooltip.style.left = Math.round(left) + 'px';
  footer.tooltip.style.top = Math.round(top) + 'px';
}

function showUsageTooltip(footer, button) {
  clearTimeout(footer.closeTimer);
  footer.closeTimer = null;
  const tooltip = footer.tooltip;
  const detail = button._usageDetail;
  if (!tooltip || !detail) return;
  if (footer.active !== button) footer.active?.removeAttribute('aria-describedby');
  footer.active = button;
  const signature = JSON.stringify(detail);
  if (footer.signature !== signature) {
    const rows = node('div', 'usage-tooltip-rows');
    for (const [label, value] of detail.rows) {
      const row = node('div', 'usage-tooltip-row');
      row.append(node('span', '', label), node('span', '', value));
      rows.append(row);
    }
    tooltip.replaceChildren(node('p', 'usage-tooltip-title', detail.title), rows, node('p', 'usage-tooltip-note', detail.note));
    footer.signature = signature;
  }
  button.setAttribute('aria-describedby', tooltip.id);
  tooltip.hidden = false;
  positionUsageTooltip(footer);
}

function usageFooter(target) {
  if (target._usageFooter) return target._usageFooter;
  const footer = { tooltip: document.getElementById('usage-tooltip'), buttons: new Map(), active: null, pinned: null, hovered: null, tooltipHovered: false, closeTimer: null };
  for (const key of ['context', 'tokens', 'cost']) {
    const button = node('button', 'usage-indicator');
    button.type = 'button';
    button.dataset.metric = key;
    button.append(usageIcon(key), node('span', 'usage-indicator-value', '—'));
    button.addEventListener('pointerenter', () => {
      footer.hovered = button;
      if (!footer.pinned) showUsageTooltip(footer, button);
    });
    button.addEventListener('pointerleave', () => {
      footer.hovered = null;
      scheduleUsageTooltipClose(footer);
    });
    button.addEventListener('focus', () => { if (!footer.pinned) showUsageTooltip(footer, button); });
    button.addEventListener('blur', () => scheduleUsageTooltipClose(footer));
    button.addEventListener('click', () => {
      if (footer.pinned === button) {
        footer.pinned = null;
        hideUsageTooltip(footer);
      } else {
        footer.pinned = button;
        showUsageTooltip(footer, button);
      }
    });
    footer.buttons.set(key, button);
  }
  footer.tooltip?.addEventListener('pointerenter', () => {
    footer.tooltipHovered = true;
    clearTimeout(footer.closeTimer);
    footer.closeTimer = null;
  });
  footer.tooltip?.addEventListener('pointerleave', () => {
    footer.tooltipHovered = false;
    scheduleUsageTooltipClose(footer);
  });
  const dismiss = () => { footer.pinned = null; hideUsageTooltip(footer); };
  document.addEventListener('pointerdown', event => {
    if (!target.contains(event.target) && !footer.tooltip?.contains(event.target)) dismiss();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') dismiss(); });
  window.addEventListener('resize', dismiss);
  window.addEventListener('scroll', event => { if (!footer.tooltip?.contains(event.target)) dismiss(); }, true);
  target.replaceChildren(...footer.buttons.values());
  target._usageFooter = footer;
  return footer;
}

function renderUsage(usage) {
  state.sessionUsage = usage || null;
  const target = ui['session-usage'];
  if (!target) return;
  const footer = usageFooter(target);
  if (!usage) { footer.pinned = null; hideUsageTooltip(footer); }
  for (const detail of usageMetricDetails(usage)) {
    const button = footer.buttons.get(detail.key);
    button._usageDetail = detail;
    button.classList.toggle('is-partial', detail.partial);
    button.querySelector('.usage-indicator-value').textContent = detail.value;
    button.setAttribute('aria-label', `${detail.title} ${detail.value}，查看详情`);
    if (!footer.tooltip) button.title = [detail.title, ...detail.rows.map(([label, value]) => label + '：' + value), detail.note].filter(Boolean).join('\n');
  }
  if (footer.active) showUsageTooltip(footer, footer.active);
}

function toolUsageSummary(calls) {
  if (!calls.length) return null;
  const values = calls.map(call => call.usage).filter(Boolean);
  const models = [...new Set(values.map(value => value.model).filter(Boolean))];
  const text = node('span', 'tool-usage-inline');
  const model = models.length > 1 ? models.length + ' 个模型' : models.length ? briefModel(models[0]) : values.length ? '本地' : '用量未记录';
  const pending = values.some(value => value.pending);
  const missing = values.length !== calls.length || values.some(usageUncertain);
  const costs = values.map(knownCost).filter(Number.isFinite);
  const amount = costs.reduce((total, value) => total + value, 0);
  text.append(node('span', 'tool-usage-model', model), node('span', 'tool-usage-fee', pending ? '统计中' : missing ? amount > 0 ? '≥' + money(amount) : '待估' : money(amount)));
  text.title = models.length ? models.join('\n') + '\n工具费用为预估，已计入下方会话合计。' : '本地工具不产生额外外部调用费；相关聊天模型用量计入下方会话统计。';
  return text;
}

function toolCallSection(calls, open = false) {
  const body = calls.length ? node('div', 'tool-call-list') : node('p', 'quiet', '本轮未调用工具。');
  for (const call of calls) {
    const item = node('div', 'tool-call-item');
    const header = node('div', 'tool-call-header');
    header.append(node('code', 'tool-call-name', call.name || '工具'));
    const usage = call.usage;
    if (usage) {
      const meta = node('span', 'tool-call-meta', briefModel(usage.model) + ' · ' + costLabel(usage));
      meta.title = [usage.model || '本地执行，无额外外部调用费；聊天模型费用计入会话统计',
        usage.basis, usage.asOf ? '价格快照 ' + usage.asOf : '', ...(usage.sources || [])].filter(Boolean).join('\n');
      header.append(meta);
    } else header.append(node('span', 'tool-call-meta', '用量未记录'));
    item.append(header);
    if (usage?.model) {
      item.append(node('p', 'tool-call-model', usage.model));
      item.append(node('p', 'tool-call-breakdown', usage.pending ? '等待返回实际用量…'
        : `输入 ${tokenCount(usage.inputTokens)} · 输出 ${tokenCount(usage.outputTokens)} · 模型 ${money(usage.modelCostCny)} · 插件 ${money(usage.toolCostCny)}`));
    } else if (usage) item.append(node('p', 'tool-call-breakdown', '本地工具无额外调用费用，相关模型用量计入会话统计'));
    const { usage: ignored, _usageKey: ignoredKey, ...raw } = call;
    if (raw.arguments !== undefined || raw.result !== undefined) item.append(pretty(raw));
    body.append(item);
  }
  const details = section('工具调用', body, open, calls.length);
  details.dataset.section = 'tool-calls';
  const badge = toolUsageSummary(calls);
  if (badge) details.querySelector('summary').append(badge);
  return details;
}

function renderLiveTools() {
  const target = ui['context-content'];
  if (!target || !Array.isArray(state.liveToolCalls)) return;
  const previous = target.querySelector('[data-section="tool-calls"]');
  const next = toolCallSection(state.liveToolCalls, previous?.open ?? true);
  if (previous) previous.replaceWith(next);
  else target.replaceChildren(next);
}

function recordLiveTool(call) {
  if (!call) return;
  state.liveToolCalls ??= [];
  const key = call.id ?? call.index;
  const index = key == null ? -1 : state.liveToolCalls.findIndex(item => item._usageKey === key);
  const item = { name: call.name, usage: call, _usageKey: key };
  if (index >= 0) state.liveToolCalls[index] = item;
  else state.liveToolCalls.push(item);
  renderLiveTools();
}

function printable(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('、') || '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function pretty(data) { return node('pre', 'inspector-code', typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2)); }
function dataGrid(pairs) {
  const grid = node('dl', 'data-grid');
  for (const [label, value] of pairs) {
    if (value == null || value === '') continue;
    grid.append(node('dt', '', label), node('dd', '', printable(value)));
  }
  return grid;
}

const profileLabels = {
  name: '姓名', age: '年龄', interest: '兴趣', interests: '兴趣', initialInterests: '初始兴趣',
  preferredName: '称呼', preferred_name: '称呼', conversationPreferences: '对话偏好',
  conversation_preference: '对话偏好', conversation_preferences: '对话偏好', preferences: '对话偏好',
};

function profileRows(profile) {
  return Object.entries(profile || {}).filter(([key, value]) => profileLabels[key] && value != null && (!Array.isArray(value) || value.length))
    .map(([key, value]) => [profileLabels[key], value]);
}

function overviewText(overview) {
  return typeof overview === 'string' ? overview : overview?.summary || '';
}

function chatOverviewMeta(overview) {
  if (!overview || typeof overview !== 'object' || !overview.mode) return [];
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const counts = count(overview.sourceCount) && count(overview.itemCount)
    ? `${overview.sourceCount} 条长期了解 · ${overview.itemCount} 项默认了解` : '';
  const status = overview.status === 'ready' || overview.mode === 'cached' ? '已去重整理'
    : ['queued', 'running'].includes(overview.status) ? '正在整理，暂用来源原文'
      : overview.status === 'empty' ? '' : '暂用来源原文';
  const deferred = overview.deferredMemoryIds?.length ? `另有 ${overview.deferredMemoryIds.length} 条可按需查询` : '';
  return [counts, status, deferred].filter(Boolean);
}

function contextOverviewBody(overview) {
  const body = node('div', 'overview-body');
  const text = overviewText(overview);
  body.append(text ? node('p', 'overview-copy', text) : node('p', 'quiet', '本轮尚无用户概括。'));
  const meta = chatOverviewMeta(overview);
  if (meta.length) body.append(node('p', 'overview-meta', meta.join(' · ')));
  return body;
}

function renderContext(context) {
  const target = ui['context-content'];
  if (!context) {
    target.replaceChildren(emptyPanel('还没有模型上下文', '发送第一条消息后，这里会显示本轮实际送给模型的内容。'));
    return;
  }
  const open = new Set([...target.querySelectorAll('details[open] > summary')].map(item => item.firstChild?.textContent));
  const first = !target.querySelector('.inspector-section');
  const time = context.localTime;
  const tools = context.tools || [];
  const memories = context.recentMemories || [];
  const events = Array.isArray(context.recentEvents) ? context.recentEvents : null;
  const history = context.history || [];
  const calls = context.toolCalls || [];
  const meta = node('div', 'context-meta');
  meta.append(node('span', 'context-chip', context.model || state.model.name || '聊天模型'));
  if (context.preparedAt) meta.append(node('span', 'context-chip', dateTime(context.preparedAt)));
  if (Number.isFinite(context.firstDeltaMs)) meta.append(node('span', 'context-chip', `首字 ${context.firstDeltaMs} ms`));
  const summaryList = memories.length ? node('ul', 'context-memory-list') : null;
  for (const item of memories) summaryList.append(node('li', '', `${dateLabel(item.mentionedOn)} · ${item.summary}`));
  const eventList = events?.length ? node('ul', 'context-memory-list') : null;
  for (const item of events ?? []) eventList.append(node('li', '', `${dateTime(item.lastMentionedAt)} · ${item.summary}`));
  const toolNames = tools.length ? node('div', 'context-meta') : node('p', 'quiet', '本轮没有开放工具。');
  for (const tool of tools) toolNames.append(node('span', 'context-chip', tool.function?.name || tool.name || String(tool)));
  const sections = [meta,
    section('本轮注入', dataGrid([
      ['当地时间', typeof time === 'string' ? time : [time?.localDate, time?.localTime, time?.timezone].filter(Boolean).join(' ')],
      ...(Number.isInteger(context.recentConversationTurns)
        ? [['最近对话参考', `${context.recentConversationTurns} 轮已结束会话的原文摘录`]] : []),
      ...profileRows(context.userProfile || context.childProfile),
    ]), first || open.has('本轮注入')),
    section('用户概括', contextOverviewBody(context.userOverview), first || open.has('用户概括')),
    ...(events ? [section('近期经历与计划', eventList ?? node('p', 'quiet', '本轮还没有已整理的经历与计划。'), open.has('近期经历与计划'), events.length)] : []),
    ...(summaryList ? [section('历史上下文中的摘要', summaryList, open.has('历史上下文中的摘要'), memories.length)] : []),
    section('记忆加载', node('p', 'quiet', '具体记忆由聊天 Agent 按话题搜索；实际读入内容见下方工具调用和原始模型输入。'), open.has('记忆加载')),
    section('固定提示词', pretty(context.system || ''), open.has('固定提示词')),
    section('会话消息', pretty(history), open.has('会话消息'), history.length),
    section('可用工具', [toolNames, ...(tools.length ? [pretty(tools)] : [])], open.has('可用工具'), tools.length),
    toolCallSection(calls, open.has('工具调用')),
    section('原始模型输入', [...(context.recentConversationTurns ? [node('p', 'quiet', '近期对话摘录已计入本轮输入，审计记录保留注入轮数。')] : []), pretty(context.requestMessages || []), ...(context.modelRequests?.length ? [
      node('p', 'inspector-label', '模型请求统计'), pretty(context.modelRequests),
    ] : [])], open.has('原始模型输入')),
  ];
  target.replaceChildren(...sections);
}

const detailLabels = {
  occurredAt: '发生时间', plannedAt: '计划时间', place: '地点', event: '事情', sequence: '经过', notes: '补充',
};
const memoryStateLabels = { active: '活跃', archived: '归档', retracted: '已撤回' };
const memoryKindLabels = { understanding: '长期了解', event: '经历与计划' };

function detailContent(detail) {
  return typeof detail === 'string' ? node('p', '', detail)
    : dataGrid(Object.entries(detail || {}).map(([key, value]) => [detailLabels[key] || key, value]));
}

function evidenceContent(entry) {
  const sourceIds = entry.sourceMessageIds || entry.sourceIds || [];
  if (!sourceIds.length && !entry.anchorMessageId) return null;
  return section('来源消息', dataGrid([
    ['锚点消息', entry.anchorMessageId], ['来源 ID', sourceIds],
  ]));
}

function renderDetail(container, item) {
  const detail = item?.detail;
  const content = [node('p', 'memory-current-summary', item?.summary || ''), dataGrid([
    ['状态', memoryStateLabels[item?.state] || '活跃'], ['类型', memoryKindLabels[item?.kind]],
    ['最近实际提及', dateTime(item?.lastMentionedAt || item?.mentionedAt)],
    ['归档时间', dateTime(item?.archivedAt)], ['撤回时间', dateTime(item?.retractedAt)],
    ['版本', item?.version],
  ])];
  if (item?.retractionReason) content.push(node('p', 'memory-withdrawal', `撤回依据：${item.retractionReason}`));
  if (detail && (typeof detail === 'string' || Object.keys(detail).length)) {
    content.push(section('初始详情', [node('p', 'quiet', '保留的原始记录；当前情况以上方摘要和后续变化为准。'), detailContent(detail)]));
  }
  const changes = item?.detailChanges || [];
  if (changes.length) {
    const list = node('div', 'memory-change-list');
    for (const change of [...changes].reverse()) {
      const record = node('div', 'memory-change');
      record.append(node('p', 'inspector-label', `${change.changeType === 'correction' ? '更正' : '补充'} · ${dateTime(change.mentionedAt || change.at)}`),
        detailContent(change.detailDelta || change.delta || {}));
      const evidence = evidenceContent(change);
      if (evidence) record.append(evidence);
      list.append(record);
    }
    content.push(section('详情变化', list, true, changes.length));
  }
  const history = item?.summaryHistory || [];
  if (history.length) {
    const list = node('div', 'memory-change-list');
    for (const entry of [...history].reverse()) {
      const record = node('div', 'memory-change');
      record.append(node('p', 'quiet', dateTime(entry.supersededAt || entry.at)), node('p', '', entry.summary || ''));
      list.append(record);
    }
    content.push(section('历史摘要', [node('p', 'quiet', '以下为已被更新的旧摘要。'), list], false, history.length));
  }
  const mentions = item?.mentions || item?.mentionHistory || [];
  if (mentions.length) {
    const list = node('div', 'memory-change-list');
    for (const entry of [...mentions].sort((a, b) => Date.parse(b.mentionedAt || b.at || '') - Date.parse(a.mentionedAt || a.at || ''))) {
      const record = node('div', 'memory-change');
      record.append(node('p', 'quiet', dateTime(entry.mentionedAt || entry.at)));
      const source = evidenceContent(entry);
      if (source) record.append(source);
      list.append(record);
    }
    content.push(section('实际提及记录', list, false, mentions.length));
  }
  if (!detail && !changes.length) content.push(node('p', 'quiet', '这条记忆只有摘要。'));
  const evidence = evidenceContent(item || {});
  if (evidence) content.push(evidence);
  container.replaceChildren(...content);
}

function memoryItem(item, scope) {
  const details = node('details', 'memory-item');
  details.open = state.memoryOpen.has(item.memoryId);
  const summary = node('summary', 'memory-item-summary');
  const meta = node('span', 'memory-item-meta');
  meta.append(node('span', 'memory-kind', memoryKindLabels[item.kind] || '记忆'));
  const mentioned = dateTime(item.lastMentionedAt || item.mentionedAt);
  if (mentioned) meta.append(node('span', '', `最近提及 ${mentioned}`));
  summary.append(meta, node('span', 'memory-item-copy', item.summary));
  const body = node('div', 'memory-detail');
  details.append(summary, body);
  let loading = false;
  const cacheKey = `${item.memoryId}\u0000${item.version ?? 'legacy'}`;
  const scopeVersion = state.scopeVersion;
  const load = async () => {
    if (state.memoryDetails.has(cacheKey)) {
      renderDetail(body, state.memoryDetails.get(cacheKey));
      return;
    }
    if (loading) return;
    loading = true;
    body.replaceChildren(node('p', 'quiet', '正在读取详情…'));
    try {
      const result = await api(scoped(`/api/memory/${encodeURIComponent(item.memoryId)}`, scope));
      if (!body.isConnected || state.scopeVersion !== scopeVersion) return;
      state.memoryDetails.set(`${item.memoryId}\u0000${result.item?.version ?? item.version ?? 'legacy'}`, result.item);
      renderDetail(body, result.item);
    } catch (error) {
      body.replaceChildren(node('p', 'quiet', error.message));
    } finally { loading = false; }
  };
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) { state.memoryOpen.add(item.memoryId); void load(); }
    else state.memoryOpen.delete(item.memoryId);
  });
  if (details.open) queueMicrotask(load);
  return details;
}

function renderMemory(data) {
  const target = ui['memory-content'];
  if (!hasScope()) {
    state.memoryData = null;
    target.replaceChildren(emptyPanel('先选择用户和 Agent', '这里只显示这位用户与当前角色之间保存的记忆。'));
    return;
  }
  state.memoryData = data;
  const signature = JSON.stringify([data, state.memoryFilter]);
  if (signature === state.memorySignature) return;
  state.memorySignature = signature;
  const open = new Set([...target.querySelectorAll('.inspector-section[open] > summary')].map(item => item.firstChild?.textContent));
  const first = !target.querySelector('.inspector-section');
  const { childProfile = {}, userProfile = childProfile, soulProfile = {} } = data.profile || {};
  const overview = data.overview || {};
  const chatOverview = data.chatOverview && typeof data.chatOverview === 'object' ? data.chatOverview : null;
  const projectedOverview = chatOverview?.mode ? chatOverview : null;
  const displayedOverview = chatOverview || overview;
  const overviewBody = node('div', 'overview-body');
  overviewBody.append(overviewText(displayedOverview) ? node('p', 'overview-copy', overviewText(displayedOverview))
    : node('p', 'quiet', '还没有用户概括。会话结束后的记忆整理会维护长期了解。'));
  const overviewMeta = projectedOverview ? [...chatOverviewMeta(projectedOverview),
    projectedOverview.generatedAt ? `整理于 ${dateTime(projectedOverview.generatedAt)}` : ''].filter(Boolean)
    : [overview.updatedAt ? `更新于 ${dateTime(overview.updatedAt)}` : '',
      overview.version != null ? `版本 ${overview.version}` : '',
      overview.memoryIds?.length ? `${overview.memoryIds.length} 条记忆依据` : ''].filter(Boolean);
  if (overviewMeta.length) overviewBody.append(node('p', 'overview-meta', overviewMeta.join(' · ')));
  if (projectedOverview) {
    overviewBody.append(node('p', 'quiet', '只整理传入聊天的概括，原记忆保留。'));
    const sourceBody = node('div', 'overview-body');
    const sourceRecords = chatOverview.sourceRecords;
    const sourceText = Array.isArray(sourceRecords) ? sourceRecords.map(record => record.summary).join('\n') : overviewText(overview);
    sourceBody.append(sourceText ? node('p', 'overview-copy', sourceText)
      : node('p', 'quiet', '当前没有有效的长期了解来源。'));
    const sourceCount = Array.isArray(sourceRecords) ? sourceRecords.length : overview.memoryIds?.length;
    if (sourceCount) sourceBody.append(node('p', 'overview-meta', `${sourceCount} 条长期了解原文`));
    overviewBody.append(section('概括来源原文', sourceBody, open.has('概括来源原文')));
  }
  const content = [section('用户概括', overviewBody, first || open.has('用户概括'))];
  const profileBody = [node('p', 'inspector-label', '基础资料'),
    dataGrid(profileRows(userProfile).length ? profileRows(userProfile) : profileRows(child()))];
  if (profileRows(soulProfile).length) profileBody.push(node('p', 'inspector-label', '角色专属资料'), dataGrid(profileRows(soulProfile)));
  content.push(section('用户资料', profileBody, open.has('用户资料')));
  const jobs = data.jobs || [];
  const activity = jobs.find(item => ['queued', 'pending', 'running', 'processing'].includes(item.status)) || jobs[0];
  if (activity && statusLabels[activity.status]) {
    const validationFailed = Array.isArray(activity.output?.validationFailures) && activity.output.validationFailures.length > 0;
    const repaired = Boolean(activity.output?.stages?.repair);
    const running = ['running', 'processing'].includes(activity.status);
    const succeeded = ['complete', 'completed', 'committed', 'done', 'succeeded'].includes(activity.status);
    const status = running && validationFailed ? '校验未通过，正在修正一次…'
      : succeeded && repaired ? '已整理（已修正）'
        : activity.status === 'failed' && repaired ? '整理失败（已修正一次）' : statusLabels[activity.status];
    content.push(node('p', `memory-status ${activity.status === 'failed' ? 'is-error' : ''}`, status));
    if (activity.status === 'failed' && validationFailed) content.push(node('p', 'quiet', '校验失败最多修正一次；未通过校验的结果不会写入记忆。'));
    if (activity.status === 'failed' && activity.error) content.push(node('p', 'quiet', activity.error));
    if (activity.status === 'failed') {
      const retry = node('button', 'memory-filter', '重新整理这段会话');
      retry.type = 'button';
      retry.title = '手动重新整理会新发一次提取；校验失败时最多再修正一次，均按实际用量计费，已有聊天保留。';
      retry.addEventListener('click', async () => {
        const scope = selectedScope();
        const version = state.scopeVersion;
        retry.disabled = true;
        retry.textContent = '正在提交…';
        try {
          await api(`/api/memory/jobs/${encodeURIComponent(activity.sessionId)}/retry`, scope);
          if (version === state.scopeVersion) await refreshMemory();
        } catch (error) {
          if (version === state.scopeVersion) show('app-error', error.message);
        } finally {
          retry.disabled = false;
          retry.textContent = '重新整理这段会话';
        }
      });
      content.push(retry);
    }
  }
  const items = data.items || [];
  const currentKeys = new Set(items.map(item => `${item.memoryId}\u0000${item.version ?? 'legacy'}`));
  for (const key of state.memoryDetails.keys()) if (!currentKeys.has(key)) state.memoryDetails.delete(key);
  const counts = { active: 0, archived: 0, retracted: 0, ...data.counts };
  if (!data.counts) for (const item of items) counts[item.state || 'active'] = (counts[item.state || 'active'] || 0) + 1;
  const filters = node('div', 'memory-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', '记忆状态');
  for (const key of ['active', 'archived', 'retracted']) {
    const button = node('button', 'memory-filter', `${memoryStateLabels[key]} ${counts[key]}${key === 'active' ? `/${counts.activeLimit || 500}` : ''}`);
    button.type = 'button';
    button.dataset.state = key;
    button.setAttribute('aria-pressed', String(state.memoryFilter === key));
    button.addEventListener('click', () => {
      if (state.memoryFilter === key) return;
      state.memoryFilter = key;
      renderMemory(state.memoryData || data);
      target.querySelector(`.memory-filter[data-state="${key}"]`)?.focus({ preventScroll: true });
    });
    filters.append(button);
  }
  content.push(filters);
  if (state.memoryFilter === 'retracted') content.push(node('p', 'quiet memory-filter-note', '已撤回内容仅供检查，不会进入聊天记忆搜索。'));
  const filtered = items.filter(item => (item.state || 'active') === state.memoryFilter);
  const groups = new Map();
  for (const item of filtered) {
    const key = item.mentionedOn || (item.lastMentionedAt || item.mentionedAt || '').slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  if (!groups.size) {
    const descriptions = {
      active: ['还没有活跃记忆', '会话结束后在后台提取，新内容会出现在这里。'],
      archived: ['还没有归档记忆', '活跃记忆超过 500 条时，最久未实际提及的记录会转入这里，仍可按需查询。'],
      retracted: ['还没有已撤回记忆', '明确撤回的错记或要求忘记的内容会在这里留存检查状态。'],
    };
    content.push(emptyPanel(...descriptions[state.memoryFilter]));
  }
  const scope = selectedScope();
  for (const [day, memories] of [...groups.entries()].sort(([a], [b]) => b.localeCompare(a))) {
    const group = node('section', 'memory-group');
    group.append(node('h3', '', `${dateLabel(day)} · 最近提及`), ...memories
      .sort((a, b) => Date.parse(b.lastMentionedAt || b.mentionedAt || '') - Date.parse(a.lastMentionedAt || a.mentionedAt || ''))
      .map(item => memoryItem(item, scope)));
    content.push(group);
  }
  target.replaceChildren(...content);
}

async function refreshMemory() {
  if (!hasScope()) { renderMemory({}); return; }
  const version = state.scopeVersion;
  const data = await api(scoped('/api/memory'));
  if (version !== state.scopeVersion) return;
  const updated = data.profile?.userProfile || data.profile?.childProfile;
  const current = child();
  if (updated && current && (updated.name !== current.name || updated.age !== current.age)) {
    Object.assign(current, { name: updated.name, age: updated.age });
    optionList(ui['child-select'], state.children, state.childId, item => item.name, '选择用户');
  }
  renderMemory(data);
}

async function refreshSessions(preferred = state.sessionId) {
  const version = state.scopeVersion;
  const data = await api(scoped('/api/sessions'));
  if (version !== state.scopeVersion) return false;
  state.sessions = data.sessions || [];
  state.sessionId = state.sessions.find(item => item.id === preferred)?.id
    || state.sessions.find(item => item.status === 'open')?.id || state.sessions[0]?.id || '';
  renderSelectors();
  saveSelection();
  return true;
}

async function openSession(id) {
  const version = ++state.sessionVersion;
  clearMentorArrival();
  state.sessionId = id || '';
  state.conversation = null;
  state.liveToolCalls = null;
  state.mentorRecommendation = null;
  renderUsage(null);
  if (id) renderChat([], true);
  else { renderChat(); renderContext(null); return; }
  renderContext(null);
  renderSelectors();
  saveSelection();
  const data = await api(scoped(`/api/sessions/${encodeURIComponent(id)}`));
  if (version !== state.sessionVersion) return;
  state.conversation = data;
  renderUsage(data.usage);
  renderChat(data.messages || []);
  renderContext(data.context);
  updateControls();
}

async function changeScope(preferred = '') {
  workspaceClient?.abortChat();
  ++state.scopeVersion;
  ++state.sessionVersion;
  clearMentorArrival();
  state.sessionId = '';
  state.sessions = [];
  state.conversation = null;
  state.liveToolCalls = null;
  state.mentorRecommendation = null;
  renderUsage(null);
  state.memorySignature = null;
  state.memoryOpen.clear();
  state.memoryDetails.clear();
  state.memoryData = null;
  state.memoryFilter = 'active';
  ui['chat-input'].value = '';
  fitComposer();
  renderSelectors();
  renderChat();
  renderContext(null);
  ui['memory-content'].replaceChildren(emptyPanel(hasScope() ? '正在读取记忆…' : '先选择用户和 Agent'));
  if (!hasScope()) { saveSelection(); renderMemory({}); return; }
  const [sessionLoaded] = await Promise.all([refreshSessions(preferred), refreshMemory()]);
  if (sessionLoaded) await openSession(state.sessionId);
  if (workspaceClient) {
    const scopeVersion = state.scopeVersion;
    const draft = await workspaceClient.draftForScope();
    if (scopeVersion === state.scopeVersion && draft?.text) {
      ui['chat-input'].value = draft.text;
      fitComposer();
    }
  }
}

async function createSession() {
  const result = await api('/api/sessions', selectedScope());
  const id = result.session.id;
  await Promise.all([refreshSessions(id), refreshMemory()]);
  await openSession(id);
  return id;
}

async function refreshUsage() {
  if (!hasScope() || !state.sessionId) return;
  const scopeVersion = state.scopeVersion;
  const sessionVersion = state.sessionVersion;
  const sessionId = state.sessionId;
  const data = await api(scoped(`/api/sessions/${encodeURIComponent(sessionId)}`));
  if (scopeVersion !== state.scopeVersion || sessionVersion !== state.sessionVersion || sessionId !== state.sessionId ||
      state.sending || state.busy || state.pendingMessages.length) return;
  if (state.conversation) state.conversation.usage = data.usage;
  renderUsage(data.usage);
}

async function runAction(action) {
  if (state.busy || state.editorSaving || state.sending || state.pendingMessages.length) return;
  show('app-error', '');
  state.busy = true;
  updateControls();
  try { await action(); }
  catch (error) { show('app-error', error.message); }
  finally { state.busy = false; updateControls(); }
}

function selectAgent(id, mentor = null) {
  return runAction(async () => {
    const offer = state.mentorRecommendation;
    if (mentor && (offer?.mentor !== mentor || offer.sessionId !== state.sessionId)) return;
    const target = mentor ? availableMentor(id) : state.agents.find(item => item.id === id);
    if (!target) return;
    const source = mentor && agent();
    const childId = state.childId;
    const nextScopeVersion = state.scopeVersion + 1;
    state.agentId = id;
    await changeScope();
    if (source && state.authenticated && state.scopeVersion === nextScopeVersion &&
        agent()?.id === id && state.childId === childId &&
        (!state.sessionId || state.conversation?.session?.id === state.sessionId)) {
      showMentorArrival(source, target, mentor);
    }
  });
}

async function readStream(response, onEvent) {
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `消息发送失败 (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let events = [];
  const processLine = line => {
    if (!line) {
      if (events.length) onEvent(JSON.parse(events.join('\n')));
      events = [];
    } else if (line.startsWith('data:')) events.push(line.slice(5).trimStart());
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        processLine(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
      if (done) break;
    }
    if (buffer) processLine(buffer.replace(/\r$/, ''));
    processLine('');
  } finally { await reader.cancel().catch(() => {}); }
}

async function queueMessage() {
  const input = ui['chat-input'];
  const text = input.value.trim();
  if (!text || state.sending || state.busy || state.queueSaving || !hasScope() || audienceBlocked() || state.conversation?.session?.status === 'closed') return;
  if (!state.model.configured && state.model.mode !== 'demo') {
    show('app-error', '聊天模型尚未配置，请先在本机服务设置凭据。');
    return;
  }
  const chars = state.pendingMessages.reduce((total, { message }) => total + message.text.length + 1, text.length);
  if (state.pendingMessages.length >= maxBatchMessages || chars > maxBatchChars) {
    show('app-error', '这轮消息已排满，等回复后再发送这一条。');
    return;
  }
  const message = { text, createdAt: new Date().toISOString() };
  if (workspaceClient) {
    state.queueSaving = true;
    updateControls();
    clearTimeout(state.pendingTimer);
    try {
      await workspaceClient.saveOutbox({ body: { ...selectedScope(), sessionId: state.sessionId, messages: [...state.pendingMessages.map(item => item.message), message] }, assistant: '', startedAt: Date.now(), dispatched: false });
      await workspaceClient.saveDraft(null);
    } catch (error) {
      show('app-error', `消息尚未发送：${error.message}`);
      if (state.pendingMessages.length) state.pendingTimer = setTimeout(requestReply, sendPauseMs);
      return;
    } finally { state.queueSaving = false; updateControls(); }
    if (!state.authenticated) return;
  }
  const { row } = chatMessage('user', text, true);
  state.pendingMessages.push({ message, row });
  if (ui['chat-empty']) ui['chat-empty'].hidden = true;
  ui.messages.append(row);
  scrollLatest(true);
  input.value = '';
  fitComposer();
  show('app-error', '');
  clearTimeout(state.pendingTimer);
  state.pendingTimer = setTimeout(requestReply, sendPauseMs);
  updateControls();
  input.focus();
}

async function requestReply() {
  const batch = state.pendingMessages;
  state.pendingMessages = [];
  state.pendingTimer = null;
  if (!batch.length) return;
  state.sending = true;
  clearMentorRecommendation();
  state.liveToolCalls = [];
  renderLiveTools();
  show('app-error', '');
  put('chat-status', `${agent()?.name || 'Agent'}正在回复…`);
  updateControls();
  const input = ui['chat-input'];
  const reply = chatMessage('assistant');
  appendTyping(reply.stack);
  ui.messages.append(reply.row);
  scrollLatest(true);
  let id = state.sessionId;
  let began = false;
  let done = false;
  let streamEnded = false;
  let presentation = Promise.resolve();
  let presentationError;
  const receivedParts = new Set();
  const receivedPartTexts = [];
  try {
    const requestId = newRequestId();
    const body = { ...selectedScope(), sessionId: id, requestId, messages: batch.map(({ message }) => message) };
    const scopeVersion = state.scopeVersion;
    let text = '';
    const onEvent = event => {
      if (scopeVersion !== state.scopeVersion || !state.authenticated) return;
      if (event.type === 'mentor_recommendation') {
        if (!began || streamEnded || event.sessionId !== id || state.mentorRecommendation) return;
        if (appendMentorRecommendation(reply.stack, event.mentor)) {
          state.mentorRecommendation = { sessionId: id, mentor: event.mentor };
          scrollLatest();
        }
        return;
      }
      if (event.type === 'start' && event.sessionId && event.sessionId !== id) {
        renderUsage(null);
        renderChat();
        if (ui['chat-empty']) ui['chat-empty'].hidden = true;
        ui.messages.append(...batch.map(({ row }) => row), reply.row);
        scrollLatest(true);
      }
      if (event.sessionId) id = event.sessionId;
      if (event.type === 'start') began = true;
      if (event.type === 'usage' && (!event.sessionId || event.sessionId === id)) renderUsage(event.usage);
      if (event.type === 'tool_usage' && (!event.sessionId || event.sessionId === id)) {
        recordLiveTool(event.call);
        if (event.usage) renderUsage(event.usage);
      }
      if (event.type === 'delta' && typeof event.text === 'string') text += event.text;
      if (event.type === 'reply_part' && Number.isInteger(event.index) && event.index >= 0 &&
          typeof event.text === 'string' && event.text.trim() && !receivedParts.has(event.index)) {
        receivedParts.add(event.index);
        receivedPartTexts.push(event.text);
        presentation = presentation.then(() => appendReplyPart(reply.stack, event.text, () => !streamEnded))
          .catch(error => { presentationError ??= error; });
      }
      if (event.type === 'tool_status') {
        if (event.status === 'running') put('chat-status', event.label || `${agent()?.name || 'Agent'}正在处理…`);
        else if (event.status === 'complete') put('chat-status', `${agent()?.name || 'Agent'}正在回复…`);
      }
      if (event.type === 'done') { done = true; streamEnded = true; }
      if (event.type === 'error') throw new Error(event.message || '本轮回复失败');
    };
    if (workspaceClient) await workspaceClient.chat(body, onEvent);
    else {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await readStream(response, onEvent);
    }
    if (scopeVersion !== state.scopeVersion || !state.authenticated) return;
    if (!done) throw new Error('回复连接中断，请查看会话记录。');
    await presentation;
    if (presentationError) throw presentationError;
    removeTyping(reply.stack);
    put('chat-status', '');
    if (!receivedParts.size && text.trim()) await appendReplyPart(reply.stack, text);
    await Promise.all([refreshSessions(id), refreshMemory()]);
    const data = await api(scoped(`/api/sessions/${encodeURIComponent(id)}`));
    state.conversation = data;
    if (state.mentorRecommendation?.sessionId === id) {
      state.mentorRecommendation.messageId = data.messages?.findLast(message => message.role === 'assistant')?.id;
    }
    state.liveToolCalls = null;
    renderUsage(data.usage);
    renderContext(data.context);
  } catch (error) {
    streamEnded = true;
    await presentation;
    removeTyping(reply.stack);
    if (!state.authenticated) return;
    if (!done) clearMentorRecommendation();
    show('app-error', error.name === 'AbortError' ? '回复已中止，消息草稿与已收到的内容已保留在本机。' : error.message);
    if (workspaceClient) void offerRecovery();
    if (!receivedParts.size) reply.row.remove();
    if (!began) {
      for (const { row } of batch) row.remove();
      input.value = [...batch.map(({ message }) => message.text), input.value].filter(Boolean).join('\n');
      if (!id) renderChat();
    }
    if (id) {
      // Keep an already delivered acknowledgement if recovery is unavailable.
      // Re-render only once a persisted history response has been received.
      try {
        const data = await api(scoped(`/api/sessions/${encodeURIComponent(id)}`));
        state.sessionId = id;
        state.conversation = data;
        state.liveToolCalls = null;
        renderUsage(data.usage);
        const recorded = data.messages || [];
        const lastReply = recorded.findLast(message => message.role === 'assistant');
        if (!receivedParts.size || lastReply?.text?.startsWith(receivedPartTexts.join('\n\n'))) renderChat(recorded);
        renderContext(data.context);
        saveSelection();
      } catch { /* The in-flight reply stays visible until the next successful reload. */ }
    }
  } finally {
    streamEnded = true;
    state.sending = false;
    put('chat-status', '');
    fitComposer();
    updateControls();
    if (state.authenticated && !ui['child-dialog'].open) input.focus();
  }
}

function fitComposer() {
  const input = ui['chat-input'];
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 136)}px`;
}

function installListeners() {
  ui['new-agent'].addEventListener('click', () => void agentEditor.open());
  ui['child-select'].addEventListener('change', () => runAction(async () => {
    state.childId = ui['child-select'].value;
    await changeScope();
  }));
  ui['session-select'].addEventListener('change', () => runAction(() => openSession(ui['session-select'].value)));
  ui['new-session'].addEventListener('click', () => runAction(async () => {
    await createSession();
    ui['chat-input'].focus();
  }));
  ui['new-child'].addEventListener('click', () => {
    ui['child-form'].reset();
    show('child-error', '');
    ui['child-dialog'].showModal();
    ui['child-name'].focus();
  });
  ui['child-cancel'].addEventListener('click', () => ui['child-dialog'].close());
  ui['child-form'].addEventListener('submit', async event => {
    event.preventDefault();
    const submit = ui['child-form'].querySelector('[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true;
    show('child-error', '');
    try {
      const result = await api('/api/children', {
        name: ui['child-name'].value.trim(), age: ui['child-age'].value.trim() === '' ? null : Number(ui['child-age'].value),
        interests: ui['child-interests'].value.split(/[，,、\n]+/).map(item => item.trim()).filter(Boolean),
      });
      state.children.push(result.child);
      state.childId = result.child.id;
      ui['child-dialog'].close();
      await runAction(changeScope);
      ui['chat-input'].focus();
    } catch (error) { show('child-error', error.message); }
    finally { submit.disabled = false; }
  });
  ui['chat-form'].addEventListener('submit', event => { event.preventDefault(); queueMessage(); });
  ui['chat-input'].addEventListener('input', () => {
    fitComposer(); updateControls();
    if (workspaceClient) void workspaceClient.saveDraft({ ...selectedScope(), sessionId: state.sessionId, text: ui['chat-input'].value }).catch(error => show('app-error', error.message));
  });
  ui['chat-input'].addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      queueMessage();
    }
  });
  for (const [button, panel] of [['context-toggle', 'context-panel'], ['memory-toggle', 'memory-panel']]) {
    ui[button]?.addEventListener('click', () => {
      ui[panel]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      ui[panel]?.focus({ preventScroll: true });
    });
  }
}

async function loadState(data, { preferDefaultAgent = false } = {}) {
  const versionChanged = state.dataVersion && state.dataVersion !== data.dataVersion;
  const saved = savedSelection();
  state.dataVersion = data.dataVersion || '';
  state.agents = data.agents || [];
  state.children = data.children || [];
  state.model = data.model || {};
  const defaultAgentId = state.agents.find(item => item.id === 'shen-zhiheng')?.id ||
    state.agents.find(item => item.id === 'lin-xiaoman')?.id ||
    [...defaultAgentIds].find(id => state.agents.some(item => item.id === id)) || state.agents[0]?.id || '';
  state.agentId = (preferDefaultAgent ? defaultAgentId : '') ||
    state.agents.find(item => item.id === saved.agentId)?.id || defaultAgentId;
  state.childId = state.children.find(item => item.id === saved.childId)?.id || state.children[0]?.id || '';
  await changeScope(!versionChanged && saved.agentId === state.agentId && saved.childId === state.childId ? saved.sessionId : '');
}

function publicAgent(selected) { return Boolean(selected?.publicCatalog || selected?.metadata?.publicCatalog); }
function agentPermissions(selected) {
  if (publicAgent(selected)) {
    const own = state.catalogAgents.some(item => item.id === selected.id && item.canManage === true);
    return { canEdit: own, canDelete: own, sourceLabel: own ? '公共角色 · 我创建的' : '公共角色' };
  }
  const builtin = defaultAgentIds.has(selected.id);
  return { canEdit: true, canDelete: Boolean(workspaceClient && !builtin), sourceLabel: builtin ? '内置角色 · 本机编辑' : '仅当前浏览器' };
}

async function refreshCatalogPermissions({ probe = false } = {}) {
  if (!workspaceClient) return false;
  const path = probe && Number.isSafeInteger(state.catalogRevision) ? `/api/catalog?revision=${state.catalogRevision}` : '/api/catalog';
  const catalog = await workspaceClient.catalogRequest(path);
  if (catalog.unchanged === true && catalog.revision === state.catalogRevision) return false;
  if (!Number.isSafeInteger(catalog.revision) || !Array.isArray(catalog.agents)) throw new Error('公共角色库返回的数据不完整。');
  const changed = state.catalogRevision !== catalog.revision;
  state.catalogRevision = catalog.revision;
  state.catalogAvailable = true;
  state.catalogAgents = catalog.agents;
  if (Array.isArray(catalog.defaultAgentIds)) defaultAgentIds = new Set(catalog.defaultAgentIds);
  return changed;
}

async function readEditableAgent(id) {
  const selected = state.agents.find(item => item.id === id);
  if (publicAgent(selected)) {
    await refreshCatalogPermissions();
    const current = state.catalogAgents.find(item => item.id === id);
    if (!current?.canManage) throw new Error('当前浏览器只能查看和聊天，不能修改这个公共角色。');
    return { agent: current };
  }
  return api(`/api/agents/${encodeURIComponent(id)}`);
}

async function saveEditableAgent(id, body) {
  if (workspaceClient && !id) {
    if (!state.catalogAvailable) throw new Error('公共角色库尚未连接，请刷新页面后再创建。');
    return workspaceClient.createPublicAgent(body);
  }
  if (workspaceClient && publicAgent(state.agents.find(item => item.id === id))) return workspaceClient.updatePublicAgent(id, body);
  return api(id ? `/api/agents/${encodeURIComponent(id)}` : '/api/agents', body, id ? 'PATCH' : 'POST');
}

async function applyAgentChange(savedAgent, { created }) {
  const local = typeof workspaceClient !== 'undefined' && workspaceClient;
  if (local) await refreshCatalogPermissions();
  const data = local ? await workspaceClient.api('/api/state', undefined, 'GET', { force: true }) : await api('/api/state');
  if (!data.agents?.some(item => item.id === savedAgent.id)) throw new Error('新角色尚未载入，请重试。');
  state.agents = data.agents;
  state.model = data.model || {};
  syncAgentGalleryRoute.refresh();
  if (created) {
    state.agentId = savedAgent.id;
    await changeScope();
  } else {
    // Editing keeps the selected user, session, conversation and memory view.
    renderSelectors();
    saveSelection();
  }
}

const agentEditor = installAgentEditor({
  canOpen: () => !state.busy && !state.sending && !state.editorSaving && !state.pendingMessages.length,
  onSaved: applyAgentChange,
  onBusyChanged: value => { state.editorSaving = value; updateControls(); },
  readAgent: readEditableAgent,
  writeAgent: saveEditableAgent,
  getNote: id => !id && workspaceClient ? '创建后所有人都能看到并聊天。角色名称和设定会公开，聊天与记忆仍各自保存在本机。'
    : publicAgent(state.agents.find(item => item.id === id)) ? '修改会同步给所有使用者。已有聊天和记忆保留。'
      : '这次编辑只保存在当前浏览器。',
});

let agentDeleteTarget = null;
function openAgentDeletion(id) {
  if (state.busy || state.sending || state.editorSaving || state.pendingMessages.length) return;
  const selected = state.agents.find(item => item.id === id);
  if (!selected || !agentPermissions(selected).canDelete) return;
  agentDeleteTarget = { ...selected };
  el('agent-delete-copy').textContent = publicAgent(selected)
    ? `删除“${selected.name}”后，所有人的公共角色库都会移除此角色。`
    : `将“${selected.name}”从当前浏览器的角色列表中移除。`;
  el('agent-delete-error').hidden = true;
  el('agent-delete-dialog').showModal();
  el('agent-delete-cancel').focus();
}
el('agent-delete-cancel').addEventListener('click', () => el('agent-delete-dialog').close());
el('agent-delete-confirm').addEventListener('click', async () => {
  const target = agentDeleteTarget;
  const button = el('agent-delete-confirm');
  if (!target || button.disabled || state.busy || state.sending) return;
  button.disabled = true;
  el('agent-delete-cancel').disabled = true;
  button.textContent = '正在删除…';
  await runAction(async () => {
    try {
      if (!target.deleted) {
        if (publicAgent(target)) await workspaceClient.deletePublicAgent(target.id, target.revision);
        else await api(`/api/agents/${encodeURIComponent(target.id)}`, { revision: target.revision }, 'DELETE');
        target.deleted = true;
      }
      await refreshCatalogPermissions();
      const data = await workspaceClient.api('/api/state', undefined, 'GET', { force: true });
      await loadState(data);
      syncAgentGalleryRoute.refresh();
      el('agent-delete-dialog').close();
      put('chat-status', '角色已移除，已有聊天和记忆保留。');
    } catch (error) {
      el('agent-delete-error').textContent = target.deleted ? `角色已删除，刷新界面暂未完成：${error.message}。可以重试。` : error.message;
      el('agent-delete-error').hidden = false;
    }
  });
  button.disabled = false;
  el('agent-delete-cancel').disabled = false;
  button.textContent = '确认删除';
});
el('agent-delete-dialog').addEventListener('cancel', event => { if (el('agent-delete-confirm').disabled) event.preventDefault(); });

const syncAgentGalleryRoute = installAgentGallery({
  trigger: ui['agent-select'],
  getAgents: () => state.agents.map(item => ({ ...item, ...agentPermissions(item) })).sort((a, b) =>
    (agentDisplayOrder.get(a.id) ?? 2) - (agentDisplayOrder.get(b.id) ?? 2)),
  getSelectedId: () => state.agentId,
  getDataVersion: () => state.dataVersion,
  requestJSON: path => api(path),
  avatarFor: selected => selected.avatar || avatars.get(selected.id) || defaultPortraits.get(selected.id) || fallbackAvatar,
  onCreate: () => agentEditor.open(),
  onEdit: id => { const selected = state.agents.find(item => item.id === id); if (selected && agentPermissions(selected).canEdit) void agentEditor.open(id); },
  onDelete: id => openAgentDeletion(id),
  onSelect: selectAgent,
});
installListeners();
void initializeEntrance();

let catalogPolling = false;
async function syncPublicCatalog() {
  if (!workspaceClient || !state.authenticated || document.hidden || catalogPolling || pendingEntry ||
      state.busy || state.sending || state.queueSaving || state.editorSaving || state.pendingMessages.length ||
      el('agent-editor').open || el('agent-delete-dialog').open || el('recovery-dialog').open) return;
  catalogPolling = true;
  const client = workspaceClient, serial = bootstrapSerial;
  let changed = false;
  try {
    changed = await refreshCatalogPermissions({ probe: true });
    if (client !== workspaceClient || serial !== bootstrapSerial || !state.authenticated) return;
    if (state.busy || state.sending || state.queueSaving || state.editorSaving || state.pendingMessages.length ||
        el('agent-editor').open || el('agent-delete-dialog').open || el('recovery-dialog').open) {
      if (changed) state.catalogRevision = null;
      return;
    }
    if (changed) await runAction(async () => loadState(await workspaceClient.api('/api/state', undefined, 'GET', { force: true })));
  } catch (error) {
    if (changed) state.catalogRevision = null;
    if (error.status !== 401 && state.authenticated) show('app-error', `公共角色库同步暂未完成：${error.message}`);
  }
  finally { catalogPolling = false; }
}
setInterval(() => void syncPublicCatalog(), 20_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncPublicCatalog(); });

setInterval(async () => {
  if (workspaceClient || !state.authenticated || document.hidden || !hasScope() || state.polling || state.busy || state.editorSaving || state.sending || state.pendingMessages.length) return;
  state.polling = true;
  try {
    const data = await api('/api/state');
    if (state.busy || state.editorSaving || state.sending || state.pendingMessages.length) return;
    if (state.dataVersion !== (data.dataVersion || '')) await runAction(() => loadState(data));
    else {
      if (JSON.stringify(state.agents) !== JSON.stringify(data.agents || [])) {
        state.agents = data.agents || [];
        syncAgentGalleryRoute.refresh();
        if (!state.agents.some(item => item.id === state.agentId)) {
          state.agentId = state.agents[0]?.id || '';
          await changeScope();
        } else renderSelectors();
      }
      await Promise.all([refreshMemory(), refreshUsage()]);
    }
  } catch { /* An active action shows its own network errors. */ }
  finally { state.polling = false; }
}, 2600);

function showEntrance(message = '') {
  ++bootstrapSerial;
  pendingEntry = null;
  clearTimeout(entryRecoveryTimer);
  state.authenticated = false;
  state.catalogAvailable = false;
  state.catalogRevision = null;
  state.catalogAgents = [];
  clearMentorRecommendation();
  clearMentorArrival();
  ++state.scopeVersion;
  workspaceClient?.stop();
  clearTimeout(state.pendingTimer);
  state.pendingTimer = null;
  state.pendingMessages = [];
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  document.body.classList.add('entrance-active');
  el('workspace').hidden = true;
  el('entrance').hidden = false;
  el('entrance-password').disabled = false;
  el('entrance-submit').disabled = false;
  el('entrance-submit').textContent = '进入实验台';
  el('entrance-error').textContent = message;
  el('entrance-error').hidden = !message;
  el('entrance-password').focus();
}

async function authRequest(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(payload?.error || `连接失败 (${response.status})`);
  return payload;
}

async function enterWorkspace(session) {
  const serial = ++bootstrapSerial;
  ui.logout.hidden = session.passwordRequired === false;
  el('architecture-entry').hidden = !session.architectureAvailable;
  workspaceClient?.stop();
  if (session.storageMode === 'browser') {
    workspaceClient = new LocalWorkspace({
      getScope: () => ({ ...selectedScope(), sessionId: state.sessionId }),
      onUnauthorized: () => showEntrance('进入凭证已过期，请重新输入口令。本机记录仍保留。'),
      onChange: () => void refreshLocalView(),
      onError: error => { if (state.authenticated) { show('app-error', error.message); void offerRecovery(); } },
    });
    await workspaceClient.initialize();
    localSelection = (await workspaceClient.metadata()).selection || {};
  } else { workspaceClient = null; }
  state.authenticated = true;
  state.busy = true;
  if (workspaceClient) {
    const entry = await workspaceClient.entryState();
    if (entry.operation) { await showEntryRecovery(serial, entry); return; }
  }
  await completeWorkspaceEntry(serial);
}

async function completeWorkspaceEntry(serial) {
  try {
    if (workspaceClient && typeof workspaceClient.catalogRequest === 'function') await refreshCatalogPermissions();
    // Refresh untouched public defaults once on entry. Ordinary GETs still use
    // local views; private role edits and all existing conversations are kept.
    const initial = workspaceClient
      ? await workspaceClient.api('/api/state', undefined, 'GET', { force: true })
      : await api('/api/state');
    await loadState(initial, { preferDefaultAgent: true });
    if (serial !== bootstrapSerial || !state.authenticated) return;
    el('entrance-password').value = '';
    el('entrance').hidden = true;
    el('workspace').hidden = false;
    document.body.classList.remove('entrance-active');
    await workspaceClient?.resumeDeadlines();
    const recovered = await offerRecovery();
    if (!recovered && workspaceClient && !(await workspaceClient.metadata()).guideSeen) openGuide();
  } catch (error) {
    if (error.needsRecovery && workspaceClient) {
      await showEntryRecovery(serial, await workspaceClient.entryState());
      return;
    }
    throw error;
  } finally { if (!pendingEntry) state.busy = false; updateControls(); }
}

async function showEntryRecovery(serial, entry) {
  if (serial !== bootstrapSerial || !state.authenticated) return;
  pendingEntry = { serial };
  state.busy = true;
  document.body.classList.remove('entrance-active');
  el('entrance').hidden = true;
  el('workspace').hidden = false;
  await renderEntryRecovery(entry);
  if (!el('recovery-dialog').open) el('recovery-dialog').showModal();
  scheduleEntryRecoveryCheck();
}

async function renderEntryRecovery(entry) {
  recoveryData = { ...entry, phase: 'entry' };
  const waiting = entry.operation && entry.activeUntil > Date.now();
  el('recovery-title').textContent = waiting ? '另一个标签页正在处理' : '先恢复未完成的本地操作';
  el('recovery-copy').textContent = waiting
    ? '进入口令已验证。原标签页仍持有本地数据锁，请等待它完成，或回到原标签页查看。这里会自动检查保存状态。'
    : '进入口令已验证，但上次操作尚未完成本地保存。已有草稿会继续保留；确认后可重新载入工作区，不会自动重发聊天。';
  el('recovery-messages').textContent = entry.outbox?.body?.messages?.map(item => item.text).join('\n\n') || '已有记录会保留。首次进入尚未完成时，将重新建立本地工作区。';
  el('recovery-assistant').textContent = entry.outbox?.assistant || '';
  el('recovery-assistant-section').hidden = !entry.outbox?.assistant;
  el('recovery-restore').textContent = waiting ? '检查处理状态' : '保留草稿并继续';
  el('recovery-close').textContent = '退出体验';
  el('recovery-error').hidden = true;
  updateControls();
}

function scheduleEntryRecoveryCheck() {
  clearTimeout(entryRecoveryTimer);
  if (!pendingEntry || !state.authenticated) return;
  entryRecoveryTimer = setTimeout(async () => {
    try {
      const entry = await workspaceClient.entryState();
      if (!pendingEntry) return;
      if (!entry.operation) await resumeEntryRecovery(false);
      else if (entry.activeUntil > Date.now()) scheduleEntryRecoveryCheck();
      else await renderEntryRecovery(entry);
    } catch (error) { el('recovery-error').textContent = error.message; el('recovery-error').hidden = false; }
  }, 1000);
}

async function resumeEntryRecovery(acknowledge = true) {
  if (!pendingEntry || !workspaceClient) return;
  const entry = await workspaceClient.entryState();
  if (entry.operation) {
    if (entry.activeUntil > Date.now()) { await renderEntryRecovery(entry); scheduleEntryRecoveryCheck(); return; }
    if (!acknowledge) { await renderEntryRecovery(entry); return; }
    await workspaceClient.acknowledgeRecovery();
  }
  const { serial } = pendingEntry;
  pendingEntry = null;
  clearTimeout(entryRecoveryTimer);
  el('recovery-dialog').close();
  await completeWorkspaceEntry(serial);
}

let refreshingLocal = false;
let refreshLocalTimer;
async function refreshLocalView() {
  if (!state.authenticated || !workspaceClient || pendingEntry || document.hidden) return;
  const busy = () => state.sending || state.busy || state.editorSaving || state.pendingMessages.length || state.queueSaving ||
    el('agent-editor').open || el('agent-delete-dialog').open || el('recovery-dialog').open;
  if (refreshingLocal || busy()) {
    clearTimeout(refreshLocalTimer);
    refreshLocalTimer = setTimeout(() => void refreshLocalView(), 500);
    return;
  }
  refreshingLocal = true;
  const client = workspaceClient, scopeVersion = state.scopeVersion, sessionVersion = state.sessionVersion;
  const current = () => client === workspaceClient && state.authenticated &&
    scopeVersion === state.scopeVersion && sessionVersion === state.sessionVersion && !busy();
  try {
    const data = await api('/api/state');
    if (!current()) return;
    if (state.dataVersion !== (data.dataVersion || '') ||
        !data.agents?.some(item => item.id === state.agentId) ||
        !data.children?.some(item => item.id === state.childId)) {
      await runAction(() => loadState(data));
      return;
    }
    const agentsChanged = JSON.stringify(state.agents) !== JSON.stringify(data.agents);
    const childrenChanged = JSON.stringify(state.children) !== JSON.stringify(data.children);
    state.agents = data.agents; state.children = data.children; state.model = data.model || {};
    if (agentsChanged) syncAgentGalleryRoute.refresh();

    const sessions = (await api(scoped('/api/sessions'))).sessions || [];
    if (!current()) return;
    // Another tab opening a new conversation must not replace this tab's selection.
    const id = sessions.find(item => item.id === state.sessionId)?.id ||
      sessions.find(item => item.status === 'open')?.id || sessions[0]?.id || '';
    const conversation = id ? await api(scoped(`/api/sessions/${encodeURIComponent(id)}`)) : null;
    if (!current()) return;
    const selectionChanged = id !== state.sessionId;
    const sessionsChanged = JSON.stringify(state.sessions) !== JSON.stringify(sessions);
    const messagesChanged = selectionChanged || JSON.stringify(state.conversation?.messages || []) !== JSON.stringify(conversation?.messages || []);
    const contextChanged = JSON.stringify(state.conversation?.context ?? null) !== JSON.stringify(conversation?.context ?? null);
    const usageChanged = JSON.stringify(state.conversation?.usage ?? null) !== JSON.stringify(conversation?.usage ?? null);
    state.sessions = sessions; state.sessionId = id; state.conversation = conversation;
    if (agentsChanged || childrenChanged || sessionsChanged || selectionChanged) renderSelectors();
    if (selectionChanged) { clearMentorArrival(); saveSelection(); }
    if (messagesChanged) renderChat(conversation?.messages || [], false, { preserveScroll: !selectionChanged });
    if (contextChanged) renderContext(conversation?.context ?? null);
    if (usageChanged) renderUsage(conversation?.usage ?? null);
    await refreshMemory();
    if (current()) updateControls();
  } catch (error) {
    if (current()) {
      show('app-error', error.message);
      if (error.needsRecovery) void offerRecovery();
    }
  }
  finally { refreshingLocal = false; }
}

const guideSteps = [
  { title: '先选一个想聊的角色', target: 'agent-select', copy: '点左上角的 Agent 打开角色图鉴。八位角色都能选择；在「角色概览」了解设定，在「提示词原文」查看实际使用的提示词。', note: '可以随时换角色，每位角色分别保存与你的记忆。' },
  { title: '也可以创造自己的角色', target: 'new-agent', copy: '点击「创建角色」，只需填写名称和角色设定。创建后会直接公开，大家都能在角色图鉴里选择并聊天。', note: '自己创建的公共角色可以编辑、删除。管理凭证保存在创建时的浏览器，保留网站数据才能继续管理；旧的本机角色不会自动公开。' },
  { title: '让角色认识你', target: 'new-child', copy: '右上角可以创建用户资料，填写名字、年龄与兴趣。接着就能聊天；点「新会话」开启下一段，旧会话记录仍可查看。', note: '默认提供22岁的访客测试资料。停聊约15分钟后，会在下次打开或页面仍开着时整理记忆。每个人的对话与记忆各自保存在浏览器里。' },
  { title: '记忆留在你的浏览器', target: 'memory-panel', copy: '右侧可以查看记忆和用户概括。「清空记忆」只清理当前用户与角色的记忆，聊天记录会保留。左侧显示每轮实际送给模型的内容。', note: '共享口令不是账户。换设备、换浏览器不会同步；清理网站数据会丢失记录。请求处理时会临时发送工作区资料给服务端，不写入服务器用户数据库。请自行保留重要信息。' },
];
let guideIndex = 0;
function renderGuide() {
  for (const item of document.querySelectorAll('.guide-highlight')) item.classList.remove('guide-highlight');
  const step = guideSteps[guideIndex];
  el('guide-title').textContent = step.title;
  el('guide-copy').textContent = step.copy;
  el('guide-note').textContent = step.note;
  el('guide-progress').textContent = `${guideIndex + 1} / ${guideSteps.length}`;
  el('guide-back').disabled = guideIndex === 0;
  el('guide-next').textContent = guideIndex === guideSteps.length - 1 ? '开始聊天' : '下一步';
  el(step.target)?.classList.add('guide-highlight');
}
function openGuide() {
  guideIndex = 0;
  renderGuide();
  if (!el('guide-dialog').open) el('guide-dialog').showModal();
}
async function finishGuide() {
  try { await workspaceClient?.saveGuide(); }
  catch (error) { show('app-error', error.message); }
  el('guide-dialog').close();
}
ui['guide-open'].addEventListener('click', openGuide);
el('guide-back').addEventListener('click', () => { if (guideIndex > 0) { --guideIndex; renderGuide(); } });
el('guide-next').addEventListener('click', () => { if (guideIndex < guideSteps.length - 1) { ++guideIndex; renderGuide(); } else void finishGuide(); });
el('guide-skip').addEventListener('click', () => void finishGuide());
el('guide-dialog').addEventListener('cancel', event => { event.preventDefault(); void finishGuide(); });
el('guide-dialog').addEventListener('close', () => {
  for (const item of document.querySelectorAll('.guide-highlight')) item.classList.remove('guide-highlight');
});

ui['clear-memory'].addEventListener('click', () => {
  if (!hasScope() || state.sending || state.busy) return;
  el('clear-memory-scope').textContent = `${child()?.name || '当前用户'} × ${agent()?.name || '当前角色'}`;
  el('clear-memory-error').hidden = true;
  el('clear-memory-dialog').showModal();
  el('clear-memory-cancel').focus();
});
el('clear-memory-cancel').addEventListener('click', () => el('clear-memory-dialog').close());
el('clear-memory-confirm').addEventListener('click', async () => {
  const button = el('clear-memory-confirm');
  if (button.disabled) return;
  button.disabled = true;
  el('clear-memory-cancel').disabled = true;
  button.textContent = '正在清空…';
  await runAction(async () => {
    try {
      await api('/api/memory/clear', selectedScope());
      state.memoryDetails.clear();
      state.memoryOpen.clear();
      state.memorySignature = null;
      await createSession();
      el('clear-memory-dialog').close();
      put('chat-status', '这组记忆已清空，聊天记录已保留。');
    } catch (error) {
      el('clear-memory-error').textContent = error.message;
      el('clear-memory-error').hidden = false;
    }
  });
  button.disabled = false;
  el('clear-memory-cancel').disabled = false;
  button.textContent = '确认清空';
});
el('clear-memory-dialog').addEventListener('cancel', event => { if (el('clear-memory-confirm').disabled) event.preventDefault(); });

let recoveryData;
async function offerRecovery() {
  if (!workspaceClient || !state.authenticated || pendingEntry) return false;
  const recovery = await workspaceClient.recovery();
  if (!recovery.outbox && !recovery.operation) return false;
  recoveryData = recovery;
  el('recovery-title').textContent = '上次的消息已留在本机';
  el('recovery-close').textContent = '稍后处理';
  el('recovery-messages').textContent = recovery.outbox?.body?.messages?.map(item => item.text).join('\n\n') || '上次的本地操作未完成保存。已有聊天记录仍保留。';
  el('recovery-assistant').textContent = recovery.outbox?.assistant || '';
  el('recovery-assistant-section').hidden = !recovery.outbox?.assistant;
  el('recovery-copy').textContent = recovery.outbox?.dispatched
    ? '上次回复未完成本地保存。这里保留了你的消息与已收到的文本，不会自动重发。再次发送可能产生新的模型用量。'
    : '消息尚未完成发送，已在当前浏览器保留。恢复为草稿后，可以继续编辑再发送。';
  el('recovery-restore').textContent = recovery.outbox ? '恢复为草稿' : '继续使用';
  el('recovery-error').hidden = true;
  if (!el('recovery-dialog').open) el('recovery-dialog').showModal();
  return true;
}
el('recovery-close').addEventListener('click', () => {
  if (pendingEntry) ui.logout.click(); else el('recovery-dialog').close();
});
el('recovery-dialog').addEventListener('cancel', event => { if (pendingEntry) event.preventDefault(); });
el('recovery-restore').addEventListener('click', async () => {
  const button = el('recovery-restore');
  button.disabled = true;
  try {
    if (pendingEntry) { await resumeEntryRecovery(); return; }
    if (recoveryData?.operation) await workspaceClient.acknowledgeRecovery();
    const recovered = recoveryData?.outbox;
    if (recovered?.body) {
      const scope = recovered.body;
      if (!state.agents.some(item => item.id === scope.agentId) || !state.children.some(item => item.id === scope.childId)) {
        throw new Error('原角色或用户已移除。未发送内容仍保留在此窗口和本机，请先复制需要的内容。');
      }
      if (state.agents.some(item => item.id === scope.agentId) && state.children.some(item => item.id === scope.childId) &&
          (state.agentId !== scope.agentId || state.childId !== scope.childId || state.sessionId !== scope.sessionId)) {
        state.agentId = scope.agentId;
        state.childId = scope.childId;
        await runAction(() => changeScope(scope.sessionId));
      }
      const recoveredText = scope.messages.map(item => item.text).join('\n\n');
      const currentText = ui['chat-input'].value;
      ui['chat-input'].value = currentText.trim() === recoveredText.trim() ? currentText
        : [recoveredText, currentText].filter(Boolean).join('\n\n');
      await workspaceClient.saveDraft({ ...selectedScope(), sessionId: state.sessionId, text: ui['chat-input'].value });
      await workspaceClient.saveOutbox(null, recoveryData.outboxOwner);
      fitComposer();
      updateControls();
    }
    el('recovery-dialog').close();
    ui['chat-input'].focus();
  } catch (error) {
    el('recovery-error').textContent = error.message;
    el('recovery-error').hidden = false;
  } finally { button.disabled = false; }
});

async function initializeEntrance() {
  el('password-toggle').addEventListener('click', () => {
    const input = el('entrance-password');
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    el('password-toggle').textContent = visible ? '隐藏' : '显示';
    el('password-toggle').setAttribute('aria-label', visible ? '隐藏口令' : '显示口令');
    el('password-toggle').setAttribute('aria-pressed', String(visible));
  });
  el('entrance-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = el('entrance-submit');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '正在进入…';
    el('entrance-error').hidden = true;
    try { await enterWorkspace(await authRequest('/api/auth/login', { password: el('entrance-password').value })); }
    catch (error) { showEntrance(error.message); }
  });
  ui.logout.addEventListener('click', async () => {
    workspaceClient?.abortChat();
    try { await authRequest('/api/auth/logout', {}); showEntrance(); }
    catch (error) { show('app-error', error.message); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && workspaceClient && state.authenticated) {
      void workspaceClient.store.read('workspace').then(record => {
        if (record?.nextDeadline <= Date.now() && Number.isFinite(record?.nextDeadline)) {
          return workspaceClient.api('/api/state', undefined, 'GET', { force: true }).then(() => refreshLocalView());
        }
        return refreshLocalView();
      }).catch(error => { show('app-error', error.message); void offerRecovery(); });
    }
  });
  try {
    const session = await authRequest('/api/auth/session');
    if (session.authenticated) await enterWorkspace(session);
    else showEntrance();
  } catch (error) { showEntrance(error.message); }
}
