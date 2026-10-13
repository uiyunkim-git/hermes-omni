// Stack of transient overlays (menus, pickers, dialogs, non-route sheets) so that Android back,
// Escape and route changes close the topmost one first (spec §2.2 step 1).

const stack = [];

/**
 * Register an open overlay. `close()` must remove it (and should call the returned release
 * function, which is idempotent). Returns release().
 */
export function pushLayer(close) {
  const entry = { close };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Close the topmost overlay. Returns true if there was one. */
export function closeTopLayer() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  stack.pop();
  try { top.close(); } catch (err) { console.error('[layer] close failed', err); }
  return true;
}

export function closeAllLayers() {
  while (stack.length) closeTopLayer();
}

export function layerCount() {
  return stack.length;
}

/** The host element every overlay is appended to. */
export function layerHost() {
  return document.getElementById('layers') || document.body;
}
