// Global client state + a tiny event bus. Views subscribe with `bus.on(type, fn)` (returns an
// unsubscribe function) and must unsubscribe in their cleanup.
//
// Events: "nodes", "sessions" (index changed; batched per frame), "requests", "conn",
// "unauthorized", "seen", plus every WS frame as "ws:<type>".

import { ls } from './util.js';

class Bus {
  constructor() { this.handlers = new Map(); }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, data) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (err) { console.error(`[bus] handler for ${type} failed`, err); }
    }
  }
}

export const bus = new Bus();

export const state = {
  user: null,
  hubVersion: '',
  /** NodeInfo[] (+ online, last_seen, proto). */
  nodes: [],
  nodesLoaded: false,
  /** key "node#sid" → HubRow */
  sessions: new Map(),
  sessionsLoaded: false,
  /** {count, items:[{node, stored_id, title, request_id, method, at}]} */
  requests: { count: 0, items: [] },
  conn: 'closed',
  connAttempts: 0,
};

// --------------------------------------------------------------------------- nodes

export function setNodes(nodes) {
  state.nodes = Array.isArray(nodes) ? nodes.filter((n) => n && n.node_id) : [];
  state.nodesLoaded = true;
  // Overlay online state onto rows so offline nodes grey out immediately.
  let changed = false;
  for (const row of state.sessions.values()) {
    const n = findNode(row.node);
    if (n && row.node_online !== !!n.online) { row.node_online = !!n.online; changed = true; }
    if (n && n.display_name && row.node_name !== n.display_name) { row.node_name = n.display_name; changed = true; }
  }
  bus.emit('nodes', state.nodes);
  if (changed) sessionsChanged();
}

export function findNode(nodeId) {
  return state.nodes.find((n) => n.node_id === nodeId) || null;
}

export function nodeName(nodeId) {
  return findNode(nodeId)?.display_name || nodeId;
}

export function isOnline(nodeId) {
  return !!findNode(nodeId)?.online;
}

/** Proto ≥ 2 nodes support the §5b passthrough features. Unknown proto counts as current. */
export function nodeSupportsFeatures(nodeId) {
  const n = findNode(nodeId);
  if (!n) return true;
  return !(Number.isFinite(n.proto) && n.proto < 2);
}

export function onlineNodes() {
  return state.nodes.filter((n) => n.online);
}

// --------------------------------------------------------------------------- sessions

let emitQueued = false;
function sessionsChanged() {
  if (emitQueued) return;
  emitQueued = true;
  requestAnimationFrame(() => {
    emitQueued = false;
    bus.emit('sessions', state.sessions);
  });
}

function rowKey(r) {
  return r.key || `${r.node}#${r.stored_id}`;
}

function normalizeRow(r) {
  if (!r.key) r.key = rowKey(r);
  if (!r.node_name) r.node_name = findNode(r.node)?.display_name || r.node;
  const n = findNode(r.node);
  if (n) r.node_online = !!n.online;
  else if (typeof r.node_online !== 'boolean') r.node_online = true;
  return r;
}

export function replaceSessions(rows) {
  state.sessions = new Map();
  for (const r of rows || []) {
    if (r && r.node && r.stored_id) state.sessions.set(rowKey(r), normalizeRow(r));
  }
  state.sessionsLoaded = true;
  baselineSeen(state.sessions.values());
  sessionsChanged();
}

export function upsertSessions(rows) {
  const fresh = [];
  for (const r of rows || []) {
    if (!r || !r.node || !r.stored_id) continue;
    const key = rowKey(r);
    if (!state.sessions.has(key)) fresh.push(r);
    state.sessions.set(key, normalizeRow(r));
  }
  if (fresh.length) baselineSeen(fresh);
  sessionsChanged();
}

export function removeSessions(list) {
  for (const x of list || []) {
    if (!x) continue;
    const key = typeof x === 'string' ? x : (x.key || `${x.node}#${x.stored_id}`);
    state.sessions.delete(key);
  }
  sessionsChanged();
}

/** Local optimistic patch (rename/pin) until the hub upsert arrives. */
export function patchSession(key, patch) {
  const r = state.sessions.get(key);
  if (!r) return;
  Object.assign(r, patch);
  sessionsChanged();
}

export function getSession(node, sid) {
  return state.sessions.get(`${node}#${sid}`) || null;
}

export function needsYou(row) {
  if (!row) return false;
  return row.pending_requests > 0 || (row.pending_requests === null && row.status === 'waiting');
}

export function rowTitle(row) {
  if (!row) return '새 세션';
  if (row.title) return row.title;
  const fp = typeof row.first_prompt === 'string' ? row.first_prompt.trim().split('\n', 1)[0] : '';
  if (fp) return fp.length > 60 ? `${fp.slice(0, 59)}…` : fp;
  return '새 세션';
}

export const NO_FOLDER = '폴더 없음';

const normPath = (p) => String(p || '').replace(/\/+$/, '') || '/';

/**
 * True when `cwd` is "no folder": unset, or the node's default working directory (its workspace
 * or a project root itself). Sessions started with "폴더 없음" run there.
 */
export function isNoFolder(nodeId, cwd) {
  if (!cwd) return true;
  const n = findNode(nodeId);
  if (!n) return false;
  const p = normPath(cwd);
  return [n.workspace, ...(Array.isArray(n.project_roots) ? n.project_roots : [])]
    .some((r) => r && normPath(r) === p);
}

export function folderLabel(row) {
  if (row?.folder?.name) return row.folder.name;
  if (isNoFolder(row?.node, row?.cwd)) return NO_FOLDER;
  const parts = String(row.cwd).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || row.cwd;
}

const SOURCE_LABELS = {
  telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp', signal: 'Signal',
  email: 'Email', desktop: 'Desktop', cli: 'CLI', api_server: 'API',
};

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || '';
}

/** Sessions that need the user, oldest wait first (for the attention pill). */
export function attentionRows() {
  const at = new Map();
  for (const it of state.requests.items || []) {
    const k = `${it.node}#${it.stored_id}`;
    const t = Number(it.at) || 0;
    if (!at.has(k) || t < at.get(k)) at.set(k, t);
  }
  const rows = [...state.sessions.values()].filter(needsYou);
  rows.sort((a, b) => (at.get(a.key) ?? a.last_active ?? 0) - (at.get(b.key) ?? b.last_active ?? 0));
  return rows;
}

// --------------------------------------------------------------------------- requests

export function setRequests(frame) {
  state.requests = {
    count: Number(frame?.count) || 0,
    items: Array.isArray(frame?.items) ? frame.items : [],
  };
  bus.emit('requests', state.requests);
}

// --------------------------------------------------------------------------- connection

export function setConn(s, attempts = 0) {
  if (s === state.conn && attempts === state.connAttempts) return;
  state.conn = s;
  state.connAttempts = attempts;
  bus.emit('conn', { state: s, attempts });
}

// --------------------------------------------------------------------------- unread ("seen")

const SEEN_KEY = 'omni.seen.v1';
const SEEN_MAX = 500;
let seen = ls.json(SEEN_KEY, {}) || {};

export function isUnread(row) {
  if (!row || !row.last_active) return false;
  if (row.preview?.role === 'user') return false;
  const s = seen[row.key];
  if (s === undefined) return false;   // never-seen rows are not "new" — avoids a wall of dots
  return row.last_active > s;
}

export function markSeen(key, lastActive) {
  if (!key) return;
  const v = Number(lastActive) || Date.now() / 1000;
  if (seen[key] !== undefined && seen[key] >= v) return;
  seen[key] = v;
  const keys = Object.keys(seen);
  if (keys.length > SEEN_MAX) {
    keys.sort((a, b) => seen[a] - seen[b]);
    for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete seen[k];
  }
  ls.setJson(SEEN_KEY, seen);
  bus.emit('seen', key);
  sessionsChanged();
}

/** First sight of a row records a baseline, so only activity after that shows a dot. */
export function baselineSeen(rows) {
  let changed = false;
  for (const r of rows) {
    if (seen[r.key] === undefined && r.last_active) { seen[r.key] = r.last_active; changed = true; }
  }
  if (changed) ls.setJson(SEEN_KEY, seen);
}

export function moveSeen(oldKey, newKey) {
  if (seen[oldKey] !== undefined) {
    seen[newKey] = seen[oldKey];
    delete seen[oldKey];
    ls.setJson(SEEN_KEY, seen);
  }
}
