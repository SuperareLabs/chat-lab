import { reviewSections } from './mentor-recommendation-review-data.js';

const namespace = 'chatlab.mentor-recommendation-review.v1.';
const byId = id => document.getElementById(id);
const sectionsRoot = byId('review-sections');
const nav = byId('review-nav');
const filter = byId('filter-edited');
const status = byId('save-status');
const resultDialog = byId('export-dialog');
const resultText = byId('export-text');
const fields = new Map();
const unsaved = new Set();

let onlyEdited = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function loadNote(id) {
  try { return localStorage.getItem(namespace + id) ?? ''; }
  catch { unsaved.add(id); return ''; }
}

function storeNote(id, text) {
  try {
    if (text.trim()) localStorage.setItem(namespace + id, text);
    else localStorage.removeItem(namespace + id);
    unsaved.delete(id);
  } catch {
    unsaved.add(id);
  }
  renderSaveStatus();
}

function renderSaveStatus() {
  const message = unsaved.size ? '有草稿无法保存，请复制或下载后再关闭。' : '草稿会自动保存在当前浏览器。';
  if (status.textContent !== message) status.textContent = message;
}

function questionCard(item) {
  const card = element('article', 'question');
  const heading = element('header', 'question-heading');
  const title = element('h3', '', item.title);
  const badge = element('span', 'question-badge');
  const proposal = element('p', 'proposal', item.proposal);
  title.id = `title-${item.id}`;
  proposal.id = `proposal-${item.id}`;
  heading.append(title, badge);
  card.setAttribute('aria-labelledby', title.id);
  card.append(heading, proposal);
  if (item.example) card.append(element('p', 'example', item.example));

  const field = element('div', 'field');
  const label = element('label', 'sr-only', `${item.title}的修改意见`);
  const input = element('textarea', 'notes');
  input.id = `note-${item.id}`;
  input.rows = 2;
  input.placeholder = '有不同意见就在这里写';
  input.setAttribute('aria-describedby', proposal.id);
  input.value = loadNote(item.id);
  input.addEventListener('input', () => {
    storeNote(item.id, input.value);
    refresh();
  });
  input.addEventListener('blur', refresh);
  label.htmlFor = input.id;
  field.append(label, input);
  card.append(field);
  fields.set(item.id, { card, input, badge });
  return card;
}

const sectionViews = reviewSections.map(section => {
  const view = element('section', 'review-section');
  view.id = `section-${section.id}`;
  const heading = element('h2', '', section.title);
  heading.id = `heading-${section.id}`;
  view.setAttribute('aria-labelledby', heading.id);
  view.append(heading, ...section.items.map(questionCard));
  sectionsRoot.append(view);

  const link = element('a', 'nav-link', section.title);
  const count = element('span');
  link.href = `#${view.id}`;
  link.append(count);
  nav.append(link);
  return { ...section, view, link, count };
});

function refresh() {
  let editedTotal = 0;
  let shownTotal = 0;
  for (const { items, view, link, count } of sectionViews) {
    let editedHere = 0;
    let shownHere = 0;
    for (const item of items) {
      const { card, input, badge } = fields.get(item.id);
      const edited = Boolean(input.value.trim());
      const shown = !onlyEdited || edited || document.activeElement === input;
      card.hidden = !shown;
      card.dataset.edited = String(edited);
      badge.hidden = !edited && !item.confirmed;
      badge.dataset.state = edited ? 'edited' : 'confirmed';
      badge.textContent = edited ? '有修改意见' : '已口头确认';
      if (edited) editedHere++;
      if (shown) shownHere++;
    }
    view.hidden = shownHere === 0;
    link.hidden = view.hidden;
    count.textContent = onlyEdited ? `${editedHere} 项` : `${items.length} 项`;
    editedTotal += editedHere;
    shownTotal += shownHere;
  }
  const summary = `共 ${fields.size} 项 · 留空认可 ${fields.size - editedTotal} 项 · 有意见 ${editedTotal} 项`;
  const summaryEl = byId('review-summary');
  if (summaryEl.textContent !== summary) summaryEl.textContent = summary;
  byId('review-empty').hidden = shownTotal !== 0;
}

function markdown() {
  const notes = [...fields.values()].filter(({ input }) => input.value.trim()).length;
  const lines = ['# 角色推荐核对结果', '', `共 ${fields.size} 项，留空认可 ${fields.size - notes} 项，有意见 ${notes} 项。`,
    '写了意见的条目以意见为准。', ''];
  for (const section of reviewSections) {
    lines.push(`## ${section.title}`, '');
    for (const item of section.items) {
      const note = fields.get(item.id).input.value.trim();
      const decision = note ? '有修改意见' : item.confirmed ? '已口头确认' : '认可建议稿';
      lines.push(`### ${item.title}`, '', item.proposal);
      if (item.example) lines.push(item.example);
      lines.push('', `**${decision}**`, '');
      if (note) lines.push(note, '');
    }
  }
  return lines.join('\n');
}

filter.addEventListener('click', () => {
  onlyEdited = !onlyEdited;
  filter.setAttribute('aria-pressed', String(onlyEdited));
  filter.textContent = onlyEdited ? '显示全部' : '只看有意见';
  refresh();
});

byId('copy-review').addEventListener('click', async () => {
  const text = markdown();
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = '已复制核对结果。';
  } catch {
    resultText.value = text;
    resultDialog.showModal();
    resultText.focus();
    resultText.select();
  }
});

byId('download-review').addEventListener('click', () => {
  const file = new Blob([markdown()], { type: 'text/markdown;charset=utf-8' });
  const link = element('a');
  link.href = URL.createObjectURL(file);
  link.download = '角色推荐核对结果.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  status.textContent = '已生成 Markdown 汇总。';
});

window.addEventListener('storage', event => {
  if (!event.key?.startsWith(namespace)) return;
  const field = fields.get(event.key.slice(namespace.length));
  if (!field) return;
  field.input.value = event.newValue ?? '';
  refresh();
});

renderSaveStatus();
refresh();
byId('workspace').hidden = false;
