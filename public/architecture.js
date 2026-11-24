import { bindArchitectureGraph } from './architecture-graph.js';

const byId = id => document.getElementById(id);
const inspector = byId('architecture-inspector');
const copyStatus = byId('copy-status');
const compactLayout = matchMedia('(max-width: 810px)');
const hoverInput = matchMedia('(hover: hover) and (pointer: fine)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const branchLabels = { recommendation: '推荐工具', handoff: '用户操作', memory: '异步任务' };
const promptKinds = { prompt: '提示词', example: '示例', schema: '工具定义' };
let modules = new Map();
let nodes = [];
let selectedId = '';
let hoverTimer;
let hoverId = '';
const graph = bindArchitectureGraph({
  viewport: byId('graph-viewport'), canvas: byId('graph-canvas'), world: byId('flow-nodes'), onInteraction: cancelHover,
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function copyPrompt(text, code, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '已复制';
    copyStatus.textContent = '已复制提示词';
    setTimeout(() => { button.textContent = '复制'; }, 1600);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection?.removeAllRanges();
    selection?.addRange(range);
    button.textContent = '已选中文字';
    copyStatus.textContent = '已选中提示词，可以通过系统复制';
  }
}

function promptView(prompt, open) {
  const details = element('details', 'prompt');
  details.open = open;
  const summary = element('summary');
  summary.append(element('strong', '', prompt.label));
  if (prompt.kind) summary.append(element('span', 'prompt-kind', promptKinds[prompt.kind] ?? prompt.kind));
  const body = element('div', 'prompt-body');
  const code = element('pre', '', prompt.text);
  code.tabIndex = 0;
  code.setAttribute('aria-label', prompt.label);
  const actions = element('div', 'prompt-actions');
  const copy = element('button', 'minor-button', '复制');
  copy.type = 'button';
  copy.setAttribute('aria-label', `复制${prompt.label}`);
  copy.addEventListener('click', () => { void copyPrompt(prompt.text, code, copy); });
  actions.append(copy);
  body.append(code, actions);
  details.append(summary, body);
  return details;
}

function cancelHover() {
  clearTimeout(hoverTimer);
  hoverId = '';
}

function inspect(id) {
  cancelHover();
  const module = modules.get(id);
  if (!module || id === selectedId) return;
  selectedId = id;
  for (const node of nodes) {
    node.button.setAttribute('aria-pressed', String(node.id === id));
  }
  graph.select(id);
  byId('module-title').textContent = module.title;
  byId('module-description').textContent = module.description;
  const prompts = module.steps.flatMap(step => step.prompts ?? []);
  const openedPrompt = id === 'recommendation'
    ? prompts.find(prompt => prompt.label === '完整导师决策提示') ?? prompts[0]
    : undefined;
  const steps = module.steps.map(step => {
    const item = element('li', 'step');
    item.append(element('h3', '', step.title));
    if (step.description) item.append(element('p', '', step.description));
    if (step.source) item.append(element('code', 'source-path', step.source));
    for (const prompt of step.prompts ?? []) {
      item.append(promptView(prompt, prompt === openedPrompt));
    }
    if (!step.prompts?.length && !step.description?.includes('代码处理')) {
      item.append(element('small', 'step-kind', '此步骤由代码处理'));
    }
    return item;
  });
  byId('module-steps').replaceChildren(...steps);
}

function flowNode(entry) {
  const item = element('li', 'graph-item');
  const button = element('button', 'graph-node');
  button.type = 'button';
  button.dataset.module = entry.id;
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-controls', 'architecture-inspector');
  if (branchLabels[entry.id]) button.append(element('span', 'graph-node-kind', branchLabels[entry.id]));
  button.append(element('strong', '', entry.title));
  if (entry.note) button.append(element('small', '', entry.note));
  button.addEventListener('pointermove', event => {
    if (!hoverInput.matches || graph.isPanning() || event.pointerType !== 'mouse' ||
        entry.id === selectedId || entry.id === hoverId) return;
    cancelHover();
    hoverId = entry.id;
    hoverTimer = setTimeout(() => inspect(entry.id), 125);
  });
  button.addEventListener('pointerleave', () => {
    if (hoverId === entry.id) cancelHover();
  });
  button.addEventListener('focus', () => {
    inspect(entry.id);
    graph.reveal(entry.id);
  });
  button.addEventListener('click', () => {
    inspect(entry.id);
    if (compactLayout.matches) {
      inspector.focus({ preventScroll: true });
      inspector.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
    }
  });
  button.addEventListener('keydown', event => {
    const currentIndex = nodes.findIndex(node => node.id === entry.id);
    const next = { ArrowDown: currentIndex + 1, ArrowUp: currentIndex - 1, Home: 0, End: nodes.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = nodes[Math.max(0, Math.min(nodes.length - 1, next))];
    inspect(target.id);
    target.button.focus();
  });
  item.append(button);
  return { id: entry.id, item, button };
}

function showArchitecture(data) {
  if (!Array.isArray(data?.modules) || !Array.isArray(data?.flow)) throw new Error('架构数据不可用。');
  modules = new Map(data.modules.filter(module => module?.id && Array.isArray(module.steps)).map(module => [module.id, module]));
  const flow = data.flow.filter(entry => modules.has(entry?.id));
  if (!flow.length) throw new Error('架构数据没有可检查的模块。');

  byId('architecture-base').textContent = data.base || '—';
  byId('architecture-model').textContent = data.model || '—';
  byId('architecture-runtime').hidden = false;
  selectedId = '';
  nodes = flow.map(flowNode);
  byId('architecture-explorer').hidden = false;
  graph.setItems(nodes);
  inspect(flow.find(entry => entry.id === 'recommendation')?.id ?? flow[0].id);
}

async function loadArchitecture() {
  const loading = byId('architecture-loading');
  const error = byId('architecture-error');
  loading.hidden = false;
  error.hidden = true;
  try {
    const response = await fetch('/api/demo/architecture', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (response.status === 404) throw new Error('此聊天实例没有提供架构数据。');
    if (!response.ok) throw new Error('暂时无法读取架构数据。');
    showArchitecture(await response.json());
  } catch (failure) {
    const message = failure instanceof SyntaxError ? '收到的架构数据无法读取。'
      : failure instanceof TypeError ? '无法连接到架构数据。' : failure.message;
    byId('architecture-error-message').textContent = message;
    error.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

byId('architecture-retry').addEventListener('click', () => { void loadArchitecture(); });
void loadArchitecture();
