// Hermes Omni hub UI — bootstrap and hash router.
// Routes: #/login  #/  #/n/<node>  #/s/<node>/<stored_id>  #/messages[?address=]  #/requests  #/join

import { api } from './api.js';
import { bus, setNodes, setRequestsCount, state } from './store.js';
import { socket } from './ws.js';
import { clear } from './util.js';
import loginView from './views/login.js';
import nodesView from './views/nodes.js';
import nodeView from './views/node.js';
import chatView from './views/chat.js';
import messagesView from './views/messages.js';
import requestsView from './views/requests.js';
import joinView from './views/join.js';

const ROUTES = [
  { re: /^\/login$/, view: loginView, tab: null, public: true, name: 'login' },
  { re: /^\/?$/, view: nodesView, tab: 'nodes', name: 'nodes' },
  { re: /^\/n\/([^/]+)$/, view: nodeView, tab: 'nodes', keys: ['node'], name: 'node' },
  { re: /^\/s\/([^/]+)\/([^/]+)$/, view: chatView, tab: 'nodes', keys: ['node', 'sid'], name: 'chat' },
  { re: /^\/messages$/, view: messagesView, tab: 'messages', name: 'messages' },
  { re: /^\/requests$/, view: requestsView, tab: 'requests', name: 'requests' },
  { re: /^\/join$/, view: joinView, tab: 'join', name: 'join' },
];

const main = document.getElementById('main');
let cleanup = null;
let authed = false;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: new URLSearchParams(qs) };
}

export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) { route(); return; }
  if (replace) {
    history.replaceState(null, '', target);
    route();
  } else {
    location.hash = target;
  }
}

function route() {
  const { path, query } = parseHash();
  let match = null;
  let params = {};
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) {
      match = r;
      (r.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      break;
    }
  }
  if (!match) {
    navigate('#/', { replace: true });
    return;
  }
  if (!match.public && !authed) {
    navigate(`#/login?next=${encodeURIComponent(location.hash || '#/')}`, { replace: true });
    return;
  }
  if (match.name === 'login' && authed) {
    navigate(query.get('next') || '#/', { replace: true });
    return;
  }

  if (cleanup) {
    try { cleanup(); } catch (err) { console.error('[router] cleanup failed', err); }
    cleanup = null;
  }
  clear(main);
  document.body.dataset.view = match.name;
  document.title = 'Hermes Omni';
  setActiveTab(match.tab);
  const ctx = {
    params,
    query,
    navigate,
    onLogin: afterLogin,
    logout,
    setTitle: (t) => { document.title = t ? `${t} · Hermes Omni` : 'Hermes Omni'; },
  };
  try {
    cleanup = match.view(main, ctx) || null;
  } catch (err) {
    console.error('[router] view failed', err);
    main.textContent = `Something went wrong: ${err.message}`;
  }
  // Move focus for screen readers / keyboard users without scrolling the page.
  if (match.name !== 'chat') {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
}

function setActiveTab(tab) {
  const tabs = document.getElementById('tabs');
  tabs.hidden = !authed;
  for (const a of tabs.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// --- top bar -------------------------------------------------------------------------------
const CONN_LABEL = { open: 'Live', connecting: 'Connecting…', closed: 'Offline' };

function renderConn(s) {
  const el = document.getElementById('conn');
  el.dataset.state = s;
  el.querySelector('.conn-label').textContent = CONN_LABEL[s] || s;
  el.title = s === 'open' ? 'Connected to hub (live updates)' : s === 'connecting' ? 'Connecting to hub…' : 'Disconnected — retrying';
  el.hidden = !authed;
}

function renderBadge(n) {
  const el = document.getElementById('req-badge');
  el.hidden = !authed || !n;
  el.querySelector('.req-count').textContent = n > 99 ? '99+' : String(n);
  el.setAttribute('aria-label', `Pending requests: ${n}`);
}

bus.on('conn', renderConn);
bus.on('requests-count', renderBadge);

// --- auth ----------------------------------------------------------------------------------
async function primeData() {
  // The WS pushes both of these too; fetching once makes the first paint independent of WS timing.
  const [nodes, reqs] = await Promise.allSettled([api.nodes(), api.requests()]);
  if (nodes.status === 'fulfilled' && !state.nodesLoaded) setNodes(nodes.value.nodes || []);
  if (reqs.status === 'fulfilled') setRequestsCount((reqs.value.requests || []).length);
}

function afterLogin(user) {
  authed = true;
  state.user = user || state.user;
  renderConn(state.conn);
  renderBadge(state.requestsCount);
  socket.start();
  primeData();
}

bus.on('unauthorized', () => {
  if (!authed && parseHash().path === '/login') return;
  authed = false;
  state.user = null;
  state.nodesLoaded = false;
  socket.stop();
  renderConn('closed');
  renderBadge(0);
  const current = location.hash && !location.hash.startsWith('#/login') ? location.hash : '#/';
  navigate(`#/login?next=${encodeURIComponent(current)}`, { replace: true });
});

export async function logout() {
  try { await api.logout(); } catch { /* cookie may already be gone */ }
  authed = false;
  state.user = null;
  state.nodesLoaded = false;
  socket.stop();
  renderConn('closed');
  renderBadge(0);
  navigate('#/login', { replace: true });
}

async function boot() {
  try {
    const me = await api.me();
    afterLogin(me.user);
  } catch (err) {
    authed = false;
    if (err.status !== 401) console.warn('[boot] /api/me failed', err);
  }
  window.addEventListener('hashchange', route);
  route();
}

boot();
