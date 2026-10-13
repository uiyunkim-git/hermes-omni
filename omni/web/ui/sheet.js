// Sheets (spec §4.4): a bottom sheet on mobile (drag handle, scrim, swipe-down to close) and,
// on desktop, a right drawer (400px), a centered dialog (560px) or a popover anchored to an
// element. Route-bound sheets (info, new) close through history; transient ones (model sheet,
// previews, pickers) register on the layer stack so back/Escape close them.

import { h, isDesktop, mq, fill, add } from '../util.js';
import { icon } from './icons.js';
import { pushLayer, layerHost } from './layer.js';

/**
 * @param {{
 *   title?: string|Node,
 *   desktop?: 'drawer'|'dialog'|'popover',
 *   anchor?: Element,               // for desktop popover
 *   width?: number,                 // desktop dialog/popover width
 *   tall?: boolean,                 // mobile: fixed 92vh height instead of content height
 *   onRequestClose?: () => void,    // route-bound sheets: navigate back instead of closing
 *   layer?: boolean,                // register on the back/Escape layer stack (default true)
 *   cls?: string,
 *   headerExtra?: Node[],
 *   footer?: Node,
 *   label?: string,
 * }} opts
 */
export function createSheet(opts = {}) {
  const variant = isDesktop() ? (opts.desktop || 'dialog') : 'bottom';
  const titleEl = h('h2', { class: 'sheet-title' });
  const setTitle = (t) => {
    fill(titleEl);
    if (t instanceof Node) add(titleEl, t);
    else titleEl.textContent = t || '';
  };
  setTitle(opts.title);
  const closeBtn = h('button', { type: 'button', class: 'icon-btn sheet-close', 'aria-label': '닫기', title: '닫기', onclick: () => requestClose() }, icon('x', 20));
  const handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' });
  const head = h('div', { class: 'sheet-head' }, titleEl, h('span', { class: 'appbar-spacer' }), opts.headerExtra || [], closeBtn);
  const body = h('div', { class: 'sheet-body' });
  const footer = opts.footer ? h('div', { class: 'sheet-foot' }, opts.footer) : null;
  const panel = h('div', {
    class: `sheet sheet-${variant}${opts.tall ? ' tall' : ''} ${opts.cls || ''}`.trim(),
    role: 'dialog', 'aria-modal': variant === 'popover' ? 'false' : 'true', 'aria-label': opts.label || (typeof opts.title === 'string' ? opts.title : ''),
  }, variant === 'bottom' ? handle : null, head, body, footer);
  if (opts.width && variant !== 'bottom' && variant !== 'drawer') panel.style.width = `min(${opts.width}px, calc(100vw - 32px))`;
  const scrim = h('div', { class: `scrim${variant === 'popover' ? ' clear' : ''}`, onclick: () => requestClose() });
  const wrap = h('div', { class: `sheet-wrap wrap-${variant}` }, scrim, panel);
  add(layerHost(), wrap);

  if (variant === 'popover' && opts.anchor) positionPopover(panel, opts.anchor);

  let closed = false;
  let release = () => {};
  const prevFocus = document.activeElement;
  const api = {
    el: panel, body, head, footer, wrap, setTitle, variant,
    close,
    get closed() { return closed; },
    onClose: null,
  };

  function requestClose() {
    if (closed) return;
    if (opts.onRequestClose) opts.onRequestClose();
    else close();
  }

  function close() {
    if (closed) return;
    closed = true;
    release();
    document.removeEventListener('keydown', onKey, true);
    mq.desktop.removeEventListener?.('change', onBreakpoint);
    stopSwipe();
    wrap.classList.remove('open');
    const done = () => wrap.remove();
    if (mq.reduced.matches) done();
    else setTimeout(done, 230);
    try { if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    api.onClose?.();
  }

  const onKey = (e) => {
    if (e.key !== 'Escape' || opts.layer === false) return;
    // Topmost overlay only: menus/dialogs above us handle Escape themselves (capture order).
    if (wrap.nextElementSibling) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    requestClose();
  };
  document.addEventListener('keydown', onKey, true);
  if (opts.layer !== false) release = pushLayer(() => requestClose());

  // Crossing the breakpoint while open: simplest correct behaviour is to close.
  const onBreakpoint = () => requestClose();
  mq.desktop.addEventListener?.('change', onBreakpoint);

  const stopSwipe = variant === 'bottom' ? enableSwipe(panel, handle, head, requestClose) : () => {};

  requestAnimationFrame(() => {
    wrap.classList.add('open');
    if (!matchMedia('(pointer: coarse)').matches) {
      const f = panel.querySelector('[autofocus]');
      (f || closeBtn).focus({ preventScroll: true });
    }
  });
  return api;
}

function positionPopover(panel, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = panel.offsetWidth || 360;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  panel.style.left = `${Math.round(left)}px`;
  if (r.top > vh / 2) {
    panel.style.bottom = `${Math.round(vh - r.top + 8)}px`;
    panel.style.maxHeight = `${Math.round(r.top - 24)}px`;
  } else {
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.maxHeight = `${Math.round(vh - r.bottom - 24)}px`;
  }
}

/** Swipe down on the handle or header closes the sheet. Returns a detach function. */
function enableSwipe(panel, handle, head, onClose) {
  let startY = 0;
  let startT = 0;
  let dy = 0;
  let active = false;
  const begin = (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button, a, input, select, textarea')) return;
    active = true;
    startY = e.clientY;
    startT = performance.now();
    dy = 0;
  };
  const move = (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - startY);
    if (dy > 4) {
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${dy}px)`;
    }
  };
  const end = () => {
    if (!active) return;
    active = false;
    panel.style.transition = '';
    panel.style.transform = '';
    const v = dy / Math.max(1, performance.now() - startT);
    if (dy > 110 || (dy > 40 && v > 0.6)) onClose();
  };
  handle.addEventListener('pointerdown', begin);
  head.addEventListener('pointerdown', begin);
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };
}
