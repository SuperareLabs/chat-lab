const nodeWidth = 158;
const nodeHeight = 94;

const routes = [
  { id: 'input-context', from: 'input', to: 'context', kind: 'main' },
  { id: 'context-recommendation', from: 'context', to: 'recommendation', kind: 'tool' },
  { id: 'recommendation-decision', from: 'recommendation', to: 'decision', kind: 'tool', label: '判定回执' },
  { id: 'decision-reply', from: 'decision', to: 'reply', kind: 'main' },
  { id: 'click', from: 'reply', to: 'handoff', kind: 'action', label: '出卡后点击' },
  { id: 'memory', from: 'reply', to: 'memory', kind: 'background', label: '会话结算后' },
];

const layouts = {
  wide: {
    width: 858, height: 608,
    nodes: { input: [26, 111], context: [214, 111], recommendation: [402, 111], decision: [650, 111],
      reply: [650, 318], handoff: [402, 318], memory: [650, 487] },
    edges: {
      'input-context': [[184, 158], [214, 158]],
      'context-recommendation': [[372, 158], [402, 158]],
      'recommendation-decision': [[560, 158], [650, 158]],
      'decision-reply': [[729, 205], [729, 318]],
      click: [[650, 365], [560, 365]],
      memory: [[729, 412], [729, 487]],
    },
    labels: { 'recommendation-decision': [605, 139], click: [605, 346], memory: [778, 448] },
  },
  compact: {
    width: 425, height: 706,
    nodes: { input: [23, 47], context: [244, 47], recommendation: [23, 208], decision: [244, 208],
      reply: [244, 387], handoff: [23, 387], memory: [244, 575] },
    edges: {
      'input-context': [[181, 94], [244, 94]],
      'context-recommendation': [[323, 141], [323, 174], [102, 174], [102, 208]],
      'recommendation-decision': [[181, 255], [244, 255]],
      'decision-reply': [[323, 302], [323, 387]],
      click: [[244, 434], [181, 434]],
      memory: [[323, 481], [323, 575]],
    },
    labels: { 'recommendation-decision': [212, 237], click: [212, 416], memory: [367, 528] },
  },
};

const strokes = {
  main: { color: '#597653', dash: [] },
  tool: { color: '#8b6235', dash: [6, 4] },
  action: { color: '#496e8b', dash: [] },
  background: { color: '#65706a', dash: [2, 5] },
};

function routeLine(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (let index = 1; index < points.length - 1; index++) {
    ctx.arcTo(...points[index], ...points[index + 1], 9);
  }
  ctx.lineTo(...points.at(-1));
  ctx.stroke();

  const [x, y] = points.at(-1);
  const [previousX, previousY] = points.at(-2);
  const angle = Math.atan2(y - previousY, x - previousX);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 8 * Math.cos(angle - .52), y - 8 * Math.sin(angle - .52));
  ctx.lineTo(x - 8 * Math.cos(angle + .52), y - 8 * Math.sin(angle + .52));
  ctx.closePath();
  ctx.fill();
}

export function bindArchitectureGraph({ viewport, canvas, world, onInteraction }) {
  const ctx = canvas.getContext('2d');
  const view = { x: 0, y: 0, scale: 1 };
  let items = new Map();
  let layout;
  let selected = '';
  let size = { width: 0, height: 0 };
  let pan;

  const minus = document.getElementById('graph-zoom-out');
  const plus = document.getElementById('graph-zoom-in');
  const fitButton = document.getElementById('graph-fit');
  const zoomReadout = document.getElementById('graph-zoom-level');
  const minZoom = .24;
  const maxZoom = 2.2;

  function draw() {
    if (!layout) return;
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const percent = `${Math.round(view.scale * 100)}%`;
    if (zoomReadout.textContent !== percent) zoomReadout.textContent = percent;
    minus.disabled = view.scale <= minZoom;
    plus.disabled = view.scale >= maxZoom;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    if (!ctx) return;

    const ratio = canvas.width / size.width;
    ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    ctx.clearRect(-view.x / view.scale, -view.y / view.scale, size.width / view.scale, size.height / view.scale);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const { id, from, to, kind, label } of routes) {
      if (!items.has(from) || !items.has(to)) continue;
      const connected = selected === from || selected === to;
      const { color, dash } = strokes[kind];
      ctx.globalAlpha = connected || kind === 'main' ? 1 : .78;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = connected ? 2.6 : 1.8;
      ctx.setLineDash(dash);
      routeLine(ctx, layout.edges[id]);
      if (!label) continue;
      const [x, y] = layout.labels[id];
      const labelWidth = ctx.measureText(label).width + 12;
      ctx.fillStyle = '#f7f8f0';
      ctx.fillRect(x - labelWidth / 2, y - 9, labelWidth, 18);
      ctx.fillStyle = color;
      ctx.fillText(label, x, y);
    }
    ctx.globalAlpha = 1;
  }

  function fit() {
    if (!layout) return;
    view.scale = Math.max(minZoom, Math.min(1.18, (size.width - 16) / layout.width, (size.height - 16) / layout.height));
    view.x = (size.width - layout.width * view.scale) / 2;
    view.y = (size.height - layout.height * view.scale) / 2;
    draw();
  }

  function placeNodes() {
    for (const [id, item] of items) {
      const [x, y] = layout.nodes[id];
      Object.assign(item.style, { left: `${x}px`, top: `${y}px`, width: `${nodeWidth}px`, height: `${nodeHeight}px` });
    }
  }

  function resize() {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    const previous = size;
    size = { width, height };
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const next = width < 620 ? layouts.compact : layouts.wide;
    if (next !== layout) {
      layout = next;
      placeNodes();
      fit();
    } else {
      view.x += (width - previous.width) / 2;
      view.y += (height - previous.height) / 2;
      draw();
    }
  }

  function zoom(factor, x = size.width / 2, y = size.height / 2) {
    if (!layout) return;
    onInteraction();
    const next = Math.min(maxZoom, Math.max(minZoom, view.scale * factor));
    const ratio = next / view.scale;
    view.x = x - (x - view.x) * ratio;
    view.y = y - (y - view.y) * ratio;
    view.scale = next;
    draw();
  }

  minus.addEventListener('click', () => zoom(1 / 1.24));
  plus.addEventListener('click', () => zoom(1.24));
  fitButton.addEventListener('click', () => { onInteraction(); fit(); });
  viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const bounds = viewport.getBoundingClientRect();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoom(Math.exp(-delta * .008), event.clientX - bounds.left, event.clientY - bounds.top);
  }, { passive: false });
  viewport.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('.graph-node')) return;
    onInteraction();
    pan = { id: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y };
    viewport.classList.add('is-panning');
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', event => {
    if (pan?.id !== event.pointerId) return;
    view.x = event.clientX - pan.x;
    view.y = event.clientY - pan.y;
    draw();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    viewport.addEventListener(type, event => {
      if (pan?.id !== event.pointerId) return;
      pan = null;
      viewport.classList.remove('is-panning');
    });
  }
  new ResizeObserver(resize).observe(viewport);

  return {
    setItems(nodes) {
      items = new Map(nodes.filter(({ id }) => Object.hasOwn(layouts.wide.nodes, id)).map(({ id, item }) => [id, item]));
      world.replaceChildren(...items.values());
      if (layout) placeNodes();
      resize();
      fit();
    },
    select(id) {
      selected = id;
      draw();
    },
    isPanning: () => Boolean(pan),
    reveal(id) {
      const position = layout?.nodes[id];
      if (!position || !items.has(id)) return;
      const [x, y] = position;
      const left = view.x + x * view.scale;
      const top = view.y + y * view.scale;
      const right = left + nodeWidth * view.scale;
      const bottom = top + nodeHeight * view.scale;
      if (left >= 8 && right <= size.width - 8 && top >= 8 && bottom <= size.height - 8) return;
      view.x = (size.width - nodeWidth * view.scale) / 2 - x * view.scale;
      view.y = (size.height - nodeHeight * view.scale) / 2 - y * view.scale;
      draw();
    },
  };
}
