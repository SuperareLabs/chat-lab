const INTRO_STORAGE_KEY = 'chat-lab:opening:v1';
const INTRO_HOLD_MS = 1150;
const INTRO_EXIT_MS = 350;

const INTRO_CONTENT = `
  <div class="lab-intro-paper" aria-hidden="true"></div>
  <header class="lab-intro-header">
    <span class="lab-intro-wordmark" aria-hidden="true">CHAT<span>LAB</span></span>
    <button class="lab-intro-skip" type="button" autofocus>
      <span>跳过开场</span><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </header>
  <div class="lab-intro-composition">
    <div class="lab-intro-art" aria-hidden="true">
      <svg class="lab-intro-symbol" width="300" height="260" viewBox="0 0 300 260" fill="none">
        <circle class="lab-intro-orbit" cx="150" cy="130" r="104"/>
        <path class="lab-intro-guides" d="M150 18v9m0 206v9M38 130h9m206 0h9M73 53l6 6m142 142 6 6M73 207l6-6M221 59l6-6"/>
        <path class="lab-intro-left" pathLength="1" d="M77 93a21 21 0 0 1 21-21h65a21 21 0 0 1 21 21v42a21 21 0 0 1-21 21h-25l-27 22v-22H98a21 21 0 0 1-21-21Z"/>
        <path class="lab-intro-right" pathLength="1" d="M119 122a21 21 0 0 1 21-21h63a21 21 0 0 1 21 21v39a21 21 0 0 1-21 21h-11v22l-27-22h-25a21 21 0 0 1-21-21Z"/>
        <circle class="lab-intro-dot lab-intro-dot-left" cx="150" cy="130" r="4.5"/>
        <circle class="lab-intro-dot lab-intro-dot-right" cx="150" cy="130" r="4.5"/>
      </svg>
    </div>
    <p class="lab-intro-kicker">A SPACE FOR CONVERSATION</p>
    <h2 class="lab-intro-title" id="lab-intro-title"><span>对话，</span><span>自有回响。</span></h2>
    <p class="lab-intro-subtitle">角色<span>·</span>上下文<span>·</span>记忆</p>
  </div>
  <footer class="lab-intro-footer"><span>全Agent轻量聊天实验台</span><span class="lab-intro-rule" aria-hidden="true"></span><span aria-hidden="true">01 — START</span></footer>`;

/** The application is visible by default; this optional opening never gates data loading. */
export function installMotionIntro({ doc = document, win = window } = {}) {
  const replay = doc.getElementById('intro-replay');
  const root = doc.documentElement;
  const motion = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let active = null;
  let entranceTimer = null;
  let destroyed = false;
  let seen = false;
  try { seen = win.sessionStorage.getItem(INTRO_STORAGE_KEY) === '1'; } catch { /* Storage can be unavailable in private contexts. */ }

  function remember() {
    seen = true;
    try { win.sessionStorage.setItem(INTRO_STORAGE_KEY, '1'); } catch { /* A blocked store must not block the workspace. */ }
  }

  function settleWorkspace() {
    if (entranceTimer !== null) win.clearTimeout(entranceTimer);
    entranceTimer = null;
    root.removeAttribute('data-lab-enter');
  }

  function revealWorkspace() {
    settleWorkspace();
    if (destroyed || motion?.matches || doc.hidden) return;
    root.setAttribute('data-lab-enter', '');
    entranceTimer = win.setTimeout(settleWorkspace, 720);
  }

  function removeOpening(run, animateWorkspace = true) {
    if (!run || active !== run) return;
    active = null;
    for (const timer of run.timers) win.clearTimeout(timer);
    for (const [element, name, handler] of run.listeners) element.removeEventListener(name, handler);
    try { if (run.dialog.open) run.dialog.close(); } catch { /* Removal also releases native dialog modality. */ }
    run.dialog.remove();
    if (animateWorkspace) revealWorkspace();
    else settleWorkspace();
    if (run.manual && run.previousFocus?.isConnected) run.previousFocus.focus({ preventScroll: true });
  }

  function finish(run, immediate = false) {
    if (!run || active !== run || run.leaving) return;
    run.leaving = true;
    if (immediate || motion?.matches || doc.hidden) {
      removeOpening(run, !doc.hidden);
      return;
    }
    run.dialog.dataset.state = 'leaving';
    // This timeout is the authority; a missing CSS animation event cannot trap the page.
    run.timers.push(win.setTimeout(() => removeOpening(run), INTRO_EXIT_MS));
  }

  function play({ manual = false } = {}) {
    if (destroyed || active) return false;
    remember();
    if (doc.hidden || (!manual && motion?.matches) || doc.querySelector('dialog[open]')) {
      settleWorkspace();
      return false;
    }
    const dialog = doc.createElement('dialog');
    if (typeof dialog.showModal !== 'function') { revealWorkspace(); return false; }
    dialog.className = 'lab-intro-dialog';
    dialog.setAttribute('aria-labelledby', 'lab-intro-title');
    dialog.setAttribute('aria-describedby', 'lab-intro-description');
    dialog.dataset.state = 'entering';
    if (motion?.matches) dialog.dataset.motion = 'reduced';
    dialog.innerHTML = INTRO_CONTENT;
    dialog.querySelector('.lab-intro-subtitle').id = 'lab-intro-description';
    doc.body.append(dialog);
    // If the stylesheet cannot load, leave the normal application usable immediately.
    if (win.getComputedStyle(dialog).getPropertyValue('--lab-intro-ready').trim() !== '1') {
      dialog.remove();
      revealWorkspace();
      return false;
    }
    const run = { dialog, manual, previousFocus: doc.activeElement, leaving: false, timers: [], listeners: [] };
    active = run;
    const listen = (element, name, handler) => {
      element.addEventListener(name, handler);
      run.listeners.push([element, name, handler]);
    };
    listen(dialog.querySelector('.lab-intro-skip'), 'click', () => finish(run, true));
    listen(dialog, 'cancel', event => { event.preventDefault(); finish(run, true); });
    listen(dialog, 'close', () => removeOpening(run));
    // Install the guard before opening. Even an interrupted entrance gets a final state.
    run.timers.push(win.setTimeout(() => removeOpening(run), INTRO_HOLD_MS + INTRO_EXIT_MS + 300));
    try {
      dialog.showModal();
      run.timers.push(win.setTimeout(() => finish(run), motion?.matches ? 200 : INTRO_HOLD_MS));
      return true;
    } catch {
      removeOpening(run);
      return false;
    }
  }

  const onReplay = () => play({ manual: true });
  const onVisibility = () => { if (doc.hidden) { removeOpening(active, false); settleWorkspace(); } };
  const onPageRestore = event => {
    if (event.type === 'pageshow' && !event.persisted) return;
    removeOpening(active, false);
    settleWorkspace();
  };
  const onPreference = () => { if (motion.matches) { removeOpening(active, false); settleWorkspace(); } };
  replay?.addEventListener('click', onReplay);
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pageshow', onPageRestore);
  win.addEventListener('pagehide', onPageRestore);
  motion?.addEventListener?.('change', onPreference);

  // Module scripts run after parsing; there is no network/font/model prerequisite.
  if (!seen) play();
  else revealWorkspace();

  return {
    play,
    destroy() {
      destroyed = true;
      removeOpening(active, false);
      settleWorkspace();
      replay?.removeEventListener('click', onReplay);
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pageshow', onPageRestore);
      win.removeEventListener('pagehide', onPageRestore);
      motion?.removeEventListener?.('change', onPreference);
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  try { installMotionIntro(); } catch { /* Presentation enhancement must never prevent normal application startup. */ }
}
