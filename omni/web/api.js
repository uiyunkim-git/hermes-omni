// REST wrapper for the hub browser API (design §6). Every call sends `X-Omni: 1` and JSON;
// a 401 emits "unauthorized" on the bus (app.js routes to the login view) and rejects.

import { bus } from './store.js';
import { enc } from './util.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || `http_${status}`;
  }
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * @param {string} method
 * @param {string} path  absolute path starting with /api
 * @param {object} [body]
 * @param {{timeout?: number, quiet401?: boolean}} [opts]
 */
export async function request(method, path, body, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? DEFAULT_TIMEOUT_MS);
  const init = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Omni': '1', Accept: 'application/json' },
    signal: ctrl.signal,
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let resp;
  try {
    resp = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, err.name === 'AbortError' ? 'timeout' : 'network', err.name === 'AbortError' ? 'Request timed out' : 'Network error — hub unreachable');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  const text = await resp.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (resp.status === 401) {
    if (!opts.quiet401) bus.emit('unauthorized');
    throw new ApiError(401, data?.error?.code || 'unauthorized', data?.error?.message || 'Please sign in');
  }
  if (!resp.ok) {
    const e = data?.error;
    throw new ApiError(resp.status, e?.code, e?.message || (typeof e === 'string' ? e : `HTTP ${resp.status}`));
  }
  return data ?? {};
}

const get = (p, o) => request('GET', p, undefined, o);
const post = (p, b, o) => request('POST', p, b, o);

const sess = (node, sid) => `/api/nodes/${enc(node)}/sessions/${enc(sid)}`;

export const api = {
  login: (username, password) => post('/api/login', { username, password }, { quiet401: true }),
  logout: () => post('/api/logout', {}),
  me: () => get('/api/me', { quiet401: true }),

  nodes: () => get('/api/nodes'),
  forgetNode: (node) => request('DELETE', `/api/nodes/${enc(node)}`, {}),
  createProject: (node, root, name) => post(`/api/nodes/${enc(node)}/projects`, { root, name }),
  rescan: (node) => post(`/api/nodes/${enc(node)}/projects/rescan`, {}, { timeout: 60000 }),

  sessions: (node, path) => get(`/api/nodes/${enc(node)}/sessions${path ? `?path=${enc(path)}` : ''}`),
  /** {path, canonical?, title?} → {stored_id, title, created?} */
  openSession: (node, body) => post(`/api/nodes/${enc(node)}/sessions`, body, { timeout: 60000 }),
  messages: (node, sid, limit = 200) => get(`${sess(node, sid)}/messages?limit=${limit}`),
  prompt: (node, sid, text, mode) => post(`${sess(node, sid)}/prompt`, { text, mode }, { timeout: 60000 }),
  interrupt: (node, sid) => post(`${sess(node, sid)}/interrupt`, {}),
  respond: (node, sid, requestId, result) => post(`${sess(node, sid)}/respond`, { request_id: requestId, result }),
  rename: (node, sid, title) => request('PATCH', sess(node, sid), { title }),
  deleteSession: (node, sid) => request('DELETE', sess(node, sid), {}),

  requests: () => get('/api/requests'),
  deliveries: (address, limit = 100) => get(`/api/deliveries?limit=${limit}${address ? `&address=${enc(address)}` : ''}`),
  send: (to, message, expectReply) => post('/api/send', { to, message, expect_reply: !!expectReply }),

  join: () => get('/api/join'),
  app: () => get('/api/app'),
};
