const galleryHash = '#agents';
const svgNamespace = 'http://www.w3.org/2000/svg';
const promptSections = [
  { key: 'system', label: '完整提示词', description: '后端当前加载并用于聊天的完整 system 内容。' },
  { key: 'common', label: '共用规则', description: '所有聊天角色共用的规则，保留后端原文。' },
  { key: 'role', label: '角色设定', description: '当前角色在共用规则之后追加的设定，保留后端原文。' },
  { key: 'memory', label: '记忆整理', description: '后台记忆 Agent 当前实际使用的提取、更新和用户概括维护提示词。' },
  { key: 'memoryRepair', label: '失败修正', description: '仅在完整提取结果未通过解析或校验时，重新使用原始提取输入并追加具体校验错误，由同一模型重整一次；失败 JSON 仅本地审计，不回传模型。正常提取不调用。' },
  { key: 'memoryReview', label: '事实核对', description: '仅核对本轮新增和修改条目的事实依据，不重复处理全部旧记忆。' },
  { key: 'contextBrief', label: '概括选源', description: '为聊天概括去重选源，保留来源原句；不改写或删除原记忆。' },
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svgElement(tag, attributes) {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function image(src, className, alt, fallback) {
  const node = element('img', className);
  node.alt = alt;
  node.src = src;
  if (src !== fallback) node.addEventListener('error', () => { node.src = fallback; }, { once: true });
  return node;
}

function renderCard(article, agent, avatar, onEdit) {
  const card = agent.card || {};
  const name = agent.name;
  const portrait = card.portrait || avatar;
  const cutout = /-portrait\.(?:webp|png)$/i.test(portrait) || card.theme === 'amber';
  article.dataset.theme = card.theme || 'fern';
  article.dataset.portraitStyle = cutout ? 'cutout' : 'avatar';
  article.dataset.layout = 'definition';

  const hero = element('div', 'gallery-portrait');
  const orbit = element('div', 'gallery-orbit');
  orbit.append(element('div', 'gallery-orbit-grid'), element('div', 'gallery-orbit-ring'));
  const frame = element('div', 'gallery-portrait-frame');
  frame.append(image(portrait, 'gallery-portrait-image', `${name}的角色形象`, avatar));
  orbit.append(frame);
  const meta = element('div', 'gallery-character-meta');
  meta.append(element('h3', 'gallery-character-name', name));
  if (agent.minimumAge) meta.append(element('p', 'gallery-alias', `${agent.minimumAge}+ · 成年用户限定`));
  hero.append(orbit, meta);
  if (card.voice?.mode === 'reference' && /^\/assets\/voices\/[\w-]+\.(?:mp3|wav|m4a)$/.test(card.voice.sample)) {
    const voice = element('section', 'gallery-voice');
    voice.setAttribute('aria-label', '角色声音参考');
    voice.append(element('p', 'gallery-voice-label', card.voice.label));
    const player = element('audio', 'gallery-voice-player');
    player.controls = true;
    player.preload = 'metadata';
    player.src = card.voice.sample;
    player.setAttribute('aria-label', card.voice.label + '试听');
    voice.append(player, element('p', 'gallery-voice-note', '参考音试听 · 实时语音尚未接入'));
    hero.append(voice);
  }

  const definition = element('section', 'gallery-definition');
  const heading = element('div', 'gallery-definition-heading');
  heading.append(element('h4', 'gallery-definition-title', '角色设定'));
  const edit = element('button', 'gallery-copy-button gallery-edit-button', '编辑角色');
  edit.type = 'button';
  edit.addEventListener('click', () => onEdit?.(agent.id));
  heading.append(edit);
  const text = agent.definition || '';
  const copy = element('p', 'gallery-definition-copy', text || '暂无角色设定。');
  definition.append(heading, copy);
  if (text.length > 420 || text.split(/\r?\n/).length > 8) {
    copy.classList.add('is-collapsed');
    const expand = element('button', 'gallery-definition-expand', '展开完整设定');
    expand.type = 'button';
    expand.setAttribute('aria-expanded', 'false');
    expand.addEventListener('click', () => {
      const collapsed = copy.classList.toggle('is-collapsed');
      expand.setAttribute('aria-expanded', String(!collapsed));
      expand.textContent = collapsed ? '展开完整设定' : '收起设定';
    });
    definition.append(expand);
  }
  article.replaceChildren(hero, definition);
}

function drawConnections(article) {
  const diagram = article.querySelector('.gallery-connections');
  const orbit = article.querySelector('.gallery-orbit');
  if (!diagram || !orbit || article.clientWidth < 700) {
    diagram?.replaceChildren();
    return;
  }
  const bounds = article.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  diagram.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  const ring = orbit.getBoundingClientRect();
  const cx = ring.left - bounds.left + ring.width / 2;
  const cy = ring.top - bounds.top + ring.height / 2;
  const radius = Math.min(ring.width, ring.height) * .44;
  const marks = [];
  for (const field of article.querySelectorAll('.gallery-field')) {
    const rect = field.getBoundingClientRect();
    const left = rect.left + rect.width / 2 < ring.left + ring.width / 2;
    const startX = (left ? rect.right : rect.left) - bounds.left;
    const startY = rect.top - bounds.top + rect.height / 2;
    const offsetY = Math.max(-radius * .8, Math.min(radius * .8, startY - cy));
    const endY = cy + offsetY;
    const endX = cx + (left ? -1 : 1) * Math.sqrt(radius ** 2 - offsetY ** 2);
    const elbowX = startX + (endX - startX) * .5;
    marks.push(svgElement('path', {
      d: `M ${startX} ${startY} H ${elbowX} L ${endX} ${endY}`,
      fill: 'none', 'vector-effect': 'non-scaling-stroke',
    }), svgElement('circle', { cx: endX, cy: endY, r: 3, 'vector-effect': 'non-scaling-stroke' }));
  }
  diagram.replaceChildren(...marks);
}

function parseGalleryRoute(hash) {
  const match = /^#agents(?:\/([^/]+)(\/prompt)?)?$/.exec(hash);
  if (!match) return null;
  let agentId;
  try { agentId = match[1] ? decodeURIComponent(match[1]) : null; }
  catch { return null; }
  return { agentId, view: match[2] ? 'prompt' : 'overview' };
}

export function installAgentGallery({ trigger, getAgents, getSelectedId, avatarFor, onSelect, onCreate, onEdit, getDataVersion = () => '', requestJSON }) {
  const dialog = document.getElementById('agent-gallery');
  const closeButton = document.getElementById('agent-gallery-close');
  const createButton = document.getElementById('agent-gallery-create');
  const article = document.getElementById('agent-gallery-card');
  const roster = document.getElementById('agent-gallery-roster');
  const status = document.getElementById('agent-gallery-status');
  const confirm = document.getElementById('agent-gallery-confirm');
  const confirmLabel = document.getElementById('agent-gallery-confirm-label');
  const overviewTab = document.getElementById('agent-view-overview');
  const promptTab = document.getElementById('agent-view-prompt');
  const overviewPanel = document.getElementById('agent-overview-view');
  const promptPanel = document.getElementById('agent-prompt-view');
  const promptMeta = document.getElementById('agent-prompt-meta');
  const promptHeading = document.getElementById('agent-prompt-heading');
  const promptDescription = document.getElementById('agent-prompt-description');
  const promptTabs = document.getElementById('agent-prompt-tabs');
  const promptContent = document.getElementById('agent-prompt-content');
  const promptCopy = document.getElementById('agent-prompt-copy');
  const copyStatus = document.getElementById('agent-prompt-copy-status');
  const promptRetry = document.getElementById('agent-prompt-retry');
  const cache = new Map();
  let previewId;
  let view = 'overview';
  let followsHash = false;
  let activeSection = 'system';
  let detail = null;
  let loadController;
  let loadSerial = 0;
  let drawFrame;
  trigger.setAttribute('aria-expanded', 'false');

  function scheduleConnections() {
    cancelAnimationFrame(drawFrame);
    drawFrame = requestAnimationFrame(() => drawConnections(article));
  }
  const observer = new ResizeObserver(scheduleConnections);

  function observeDiagram() {
    observer.disconnect();
    observer.observe(article);
    for (const target of article.querySelectorAll('.gallery-orbit, .gallery-field')) observer.observe(target);
    scheduleConnections();
  }

  function stopLoading() {
    ++loadSerial;
    loadController?.abort();
    loadController = null;
  }

  function renderPrompt() {
    const available = promptSections.filter(section => detail
      ? typeof detail[section.key] === 'string' && detail[section.key].trim()
      : !['memoryRepair', 'memoryReview', 'contextBrief'].includes(section.key));
    if (!available.some(section => section.key === activeSection)) activeSection = available[0]?.key || 'system';
    const section = promptSections.find(item => item.key === activeSection);
    for (const button of promptTabs.children) {
      button.hidden = !available.some(item => item.key === button.dataset.section);
      button.setAttribute('aria-pressed', String(button.dataset.section === activeSection));
    }
    promptDescription.textContent = section.description;
    copyStatus.textContent = '';
    const content = typeof detail?.[activeSection] === 'string' ? detail[activeSection] : '';
    promptContent.textContent = content || (detail ? '当前服务尚未提供这份提示词。' : '');
    promptCopy.disabled = !content;
    if (!detail) return;
    promptHeading.textContent = `${detail.name} · ${section.label}`;
    promptMeta.replaceChildren(
      element('span', 'gallery-prompt-meta-item', `角色版本 ${detail.version}`),
      element('span', 'gallery-prompt-meta-item', ['memory', 'memoryRepair', 'memoryReview', 'contextBrief'].includes(activeSection) ? detail.memoryModel || detail.model : detail.model),
      element('span', 'gallery-prompt-meta-item', `${Array.from(content).length} 字符`),
    );
  }

  function cacheKey(id, version) { return `${version}\u0000${id}\u0000${getAgents().find(agent => agent.id === id)?.revision ?? ''}`; }

  async function loadPrompt(force = false) {
    stopLoading();
    const serial = loadSerial;
    const id = previewId;
    const expectedVersion = getDataVersion();
    const cached = expectedVersion && cache.get(cacheKey(id, expectedVersion));
    promptRetry.hidden = true;
    promptPanel.removeAttribute('aria-busy');
    detail = null;
    renderPrompt();
    if (cached && !force) {
      detail = cached;
      renderPrompt();
      return;
    }
    const name = getAgents().find(agent => agent.id === id)?.name || '角色';
    promptHeading.textContent = `${name} · 提示词原文`;
    promptMeta.replaceChildren();
    promptContent.textContent = '正在读取后端实际加载的提示词…';
    promptPanel.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    loadController = controller;
    try {
      let payload;
      const path = `/api/agents/${encodeURIComponent(id)}/prompt`;
      if (requestJSON) payload = await requestJSON(path);
      else {
        const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
        payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || `读取失败 (${response.status})`);
      }
      if (payload.agentId !== id || !['name', 'version', 'model', 'system', 'common', 'role'].every(key => typeof payload[key] === 'string')) {
        throw new Error('提示词数据格式不完整，请重试。');
      }
      if (serial !== loadSerial || id !== previewId || view !== 'prompt' || !dialog.open) return;
      detail = payload;
      if (payload.dataVersion) cache.set(cacheKey(id, payload.dataVersion), payload);
      renderPrompt();
    } catch (error) {
      if (controller.signal.aborted || serial !== loadSerial) return;
      promptContent.textContent = error.message || '无法读取提示词，请重试。';
      promptRetry.hidden = false;
    } finally {
      if (serial === loadSerial) {
        promptPanel.removeAttribute('aria-busy');
        loadController = null;
      }
    }
  }

  for (const section of promptSections) {
    const button = element('button', 'gallery-prompt-section', section.label);
    button.type = 'button';
    button.dataset.section = section.key;
    button.setAttribute('aria-pressed', String(section.key === activeSection));
    button.addEventListener('click', () => {
      activeSection = section.key;
      if (detail) renderPrompt();
      else for (const item of promptTabs.children) item.setAttribute('aria-pressed', String(item === button));
    });
    promptTabs.append(button);
  }

  function setView(nextView) {
    const changed = view !== nextView;
    view = nextView;
    dialog.dataset.view = view;
    overviewPanel.hidden = view !== 'overview';
    promptPanel.hidden = view !== 'prompt';
    for (const [button, name] of [[overviewTab, 'overview'], [promptTab, 'prompt']]) {
      button.setAttribute('aria-selected', String(view === name));
      button.tabIndex = view === name ? 0 : -1;
    }
    if (view === 'prompt' && changed) void loadPrompt();
    if (view === 'overview') {
      stopLoading();
      promptPanel.removeAttribute('aria-busy');
      scheduleConnections();
    }
    if (changed) dialog.scrollTop = 0;
  }

  function preview(id) {
    const agents = getAgents();
    const agent = agents.find(item => item.id === id);
    if (!agent) return;
    const changed = previewId !== id;
    previewId = id;
    renderCard(article, agent, avatarFor(agent), agentId => { close(); void onEdit?.(agentId); });
    observeDiagram();
    for (const button of roster.children) button.setAttribute('aria-pressed', String(button.dataset.agentId === previewId));
    const isSelected = id === getSelectedId();
    status.textContent = isSelected ? `当前聊天角色 · ${agent.name}` : `正在预览${agent.name}`;
    confirmLabel.textContent = isSelected ? '返回聊天' : '选用此角色';
    if (changed && view === 'prompt') void loadPrompt();
  }

  function navigate(id, nextView) {
    const hash = `${galleryHash}/${encodeURIComponent(id)}${nextView === 'prompt' ? '/prompt' : ''}`;
    if (location.hash !== hash) history.pushState(history.state, '', hash);
    syncRoute();
  }

  function fillRoster(agents, selectedId) {
    roster.replaceChildren(...agents.map(agent => {
      const button = element('button', 'gallery-roster-button');
      button.type = 'button';
      button.dataset.agentId = agent.id;
      button.dataset.theme = agent.card?.theme || 'fern';
      const avatar = avatarFor(agent);
      button.append(image(agent.card?.portrait || avatar, 'gallery-roster-avatar', '', avatar),
        element('span', 'gallery-roster-name', agent.name));
      if (agent.id === selectedId) button.append(element('span', 'gallery-roster-state', '当前角色'));
      button.addEventListener('click', () => navigate(agent.id, view));
      return button;
    }));
  }

  function open(route) {
    if (trigger.disabled) return;
    const agents = getAgents();
    const selectedId = getSelectedId();
    const selected = agents.find(item => item.id === route?.agentId) || agents.find(item => item.id === selectedId) || agents[0];
    if (!selected) return;
    if (dialog.open) {
      const roleChanged = selected.id !== previewId;
      const viewChanged = view !== route.view;
      if (roleChanged && viewChanged && view === 'prompt') setView('overview');
      if (roleChanged) preview(selected.id);
      if (view !== route.view) setView(route.view);
      return;
    }
    activeSection = 'system';
    detail = null;
    view = 'overview';
    fillRoster(agents, selectedId);
    preview(selected.id);
    dialog.showModal();
    setView(route?.view || 'overview');
    if (view === 'prompt' && !loadController && !detail) void loadPrompt();
    dialog.scrollTop = 0;
    trigger.setAttribute('aria-expanded', 'true');
    closeButton.focus({ preventScroll: true });
    scheduleConnections();
  }

  function removeGalleryHash() {
    if (!parseGalleryRoute(location.hash)) return;
    const url = new URL(location.href);
    url.hash = '';
    history.replaceState(history.state, '', url);
  }

  function close() {
    removeGalleryHash();
    dialog.close();
  }

  function syncRoute() {
    const route = parseGalleryRoute(location.hash);
    if (route) {
      followsHash = true;
      open(route);
    } else if (followsHash && dialog.open) {
      dialog.close();
    }
  }

  trigger.addEventListener('click', () => {
    if (!trigger.disabled) navigate(getSelectedId(), 'overview');
  });
  overviewTab.addEventListener('click', () => navigate(previewId, 'overview'));
  promptTab.addEventListener('click', () => navigate(previewId, 'prompt'));
  for (const tab of [overviewTab, promptTab]) tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? overviewTab : event.key === 'End' ? promptTab : tab === overviewTab ? promptTab : overviewTab;
    next.click();
    next.focus({ preventScroll: true });
  });
  closeButton.addEventListener('click', close);
  createButton.addEventListener('click', () => { close(); void onCreate?.(); });
  promptRetry.addEventListener('click', () => void loadPrompt(true));
  promptCopy.addEventListener('click', async () => {
    const payload = detail;
    const section = activeSection;
    if (!payload || promptCopy.disabled) return;
    try {
      await navigator.clipboard.writeText(payload[section]);
      if (detail === payload && activeSection === section) copyStatus.textContent = '已复制原文';
    } catch {
      if (detail === payload && activeSection === section) copyStatus.textContent = '复制失败，可选中文本手动复制';
    }
  });
  dialog.addEventListener('cancel', removeGalleryHash);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    followsHash = false;
    stopLoading();
    observer.disconnect();
    cancelAnimationFrame(drawFrame);
    trigger.setAttribute('aria-expanded', 'false');
    if (!trigger.disabled) trigger.focus({ preventScroll: true });
  });
  confirm.addEventListener('click', async () => {
    if (!previewId || trigger.disabled) return;
    const id = previewId;
    close();
    if (id !== getSelectedId()) await onSelect(id);
    if (!trigger.disabled && !dialog.open) trigger.focus({ preventScroll: true });
  });
  window.addEventListener('hashchange', syncRoute);
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('resize', scheduleConnections);
  syncRoute.refresh = () => {
    cache.clear();
    stopLoading();
    detail = null;
    if (!dialog.open) return;
    const agents = getAgents();
    fillRoster(agents, getSelectedId());
    const id = agents.find(agent => agent.id === previewId)?.id || getSelectedId() || agents[0]?.id;
    if (!id) { close(); return; }
    preview(id);
    if (view === 'prompt') void loadPrompt(true);
  };
  return syncRoute;
}
