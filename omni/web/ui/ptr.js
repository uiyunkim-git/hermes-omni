// Pull-to-refresh for a touch scroller (spec §3.2): only when scrolled to the top; the indicator
// follows the finger with 0.5 resistance; releasing past 64px runs `onRefresh` and keeps the
// spinner for at least 400 ms.

import { h, add } from '../util.js';
import { spinner } from './controls.js';

const THRESHOLD = 64;
const MAX_PULL = 110;

/** @param {HTMLElement} scroller @param {() => Promise<unknown>} onRefresh @returns {() => void} detach */
export function attachPullToRefresh(scroller, onRefresh) {
  const ind = h('div', { class: 'ptr', 'aria-hidden': 'true' }, h('div', { class: 'ptr-disc' }, spinner(20)));
  add(scroller.parentElement, ind);
  let startY = null;
  let pull = 0;
  let busy = false;

  const set = (px, animate) => {
    ind.style.transition = animate ? 'transform .2s ease, opacity .2s ease' : 'none';
    ind.style.transform = `translate(-50%, ${Math.round(px - 44)}px)`;
    ind.style.opacity = px > 6 ? String(Math.min(1, px / THRESHOLD)) : '0';
    ind.classList.toggle('armed', px >= THRESHOLD);
  };
  set(0, false);

  const start = (e) => {
    if (busy || e.touches.length !== 1 || scroller.scrollTop > 0) { startY = null; return; }
    startY = e.touches[0].clientY;
    pull = 0;
  };
  const move = (e) => {
    if (startY === null || busy) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || scroller.scrollTop > 0) { if (pull) set(0, false); pull = 0; return; }
    pull = Math.min(MAX_PULL, dy * 0.5);
    if (e.cancelable) e.preventDefault();
    set(pull, false);
  };
  const end = async () => {
    if (startY === null) return;
    startY = null;
    if (pull < THRESHOLD || busy) { set(0, true); pull = 0; return; }
    busy = true;
    ind.classList.add('busy');
    set(THRESHOLD, true);
    const t0 = Date.now();
    try { await onRefresh(); } catch { /* the caller toasts */ }
    const wait = Math.max(0, 400 - (Date.now() - t0));
    setTimeout(() => {
      busy = false;
      ind.classList.remove('busy');
      set(0, true);
      pull = 0;
    }, wait);
  };
  scroller.addEventListener('touchstart', start, { passive: true });
  scroller.addEventListener('touchmove', move, { passive: false });
  scroller.addEventListener('touchend', end);
  scroller.addEventListener('touchcancel', end);
  return () => {
    scroller.removeEventListener('touchstart', start);
    scroller.removeEventListener('touchmove', move);
    scroller.removeEventListener('touchend', end);
    scroller.removeEventListener('touchcancel', end);
    ind.remove();
  };
}
