// Small DOM, formatting and platform helpers shared by every view. No innerHTML here: nodes are
// built with createElement/textContent, so untrusted strings can never become markup.

/**
 * Create an element. `attrs` keys: class, text, value, dataset{}, style{}, on<event> handlers;
 * booleans toggle attributes. Children may be strings, nodes, arrays or null/false (skipped).
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** Append children; arrays are flattened and null/false skipped. */
export function add(el, ...children) {
  return append(el, children);
}

/** Replace an element's children; arrays are flattened and null/false skipped. */
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Route-safe path segment encoding. */
export const enc = encodeURIComponent;

export function sessionKey(node, sid) {
  return `${node}#${sid}`;
}

export function sessionHref(node, sid, tail = '') {
  return `#/s/${enc(node)}/${enc(sid)}${tail}`;
}

// --------------------------------------------------------------------------- timing helpers

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

/** Coalesce calls into one per animation frame. */
export function rafThrottle(fn) {
  let id = 0;
  const wrapped = () => {
    if (id) return;
    id = requestAnimationFrame(() => { id = 0; fn(); });
  };
  wrapped.cancel = () => { if (id) cancelAnimationFrame(id); id = 0; };
  return wrapped;
}

// --------------------------------------------------------------------------- storage

export const ls = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch { return fallback; }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch { /* storage may be unavailable (private mode, quota) */ }
  },
  json(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  setJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export const ss = {
  get(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { sessionStorage.setItem(key, String(value)); } catch { /* ignore */ }
  },
};

// --------------------------------------------------------------------------- time formatting

/** Normalise seconds-or-milliseconds epoch / ISO string to a millisecond timestamp (or null). */
export function toMs(t) {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number') return Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : null;
  const n = Number(t);
  if (!Number.isNaN(n)) return toMs(n);
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : d;
}

/** Korean relative time (spec §3.2). */
export function relTime(t, now = Date.now()) {
  const ms = toMs(t);
  if (ms === null) return '';
  const s = Math.floor((now - ms) / 1000);
  if (s < 60) return '방금';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  const d = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday - 86400000) return '어제';
  const days = Math.floor((now - ms) / 86400000);
  if (days < 7) return `${days}일 전`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

/** Relative time for future instants ("2시간 후"). */
export function relFuture(t, now = Date.now()) {
  const ms = toMs(t);
  if (ms === null) return '';
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return relTime(t, now);
  if (s < 60) return '곧';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 후`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs}시간 후`;
  return `${Math.round(hrs / 24)}일 후`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "2026. 10. 13. 14:05" */
export function fmtDateTime(t) {
  const ms = toMs(t);
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Elapsed clock: "0:42", "12:05", "1:02:03". */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss2 = s % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss2)}` : `${mm}:${pad2(ss2)}`;
}

/** Tool durations: "0.1s", "3.2s", "12s", "2m 5s". */
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec % 60)}s`;
}

/** "3일 4시간" style uptime. */
export function fmtUptime(sec) {
  if (!Number.isFinite(sec)) return '';
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}일 ${hr}시간`;
  if (hr) return `${hr}시간 ${m}분`;
  return `${m}분`;
}

// --------------------------------------------------------------------------- number formatting

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v}${u[i]}`;
}

export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '';
}

/** 18200 → "18.2k", 326100 → "326k", 1.2e6 → "1.2M". */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 100000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

export function fmtGB(bytes) {
  return Number.isFinite(bytes) ? (bytes / 1073741824).toFixed(1) : '–';
}

// --------------------------------------------------------------------------- text helpers

export function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function firstLine(s, n = 80) {
  if (typeof s !== 'string') return '';
  const line = s.trim().split('\n', 1)[0].trim();
  return truncate(line, n);
}

// A GFM table delimiter row: "|---|:--:|", "--- | ---".
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
// The same delimiter inside text whose newlines were already folded (hub previews): "|---|---|".
const INLINE_SEP_RE = /(?:\|\s*:?-{3,}:?\s*)+\|/g;

const tableCells = (l) => l.replace(/\\\|/g, '\u0000').split('|').map((c) => c.replace(/\u0000/g, '|').trim()).filter(Boolean);

/** Table rows as "a · b" (delimiter rows dropped), so a one-line preview never shows pipes. */
function flattenTables(s) {
  const lines = s.split('\n');
  const hasTable = lines.some((l) => l.includes('-') && TABLE_SEP_RE.test(l));
  let out = s;
  if (hasTable || lines.some((l) => TABLE_ROW_RE.test(l))) {
    const kept = [];
    for (const l of lines) {
      if (hasTable && l.includes('-') && TABLE_SEP_RE.test(l)) continue;
      if (!TABLE_ROW_RE.test(l) && !(hasTable && l.includes('|'))) { kept.push(l); continue; }
      const cells = tableCells(l);
      if (cells.length) kept.push(cells.join(' · '));
    }
    out = kept.join('\n');
  }
  INLINE_SEP_RE.lastIndex = 0;
  if (!INLINE_SEP_RE.test(out)) return out;
  // Folded table: "Result. | | a | b | |---|---| | 1 | 2 |" → "Result. a · b · 1 · 2".
  const flat = out.replace(INLINE_SEP_RE, '|').replace(/\s*(?:\|\s*)+/g, ' · ').replace(/^ · | · $/g, '');
  // The prose before the table ends a sentence: no separator after it.
  return flat.replace(/([.:!?。](?:\*\*|__)?) · /, '$1 ');
}

/** Plain one-line text from markdown-ish content (row previews). */
export function stripMd(s) {
  if (typeof s !== 'string') return '';
  return flattenTables(s.replace(/```[\s\S]*?(```|$)/g, ' '))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|`|~~)/g, '')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function basename(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** Long paths keep their last two segments: "…/hub/router.py". */
export function shortPath(p, max = 40) {
  if (typeof p !== 'string') return '';
  if (p.length <= max) return p;
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return truncate(p, max);
  return `…/${parts.slice(-2).join('/')}`;
}

export function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  if (c === null || c === undefined) return '';
  try { return JSON.stringify(c); } catch { return String(c); }
}

export function prettyJson(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return v; }
    }
    return v;
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function parseJsonMaybe(v) {
  if (typeof v !== 'string') return v && typeof v === 'object' ? v : null;
  const s = v.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Korean object particle for "와/과" after a word (falls back to "와"). */
export function josaWa(word) {
  const ch = typeof word === 'string' && word ? word.charCodeAt(word.length - 1) : 0;
  if (ch >= 0xac00 && ch <= 0xd7a3) return (ch - 0xac00) % 28 ? '과' : '와';
  return '와';
}

// --------------------------------------------------------------------------- Hermes control text
//
// Hermes stores a few rows whose text is protocol, not conversation. They never reach the screen
// as-is (spec §3.4: no internal marker or raw English protocol text anywhere).

// agent/prompt_builder.py STEER_MARKER_OPEN / STEER_MARKER_CLOSE (mid-turn /steer, "끼어들기").
const STEER_OPEN_RE = /\[OUT-OF-BAND USER MESSAGE[^\]\n]*\]/g;
const STEER_CLOSE_RE = /\[\/OUT-OF-BAND USER MESSAGE\]/g;

/**
 * The user's own words of a steer row, or null when `text` is not one. A row may carry several
 * steers drained together; their bodies are joined by blank lines.
 */
export function steerText(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s.startsWith('[OUT-OF-BAND USER MESSAGE')) return null;
  return s.replace(STEER_CLOSE_RE, '\n\n').replace(STEER_OPEN_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** True for a persisted steer row (Hermes types it `display_kind: steer`; older rows by marker). */
export const isSteerRow = (r) => r?.role === 'user' && (r.display_kind === 'steer' || steerText(contentText(r.content)) !== null);

// agent/turn_failure_copy.py FAILED_TURN_NOTICE / PARTIAL_FAILED_TURN_NOTICE: the boundary row
// Hermes writes when a turn ends without an answer (interrupt or failure).
const TURN_NOTICES = new Map([
  ['Your request was not processed. Send it again if you still want me to carry it out.',
    { partial: false, text: '이 요청은 처리되지 않았어요' }],
  ['This turn did not complete. Some actions may already have run; verify their effects before resending.',
    { partial: true, text: '끝까지 처리되지 않았어요 · 일부 작업은 이미 실행됐을 수 있어요' }],
]);

// The row Hermes appends when a turn is cut off after a tool result (agent/message_sanitization.py
// close_interrupted_tool_sequence: "Operation interrupted.") and its interrupt_text family
// ("Operation interrupted: waiting for model response (…)", "Operation interrupted during retry (…)").
const INTERRUPTED_RE = /^Operation interrupted(?:\.$|:\s|\s+during\s)/;
const INTERRUPTED = { partial: true, interrupted: true, text: '중단됨' };

/** Korean copy for a Hermes failed-turn boundary row, or null for real assistant text. */
export function turnNotice(text, displayKind) {
  const s = typeof text === 'string' ? text.trim() : '';
  const known = TURN_NOTICES.get(s);
  if (known) return known;
  if (s.length <= 400 && !s.includes('\n') && INTERRUPTED_RE.test(s)) return INTERRUPTED;
  return displayKind === 'failed_turn' ? { partial: false, text: '이 요청은 처리되지 않았어요' } : null;
}

/** Display form of a stored message text for one-line previews (steers unwrapped, notices in Korean). */
export function displayText(text) {
  const st = steerText(text);
  if (st !== null) return st;
  return turnNotice(text)?.text ?? (typeof text === 'string' ? text : '');
}

// --------------------------------------------------------------------------- platform

export const mq = {
  desktop: window.matchMedia('(min-width: 900px)'),
  fine: window.matchMedia('(pointer: fine)'),
  reduced: window.matchMedia('(prefers-reduced-motion: reduce)'),
};

export const isDesktop = () => mq.desktop.matches;
/** Desktop keyboard semantics (Enter sends) — spec §3.4.4. */
export const desktopKeys = () => mq.fine.matches && mq.desktop.matches;
export const isApk = () => !!window.HermesOmni || / HermesOmni\//.test(navigator.userAgent);

/** Android bridge call that never throws. */
export function bridge(method, ...args) {
  try {
    const b = window.HermesOmni;
    if (b && typeof b[method] === 'function') return b[method](...args);
  } catch { /* bridge disabled off-origin */ }
  return undefined;
}

/**
 * Copy text without requiring a secure context: Android bridge → async clipboard (secure
 * contexts only) → select + execCommand.
 */
export async function copyText(text) {
  if (bridge('copy', text) === true) return true;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Grow a textarea with its content up to `maxLines` lines (box-sizing: border-box). */
export function autosize(ta, maxLines = 8) {
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 24;
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const max = lh * maxLines + pad + border;
  ta.style.height = 'auto';
  const want = ta.scrollHeight + border;
  ta.style.height = `${Math.ceil(Math.min(want, max))}px`;
  ta.style.overflowY = want > max + 1 ? 'auto' : 'hidden';
}

/** Trigger a download through a real hub URL (never blob:/data:, so the APK DownloadManager works). */
export function download(url, name) {
  const a = h('a', { href: url, download: name || '', rel: 'noopener', style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => a.remove(), 0);
}

let uid = 0;
export function nextId(prefix = 'id') {
  uid += 1;
  return `${prefix}-${uid}`;
}
