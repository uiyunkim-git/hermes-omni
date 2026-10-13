// Transient notifications in the #toasts live region.

import { h } from '../util.js';

/** @param {'info'|'ok'|'error'} kind */
export function toast(message, kind = 'info', ms = 4000) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast-text', text: message }),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss() }, '×'));
  host.append(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  const timer = setTimeout(dismiss, kind === 'error' ? Math.max(ms, 7000) : ms);
  function dismiss() {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }
}

export function toastError(err, prefix = '') {
  const msg = err?.message || String(err);
  toast(prefix ? `${prefix}: ${msg}` : msg, 'error');
}
