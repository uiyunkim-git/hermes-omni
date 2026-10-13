// Small DOM and formatting helpers shared by all views. No innerHTML here: every node is built
// with createElement/textContent, so untrusted strings can never become markup.

/**
 * Create an element. `attrs` keys: class, text, html is NOT supported on purpose;
 * `on<event>` keys attach listeners; `dataset`/`style` take objects; booleans toggle attributes.
 * Children may be strings, nodes, arrays, or null/false (skipped).
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

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Normalise seconds-or-milliseconds epoch / ISO string to a millisecond timestamp (or null). */
export function toMs(t) {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Number(t);
  if (!Number.isNaN(n)) return toMs(n);
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : d;
}

export function relTime(t) {
  const ms = toMs(t);
  if (ms === null) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 0) return 'just now';
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.round(hrs / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

export function absTime(t) {
  const ms = toMs(t);
  return ms === null ? '' : new Date(ms).toLocaleString();
}

export function shortTime(t) {
  const ms = toMs(t);
  if (ms === null) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Grow a textarea with its content up to its CSS max-height. */
export function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

export function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Route-safe path segment encoding. */
export const enc = encodeURIComponent;

export function sessionHref(node, storedId) {
  return `#/s/${enc(node)}/${enc(storedId)}`;
}

/**
 * Copy text to the clipboard without requiring a secure context:
 * Android bridge → async clipboard (secure contexts only) → select + execCommand.
 * `selectEl` (optional) is selected on fallback so the user can copy manually.
 */
export async function copyText(text, selectEl) {
  try {
    if (window.HermesOmni && typeof window.HermesOmni.copy === 'function') {
      window.HermesOmni.copy(text);
      return true;
    }
  } catch { /* fall through */ }
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
  if (!ok && selectEl) {
    const range = document.createRange();
    range.selectNodeContents(selectEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return ok;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Spinner + label placeholder used while a view loads. */
export function loading(label = 'Loading…') {
  return h('div', { class: 'loading', 'aria-busy': 'true' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${label}`);
}

export function emptyState(title, detail) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: title }), detail ? h('p', { class: 'muted', text: detail }) : null);
}
