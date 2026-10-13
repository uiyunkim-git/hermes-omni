// One-line toast, bottom-center above the composer/FAB; one at a time; 3 s (spec §2.3).

import { h, add } from '../util.js';
import { errorText } from '../api.js';

let current = null;
let timer = 0;

/** @param {string} message @param {{ms?:number, tone?:'info'|'error'}} [opts] */
export function toast(message, { ms = 3000, tone = 'info' } = {}) {
  const host = document.getElementById('toast-host');
  if (!host || !message) return;
  clearTimeout(timer);
  if (current) current.remove();
  const el = h('div', { class: `toast${tone === 'error' ? ' toast-error' : ''}`, role: tone === 'error' ? 'alert' : 'status', text: message });
  add(host, el);
  current = el;
  requestAnimationFrame(() => el.classList.add('in'));
  timer = setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => { el.remove(); if (current === el) current = null; }, 180);
  }, ms);
}

export function toastError(err, fallback) {
  toast(errorText(err, fallback), { tone: 'error', ms: 4000 });
}
