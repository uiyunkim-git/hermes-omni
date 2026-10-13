// Popover menu (spec §4.4): min-width 200, 44px items, radius 10, --shadow-pop. Anchored to an
// element (below, right-aligned; flips above when there is no room) or to a point (long-press).

import { h, add } from '../util.js';
import { icon } from './icons.js';
import { pushLayer, layerHost } from './layer.js';

let openMenuClose = null;

/**
 * @param {Element|{x:number,y:number}} anchor
 * @param {Array<{label:string, icon?:string, danger?:boolean, onSelect:()=>void}|'divider'|null>} items
 */
export function openMenu(anchor, items, { label = '메뉴' } = {}) {
  openMenuClose?.();
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label });
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'divider') { add(menu, h('div', { class: 'menu-divider', role: 'separator' })); continue; }
    const b = h('button', {
      type: 'button', role: 'menuitem', class: `menu-item${it.danger ? ' danger' : ''}`,
      onclick: () => { close(); setTimeout(() => it.onSelect?.(), 0); },
    }, it.icon ? icon(it.icon, 18) : null, h('span', { text: it.label }));
    buttons.push(b);
    add(menu, b);
  }
  const wrap = h('div', { class: 'menu-wrap' }, menu);
  add(layerHost(), wrap);

  // Position.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = Math.max(200, menu.offsetWidth);
  const mh = menu.offsetHeight;
  let x;
  let y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = r.right - mw;
    y = r.bottom + 4;
    if (y + mh > vh - 8) y = Math.max(8, r.top - mh - 4);
  } else {
    x = anchor.x - mw / 2;
    y = anchor.y + 8;
    if (y + mh > vh - 8) y = Math.max(8, anchor.y - mh - 8);
  }
  x = Math.min(Math.max(8, x), vw - mw - 8);
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  menu.style.minWidth = `${mw}px`;

  let closed = false;
  const prevFocus = document.activeElement;
  function close() {
    if (closed) return;
    closed = true;
    release();
    openMenuClose = null;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 120);
    if (anchor instanceof Element && document.activeElement && menu.contains(document.activeElement)) {
      try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    }
  }
  const release = pushLayer(close);
  openMenuClose = close;
  const onDown = (e) => { if (!menu.contains(e.target)) { e.stopPropagation(); close(); } };
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === 'Tab') close();
  };
  // Defer so the opening tap does not immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
  }, 0);
  requestAnimationFrame(() => {
    wrap.classList.add('open');
    if (anchor instanceof Element && !matchMedia('(pointer: coarse)').matches) buttons[0]?.focus({ preventScroll: true });
  });
  return close;
}

/**
 * Long-press (touch, 450 ms) → callback with the touch point. Cancels on move > 10px or scroll.
 * Returns a detach function.
 */
export function onLongPress(el, cb) {
  let timer = 0;
  let start = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; start = null; };
  const down = (e) => {
    if (e.pointerType !== 'touch') return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      fired = true;
      timer = 0;
      try { navigator.vibrate?.(10); } catch { /* ignore */ }
      cb({ x: start.x, y: start.y });
    }, 450);
  };
  const move = (e) => {
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) cancel();
  };
  const click = (e) => {
    if (fired) { e.preventDefault(); e.stopImmediatePropagation(); fired = false; }
  };
  const ctx = (e) => { if (timer || fired) e.preventDefault(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('click', click, true);
  el.addEventListener('contextmenu', ctx);
  return () => {
    cancel();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', cancel);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('click', click, true);
    el.removeEventListener('contextmenu', ctx);
  };
}
