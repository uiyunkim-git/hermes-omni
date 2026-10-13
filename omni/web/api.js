// REST wrapper for the hub browser API v3 (spec §5.4). Every call sends `X-Omni: 1`; JSON
// bodies for mutations; a 401 emits "unauthorized" on the bus (app.js routes to login).
// Node features (§5b) go through the hub passthrough: `rpc` (JSON-RPC) and `rest` (REST).

import { bus } from './store.js';
import { enc } from './util.js';

export class ApiError extends Error {
  constructor(status, code, message, data = null) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || `http_${status}`;
    this.data = data;
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
    const timeout = err.name === 'AbortError';
    throw new ApiError(0, timeout ? 'timeout' : 'network', timeout ? '응답이 너무 늦어요' : '허브에 연결할 수 없어요');
  } finally {
    clearTimeout(timer);
  }
  return parseResponse(resp, opts);
}

async function parseResponse(resp, opts = {}) {
  let data = null;
  const text = await resp.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (resp.status === 401) {
    if (!opts.quiet401) bus.emit('unauthorized');
    throw new ApiError(401, data?.error?.code || 'unauthorized', data?.error?.message || '로그인이 필요해요');
  }
  if (!resp.ok) {
    const e = data?.error;
    throw new ApiError(resp.status, e?.code, e?.message || (typeof e === 'string' ? e : `HTTP ${resp.status}`), e || data);
  }
  return data ?? {};
}

/**
 * Multipart upload with progress (XHR, because fetch has no upload progress).
 * @returns {{promise: Promise<object>, abort: () => void}}
 */
export function upload(path, files, { onProgress, field = 'file' } = {}) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append(field, f, f.name);
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Omni', '1');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, 'network', '허브에 연결할 수 없어요'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '취소했어요'));
    xhr.onload = () => {
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { data = null; }
      if (xhr.status === 401) {
        bus.emit('unauthorized');
        reject(new ApiError(401, 'unauthorized', '로그인이 필요해요'));
      } else if (xhr.status < 200 || xhr.status >= 300) {
        const e = data?.error;
        reject(new ApiError(xhr.status, e?.code, e?.message || `HTTP ${xhr.status}`, e || data));
      } else {
        resolve(data || {});
      }
    };
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

const get = (p, o) => request('GET', p, undefined, o);
const post = (p, b, o) => request('POST', p, b, o);
const qs = (o) => {
  const parts = [];
  for (const [k, v] of Object.entries(o || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${enc(k)}=${enc(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
};

const nodeP = (node) => `/api/nodes/${enc(node)}`;
const sess = (node, sid) => `${nodeP(node)}/sessions/${enc(sid)}`;

export const api = {
  login: (username, password) => post('/api/login', { username, password }, { quiet401: true }),
  logout: () => post('/api/logout', {}),
  me: () => get('/api/me', { quiet401: true }),

  nodes: () => get('/api/nodes'),
  forgetNode: (node) => request('DELETE', nodeP(node), {}),

  /** {sessions, nodes, attention}; with q → mention candidates. */
  sessions: (params = {}) => get(`/api/sessions${qs(params)}`),
  search: (q, limit = 30) => get(`/api/search${qs({ q, limit })}`, { timeout: 12000 }),

  folders: (node) => get(`${nodeP(node)}/folders`),
  createFolder: (node, root, name) => post(`${nodeP(node)}/folders`, { root, name }),

  createSession: (node, body) => post(`${nodeP(node)}/sessions`, body, { timeout: 60000 }),
  messages: (node, sid, limit = 100, offset = 0) => get(`${sess(node, sid)}/messages${qs({ limit, offset })}`),
  prompt: (node, sid, text, mode = 'queue') => post(`${sess(node, sid)}/prompt`, { text, mode }, { timeout: 60000 }),
  interrupt: (node, sid) => post(`${sess(node, sid)}/interrupt`, {}),
  respond: (node, sid, requestId, result) => post(`${sess(node, sid)}/respond`, { request_id: requestId, result }),
  updateSession: (node, sid, patch) => request('PATCH', sess(node, sid), patch),
  deleteSession: (node, sid) => request('DELETE', sess(node, sid), {}),
  exportUrl: (node, sid) => `${sess(node, sid)}/export`,
  attach: (node, sid, file, onProgress) => upload(`${sess(node, sid)}/attachments`, [file], { onProgress }),

  /** JSON-RPC passthrough (§5b.1) → result. */
  rpc: async (node, method, params, storedId, opts) => {
    const body = { method, params: params || {} };
    if (storedId) body.stored_id = storedId;
    const res = await post(`${nodeP(node)}/rpc`, body, { timeout: 70000, ...opts });
    return res.result ?? res;
  },
  /** REST passthrough (§5b.1) → body; Hermes errors (status ≥ 400) throw ApiError. */
  rest: async (node, method, path, { query, body } = {}) => {
    const res = await post(`${nodeP(node)}/rest`, { method, path, query, body }, { timeout: 40000 });
    const status = Number(res.status) || 200;
    if (status >= 400) {
      const b = res.body;
      const msg = (b && (b.detail || b.message || b.error?.message)) || `HTTP ${status}`;
      throw new ApiError(status, `hermes_${status}`, typeof msg === 'string' ? msg : JSON.stringify(msg), b);
    }
    return res.body;
  },

  files: (node, path) => get(`${nodeP(node)}/files${qs({ path })}`),
  fileText: (node, path) => get(`${nodeP(node)}/files/text${qs({ path })}`),
  fileRawUrl: (node, path, dl = false) => `${nodeP(node)}/files/raw${qs({ path, download: dl ? 1 : 0 })}`,
  uploadFiles: (node, dir, files, overwrite, onProgress) =>
    upload(`${nodeP(node)}/files/upload${qs({ dir, overwrite: overwrite ? 1 : 0 })}`, files, { onProgress }),

  join: () => get('/api/join'),
  app: () => get('/api/app'),
};

/** Human message for an API error, in Korean where we know the code. */
export function errorText(err, fallback = '요청을 처리하지 못했어요') {
  if (!err) return fallback;
  const byCode = {
    network: '허브에 연결할 수 없어요',
    timeout: '응답이 너무 늦어요',
    node_offline: '노드가 오프라인이에요',
    node_timeout: '노드가 응답하지 않아요',
    node_outdated: '이 노드는 업데이트가 필요해요',
    forbidden: '허용되지 않은 작업이에요',
    outside_roots: '이 폴더는 허브에서 열 수 없어요',
    sensitive: '보안상 열 수 없는 파일이에요',
    too_large: '파일이 너무 커요',
    running: '실행 중인 세션은 삭제할 수 없어요',
    session_locked: '다른 곳에서 사용 중인 세션이에요',
    duplicate_title: '같은 이름의 세션이 있어요',
    exists: '같은 이름의 파일이 있어요',
    not_found: '찾을 수 없어요',
  };
  return byCode[err.code] || err.message || fallback;
}
