// Hash router with real history entries (spec §2.1/§2.2). Every in-app navigation is a
// pushState carrying an increasing `idx`, so "back" can tell whether there is in-app history
// (a deep link has idx 0 → back goes to #/ instead of leaving the app).
//
// The browser's own Back follows §2.2 step 1 too: while a transient overlay (menu, dialog,
// preview, picker) is open, Back closes that overlay and the page stays where it was.

let handler = () => {};
let idx = 0;
let popGuard = null;
/** The entry we are on, so a Back consumed by an overlay can be undone. */
let here = null;

export function onRoute(fn) {
  handler = fn;
}

/** `fn()` returns true when it consumed a Back press (closed an overlay). */
export function setPopGuard(fn) {
  popGuard = fn;
}

export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
  return { path: path || '/', query, hash: `#${raw}` };
}

export function historyIndex() {
  return Number(history.state?.idx) || 0;
}

function remember() {
  here = { state: history.state, url: location.href };
}

/** Navigate to `hash` (push by default). */
export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (replace) {
    history.replaceState({ idx: historyIndex() }, '', target);
  } else {
    if (location.hash === target) { handler('same'); return; }
    idx = historyIndex() + 1;
    history.pushState({ idx }, '', target);
  }
  remember();
  handler(replace ? 'replace' : 'push');
}

/** Back within the app, or to home when there is no in-app history (deep link). */
export function back(fallback = '#/') {
  if (historyIndex() > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function startRouter() {
  if (!history.state || typeof history.state.idx !== 'number') {
    history.replaceState({ idx: 0 }, '', location.hash || '#/');
  }
  remember();
  window.addEventListener('popstate', () => {
    // A fresh hash navigation (deep link, notification tap, manual URL edit) also fires popstate,
    // on a new entry without our state. It is not a Back press: overlays must not swallow it.
    // The route handler closes them; the entry gets the next index.
    if (!history.state || typeof history.state.idx !== 'number') {
      idx = (Number(here?.state?.idx) || 0) + 1;
      history.replaceState({ idx }, '', location.hash || '#/');
      remember();
      handler('push');
      return;
    }
    if (here && popGuard?.()) {
      // An overlay took the Back press: restore the entry we just left (same URL and state).
      history.pushState(here.state, '', here.url);
      return;
    }
    remember();
    handler('pop');
  });
  // Manual URL edits / plain <a href="#…"> without our click interception.
  window.addEventListener('hashchange', () => {
    if (!history.state || typeof history.state.idx !== 'number') {
      history.replaceState({ idx: historyIndex() }, '', location.hash);
      remember();
      handler('push');
    }
  });
  // Intercept in-app hash links so they become pushState navigations.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    e.preventDefault();
    navigate(a.getAttribute('href'), { replace: a.dataset.replace === '1' });
  });
}
