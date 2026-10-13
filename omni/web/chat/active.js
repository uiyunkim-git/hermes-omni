// Shared state between the open chat and the session info sheet: the live `session.meta` per
// session and a handle to the open chat's composer (for "채팅에 첨부").

import { bus } from '../store.js';

const metas = new Map();

export function setMeta(key, meta) {
  if (!meta) return;
  metas.set(key, { ...(metas.get(key) || {}), ...meta });
  bus.emit('meta', { key, meta: metas.get(key) });
}

export function getMeta(key) {
  return metas.get(key) || null;
}

/** The chat currently mounted: {key, node, sid, insertText(t), running, compress(), …} | null */
export const active = { chat: null };
