// Hermes hub UI — bootstrap, layout and routing (spec §2).
//
// Layout: a list pane (Home, mounted once after login and kept alive) and a main pane (chat,
// settings, or the desktop empty state). Below 900px only one pane shows: the main pane slides
// over the list. Route-bound sheets (#/new, …/info) open over whatever main view is mounted.

import { api } from './api.js';
import { bus, state, setNodes, replaceSessions, setRequests } from './store.js';
import { socket } from './ws.js';
import { navigate, back, onRoute, parseHash, historyIndex, startRouter, setPopGuard } from './router.js';
import { h, isDesktop, mq, fill, add, ls } from './util.js';
import { applyTheme } from './theme.js';
import { icon } from './ui/icons.js';
import { spinner } from './ui/controls.js';
import { closeTopLayer, closeAllLayers, layerCount } from './ui/layer.js';
import { mountLogin } from './views/login.js';
import { mountHome } from './views/home.js';
import { mountChat } from './chat/chat.js';
import { openInfoSheet } from './views/info.js';
import { openNewSession } from './views/newsession.js';
import { mountSettings } from './views/settings/index.js';
import { mountNodeDetail } from './views/settings/node.js';
import { mountLogs } from './views/settings/logs.js';
import { mountJoin } from './views/settings/join.js';
import { mountCron } from './views/settings/cron.js';
import { mountSkillsPage, mountMemoryPage } from './views/settings/pages.js';
import { mountAppSettings } from './views/settings/app.js';

applyTheme();

// --------------------------------------------------------------------------- viewport
// WebViews where 100dvh lags the keyboard: track visualViewport into --vvh.
function syncViewport() {
  const vv = window.visualViewport;
  const hgt = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${Math.round(hgt)}px`);
}
window.visualViewport?.addEventListener('resize', syncViewport);
window.addEventListener('resize', syncViewport);
syncViewport();

// --------------------------------------------------------------------------- shell
const appEl = document.getElementById('app');
const listPane = document.getElementById('list-pane');
const mainPane = document.getElementById('main-pane');
const loginRoot = document.getElementById('login-root');

let authed = false;
let home = null;                 // mounted Home controller
let main = null;                 // {key, depth, screen, ctl}
let sheet = null;                // {kind, key, ctl}
let loginCtl = null;

const ROUTES = [
  { re: /^\/$/, main: () => ({ key: 'home', depth: 0 }) },
  { re: /^\/s\/([^/]+)\/([^/]+)$/, main: (m) => chatMain(m) },
  { re: /^\/s\/([^/]+)\/([^/]+)\/info(?:\/(files|skills|memory))?$/, main: (m) => chatMain(m), sheet: (m, q) => ({ kind: 'info', key: `${dec(m[1])}#${dec(m[2])}`, node: dec(m[1]), sid: dec(m[2]), tab: m[3] || 'info', section: q.get('section') }) },
  { re: /^\/new$/, main: () => null, sheet: () => ({ kind: 'new', key: 'new' }) },
  { re: /^\/settings$/, main: () => ({ key: 'settings', depth: 1, mount: (el) => mountSettings(el, { logout }) }) },
  { re: /^\/settings\/nodes\/([^/]+)$/, main: (m) => ({ key: `settings/node/${m[1]}`, depth: 2, mount: (el) => mountNodeDetail(el, { node: dec(m[1]) }) }) },
  { re: /^\/settings\/nodes\/([^/]+)\/logs$/, main: (m) => ({ key: `settings/logs/${m[1]}`, depth: 3, mount: (el) => mountLogs(el, { node: dec(m[1]) }) }) },
  { re: /^\/settings\/join$/, main: () => ({ key: 'settings/join', depth: 2, mount: (el) => mountJoin(el) }) },
  { re: /^\/settings\/cron$/, main: () => ({ key: 'settings/cron', depth: 2, mount: (el) => mountCron(el) }) },
  { re: /^\/settings\/skills$/, main: (m, q) => ({ key: 'settings/skills', depth: 2, mount: (el) => mountSkillsPage(el, { node: q.get('node') }) }) },
  { re: /^\/settings\/memory$/, main: (m, q) => ({ key: 'settings/memory', depth: 2, mount: (el) => mountMemoryPage(el, { node: q.get('node') }) }) },
  { re: /^\/settings\/app$/, main: () => ({ key: 'settings/app', depth: 2, mount: (el) => mountAppSettings(el) }) },
];

const LEGACY = [[/^\/join$/, '#/settings/join'], [/^\/(messages|requests|nodes)(\/.*)?$/, '#/'], [/^\/n\/.*/, '#/']];

function dec(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function chatMain(m) {
  const node = dec(m[1]);
  const sid = dec(m[2]);
  return { key: `chat:${node}#${sid}`, depth: 1, chatKey: `${node}#${sid}`, mount: (el) => mountChat(el, { node, sid }) };
}

function resolve() {
  const { path, query } = parseHash();
  for (const [re, to] of LEGACY) if (re.test(path)) return { redirect: to };
  if (path === '/login') return { login: true, query };
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { main: r.main(m, query), sheet: r.sheet ? r.sheet(m, query) : null, path };
  }
  return { redirect: '#/' };
}

// --------------------------------------------------------------------------- routing
function route(how = 'push') {
  const r = resolve();
  if (r.redirect) { navigate(r.redirect, { replace: true }); return; }
  if (r.login) {
    if (authed) { navigate(r.query.get('next') || '#/', { replace: true }); return; }
    showLogin();
    return;
  }
  if (!authed) {
    navigate(`#/login?next=${encodeURIComponent(location.hash || '#/')}`, { replace: true });
    return;
  }
  hideLogin();
  ensureHome();
  // Transient overlays never survive a navigation.
  closeAllLayers();
  const target = r.main || (main ? null : { key: 'home', depth: 0 });
  if (target) setMain(target, how);
  setSheet(r.sheet);
  bus.emit('route', { path: r.path, mainKey: main?.key || 'home' });
}

function selectedKey() {
  return main?.chatKey || null;
}

function ensureHome() {
  if (home) return;
  home = mountHome(listPane, { selectedKey });
}

const DURATION = 220;

function setMain(target, how) {
  if (main && main.key === target.key) return;
  const prev = main;
  const goingBack = how === 'pop' && prev && target.depth <= prev.depth;
  const desktop = isDesktop();

  let screen = null;
  let ctl = null;
  if (target.key !== 'home') {
    screen = h('div', { class: 'screen' });
    add(mainPane, screen);
    try {
      ctl = target.mount(screen);
    } catch (err) {
      console.error('[router] view failed', err);
      fill(screen, h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: '화면을 열지 못했어요' }), h('p', { class: 'empty-body', text: String(err.message || err) })));
    }
  } else if (desktop) {
    screen = h('div', { class: 'screen' }, desktopEmpty());
    add(mainPane, screen);
  }
  main = { ...target, screen, ctl };
  appEl.dataset.pane = target.key === 'home' ? 'list' : 'main';
  document.body.dataset.view = target.key === 'home' ? 'home' : target.key.startsWith('chat:') ? 'chat' : 'settings';
  listPane.toggleAttribute('inert', !desktop && target.key !== 'home');
  document.title = target.key === 'home' ? 'Hermes' : document.title;

  const unmount = (p) => {
    if (!p) return;
    try { p.ctl?.destroy?.(); } catch (err) { console.error('[router] cleanup failed', err); }
    p.screen?.remove();
  };
  const animate = !desktop && !mq.reduced.matches && prev && how !== 'replace' && how !== 'init';
  if (!animate) { unmount(prev); return; }
  if (target.key === 'home') {
    // Main pane slides away to reveal the list; drop the old screen afterwards.
    setTimeout(() => unmount(prev), DURATION + 20);
    return;
  }
  if (prev.key === 'home') {
    screen.classList.add('enter-right');
    return;            // the pane itself slides in (CSS on [data-pane])
  }
  screen.classList.add(goingBack ? 'enter-left' : 'enter-right');
  if (prev.screen) prev.screen.classList.add(goingBack ? 'leave-right' : 'leave-left');
  setTimeout(() => unmount(prev), DURATION + 20);
}

function desktopEmpty() {
  return h('div', { class: 'desk-empty' },
    h('p', { class: 'empty-title', text: '세션을 선택하세요' }),
    h('p', { class: 'empty-body', text: '왼쪽 목록에서 세션을 고르거나 새 세션을 시작하세요.' }));
}

function setSheet(spec) {
  if (sheet && (!spec || spec.kind !== sheet.kind || spec.key !== sheet.key)) {
    const s = sheet;
    sheet = null;
    s.ctl.close?.() ?? s.ctl.sheet?.close();
  }
  if (!spec) return;
  if (sheet) {
    if (spec.kind === 'info') sheet.ctl.setTab(spec.tab, spec.section);
    return;
  }
  if (spec.kind === 'info') {
    const base = `#/s/${encodeURIComponent(spec.node)}/${encodeURIComponent(spec.sid)}`;
    const ctl = openInfoSheet({ ...spec, onRequestClose: () => closeRouteSheet(base) });
    sheet = { kind: 'info', key: spec.key, ctl, base };
  } else if (spec.kind === 'new') {
    const s = openNewSession({ onRequestClose: () => closeRouteSheet('#/') });
    sheet = { kind: 'new', key: 'new', ctl: s, base: '#/' };
  }
}

function closeRouteSheet(base) {
  if (historyIndex() > 0) history.back();
  else navigate(base, { replace: true });
}

// --------------------------------------------------------------------------- back / keys
window.__omniBack = () => {
  try {
    if (closeTopLayer()) return true;
    const { path } = parseHash();
    if (!authed) return false;
    if (sheet) {
      closeRouteSheet(sheet.base);
      return true;
    }
    if (path !== '/' && path !== '') { back('#/'); return true; }
    if (home?.handleBack()) return true;
    return false;
  } catch (err) {
    console.error('[back]', err);
    return false;
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (layerCount()) return;                // overlays handle their own Escape
  if (sheet) { e.preventDefault(); window.__omniBack(); }
});

// --------------------------------------------------------------------------- connection bar
const connBar = document.getElementById('conn-bar');
let connTimer = 0;
let connShown = false;
let connHideTimer = 0;

function renderConn({ state: s, attempts }) {
  clearTimeout(connHideTimer);
  if (!authed) { connBar.hidden = true; connShown = false; return; }
  if (s === 'open') {
    clearTimeout(connTimer);
    connTimer = 0;
    if (connShown) {
      connBar.className = 'conn-bar ok';
      fill(connBar, icon('check', 14), h('span', { text: '다시 연결됐어요' }));
      connHideTimer = setTimeout(() => { connBar.hidden = true; connShown = false; }, 2000);
    } else connBar.hidden = true;
    return;
  }
  const paint = () => {
    connShown = true;
    connBar.hidden = false;
    if (state.connAttempts >= 3) {
      connBar.className = 'conn-bar err';
      fill(connBar, h('span', { text: '연결이 끊겼어요 · ' }), h('span', { class: 'conn-retry', text: '다시 시도' }));
    } else {
      connBar.className = 'conn-bar';
      fill(connBar, spinner(12), h('span', { text: '연결 중…' }));
    }
  };
  if (connShown) paint();
  else if (!connTimer) connTimer = setTimeout(() => { connTimer = 0; if (state.conn !== 'open') paint(); }, 1500);
  void attempts;
}
connBar.addEventListener('click', () => socket.kick());
bus.on('conn', renderConn);

// --------------------------------------------------------------------------- auth
function showLogin() {
  appEl.hidden = true;
  loginRoot.hidden = false;
  if (!loginCtl) loginCtl = mountLogin(loginRoot, { onLogin: (user) => afterLogin(user, true) });
}

function hideLogin() {
  appEl.hidden = false;
  if (loginRoot.hidden) return;
  loginRoot.hidden = true;
  loginCtl?.destroy?.();
  loginCtl = null;
  fill(loginRoot);
}

async function primeData() {
  const [nodes, sessions] = await Promise.allSettled([api.nodes(), api.sessions()]);
  if (nodes.status === 'fulfilled') setNodes(nodes.value.nodes || []);
  if (sessions.status === 'fulfilled' && !state.sessionsLoaded) {
    replaceSessions(sessions.value.sessions || []);
  }
}

// Whether this browser may hold a session cookie (the cookie itself is HttpOnly). Without one,
// boot goes straight to the login page instead of asking /api/me for a 401 the console logs.
const AUTH_HINT = 'omni.auth';
function mayBeAuthed() {
  try {
    const v = localStorage.getItem(AUTH_HINT);
    if (v === '1') return true;
    if (v === '0') return false;
    // No hint yet (a browser that logged in before the hint existed keeps other omni.* keys).
    for (let i = 0; i < localStorage.length; i += 1) if (localStorage.key(i)?.startsWith('omni.')) return true;
    return false;
  } catch { return true; }
}

function afterLogin(user, fromForm = false) {
  authed = true;
  ls.set(AUTH_HINT, '1');
  state.user = user || state.user;
  socket.start();
  primeData();
  if (fromForm) {
    const next = parseHash().query.get('next');
    navigate(next && next.startsWith('#/') && !next.startsWith('#/login') ? next : '#/', { replace: true });
  }
}

function teardown() {
  closeAllLayers();
  if (sheet) { sheet.ctl.close?.(); sheet = null; }
  if (main) { try { main.ctl?.destroy?.(); } catch { /* ignore */ } main.screen?.remove(); main = null; }
  if (home) { home.destroy(); home = null; fill(listPane); }
  state.sessions = new Map();
  state.sessionsLoaded = false;
  setRequests({ count: 0, items: [] });
}

bus.on('unauthorized', () => {
  if (!authed) return;
  authed = false;
  ls.set(AUTH_HINT, '0');
  socket.stop();
  teardown();
  const current = location.hash && !location.hash.startsWith('#/login') ? location.hash : '#/';
  navigate(`#/login?next=${encodeURIComponent(current)}`, { replace: true });
});

export async function logout() {
  try { await api.logout(); } catch { /* cookie may already be gone */ }
  authed = false;
  ls.set(AUTH_HINT, '0');
  socket.stop();
  teardown();
  navigate('#/login', { replace: true });
}

// Breakpoint changes: re-evaluate panes (desktop shows both; mobile one).
mq.desktop.addEventListener?.('change', () => {
  if (!authed || !main) return;
  const key = main.key;
  if (key === 'home') {
    main.screen?.remove();
    main.screen = null;
    if (isDesktop()) { main.screen = h('div', { class: 'screen' }, desktopEmpty()); add(mainPane, main.screen); }
  }
  listPane.toggleAttribute('inert', !isDesktop() && key !== 'home');
  bus.emit('route', { mainKey: key });
});

// --------------------------------------------------------------------------- boot
async function boot() {
  if (mayBeAuthed()) {
    try {
      const me = await api.me();
      afterLogin(me.user);
    } catch (err) {
      authed = false;
      if (err.status === 401) ls.set(AUTH_HINT, '0');
      else console.warn('[boot] /api/me failed', err);
    }
  }
  document.getElementById('boot')?.remove();
  // Browser Back closes the topmost overlay first, like the Android back button (§2.2).
  setPopGuard(() => closeTopLayer());
  startRouter();
  onRoute(route);
  route('init');
}

boot();
