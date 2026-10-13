// Last loaded history page per session, kept in localStorage so a chat whose node is offline
// still opens read-only (spec §3.4 banner 2). Small LRU: a few sessions, long tool output and
// reasoning trimmed; every storage call may fail (private mode, quota) and is non-fatal.

const PREFIX = 'omni.hist.v1.';
const INDEX = 'omni.hist.v1';
const MAX_SESSIONS = 12;
const MAX_TEXT = 4000;
const MAX_BYTES = 600000;

function readIndex() {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.k === 'string') : [];
  } catch { return []; }
}

function writeIndex(list) {
  try { localStorage.setItem(INDEX, JSON.stringify(list)); } catch { /* ignore */ }
}

const trim = (s) => (typeof s === 'string' && s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function slim(r) {
  const o = { ...r };
  if (typeof o.content === 'string') o.content = trim(o.content);
  if (typeof o.reasoning === 'string') o.reasoning = trim(o.reasoning);
  return o;
}

/** Remember the newest page of `key` (rows ascending). */
export function saveHistory(key, rows) {
  if (!key || !Array.isArray(rows) || !rows.length) return;
  let data = JSON.stringify({ at: Date.now(), rows: rows.slice(-100).map(slim) });
  if (data.length > MAX_BYTES) data = JSON.stringify({ at: Date.now(), rows: rows.slice(-30).map(slim) });
  if (data.length > MAX_BYTES) return;
  let list = readIndex().filter((x) => x.k !== key);
  list.unshift({ k: key, at: Date.now() });
  const drop = list.slice(MAX_SESSIONS);
  list = list.slice(0, MAX_SESSIONS);
  try {
    for (const x of drop) localStorage.removeItem(PREFIX + x.k);
    for (let tries = 0; ; tries += 1) {
      try {
        localStorage.setItem(PREFIX + key, data);
        break;
      } catch (err) {
        // Quota: evict the oldest other entry and retry a few times.
        const victim = list.length > 1 ? list.pop() : null;
        if (!victim || tries > 4) throw err;
        localStorage.removeItem(PREFIX + victim.k);
      }
    }
    writeIndex(list);
  } catch { /* storage unavailable */ }
}

/** @returns {{at:number, rows:object[]}|null} */
export function loadHistory(key) {
  try {
    const v = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
    return v && Array.isArray(v.rows) && v.rows.length ? v : null;
  } catch { return null; }
}

/** Follow a compression tip (old sid → new sid) or forget a deleted session. */
export function forgetHistory(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  writeIndex(readIndex().filter((x) => x.k !== key));
}
