// Small reusable controls (spec §4.4): buttons, spinner, skeleton, toggle, segmented, bars,
// banners, empty states and section headers. All return plain DOM nodes.

import { h, add } from '../util.js';
import { icon } from './icons.js';

/** Ring spinner; size 10 | 12 | 16 | 20. */
export function spinner(size = 12, cls = '') {
  return h('span', { class: `spinner s${size} ${cls}`.trim(), 'aria-hidden': 'true' });
}

/**
 * Button. variant: primary | secondary | ghost | danger | danger-outline | text
 * @param {string|Node} label
 */
export function button(label, { variant = 'secondary', icon: ic, onClick, type = 'button', cls = '', disabled, title, small } = {}) {
  return h('button', {
    type, class: `btn btn-${variant}${small ? ' btn-sm' : ''} ${cls}`.trim(), onclick: onClick, disabled: !!disabled, title,
  }, ic ? icon(ic, small ? 16 : 18) : null, typeof label === 'string' ? h('span', { text: label }) : label);
}

/** Icon-only button: 40px visible, 44px hit area. */
export function iconButton(name, label, onClick, { cls = '', size = 20 } = {}) {
  return h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), 'aria-label': label, title: label, onclick: onClick },
    icon(name, size));
}

export function skeletonRows(n = 6) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(h('div', { class: 'sk-row', 'aria-hidden': 'true' },
      h('div', { class: 'sk-line w60' }), h('div', { class: 'sk-line w90' }), h('div', { class: 'sk-line w35 sm' })));
  }
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': '불러오는 중' }, out);
}

export function skeletonLines(n = 2) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(h('div', { class: `sk-line ${i % 2 ? 'w60' : 'w90'}` }));
  return h('div', { class: 'skeleton sk-pad', 'aria-busy': 'true' }, out);
}

/** Centered text-only empty state. */
export function emptyState({ title, body, action, actionLabel, actionVariant = 'secondary' } = {}) {
  return h('div', { class: 'empty' },
    title ? h('p', { class: 'empty-title', text: title }) : null,
    body ? h('p', { class: 'empty-body', text: body }) : null,
    action ? button(actionLabel, { variant: actionVariant, onClick: action }) : null);
}

/** Inline loading line (spinner + text). */
export function loadingLine(text = '불러오는 중…') {
  return h('div', { class: 'loading-line', role: 'status' }, spinner(16), h('span', { text }));
}

/** Inline error with retry. */
export function errorLine(text, onRetry) {
  return h('div', { class: 'error-line', role: 'alert' },
    icon('alert', 16), h('span', { text }),
    onRetry ? h('button', { type: 'button', class: 'btn-link', onclick: onRetry, text: '다시 시도' }) : null);
}

/** Switch 44×26. */
export function toggle({ checked = false, onChange, label, disabled = false, id } = {}) {
  const input = h('input', {
    type: 'checkbox', role: 'switch', class: 'switch-input', checked, disabled, id, 'aria-label': label,
  });
  input.addEventListener('change', () => onChange?.(input.checked, input));
  const el = h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })));
  el.input = input;
  el.set = (v) => { input.checked = !!v; };
  return el;
}

/**
 * Segmented control. options: [{value, label}]
 * @returns {HTMLElement & {set:(v:string)=>void, value:string}}
 */
export function segmented({ options, value, onChange, label, scroll = false, cls = '' }) {
  const el = h('div', { class: `segmented${scroll ? ' scroll' : ''} ${cls}`.trim(), role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) => {
    const b = h('button', {
      type: 'button', role: 'radio', class: 'seg', dataset: { value: o.value }, text: o.label,
      onclick: () => {
        if (el.value === o.value || el.disabled) return;
        const prev = el.value;
        el.set(o.value);
        Promise.resolve(onChange?.(o.value, prev)).then((ok) => { if (ok === false) el.set(prev); });
      },
    });
    return b;
  });
  add(el, ...btns);
  el.set = (v) => {
    el.value = v;
    for (const b of btns) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    }
  };
  el.set(value);
  return el;
}

/** 4px or 6px progress bar; `tone`: '' | 'accent' | 'auto' (warn ≥70, danger ≥90). */
export function progressBar(pct, { tone = '', thick = false } = {}) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const t = tone === 'auto' ? (p >= 90 ? 'danger' : p >= 70 ? 'warn' : 'neutral') : tone;
  return h('div', { class: `bar${thick ? ' thick' : ''} ${t ? `bar-${t}` : ''}`.trim(), role: 'progressbar', 'aria-valuenow': String(Math.round(p)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('div', { class: 'bar-fill', style: { width: `${p}%` } }));
}

export function sectionHeader(text, extra = null) {
  return h('div', { class: 'section-h' }, h('h2', { text }), extra);
}

/** Banner under an app bar. actions: [{label, onClick}] */
export function banner(text, actions = []) {
  return h('div', { class: 'banner', role: 'status' },
    h('p', { text }),
    actions.length ? h('div', { class: 'banner-actions' }, actions.map((a) => h('button', { type: 'button', class: 'btn-link', onclick: a.onClick, text: a.label }))) : null);
}

/** Generic app bar. left/right are arrays of nodes. */
export function appBar({ left = [], title, subtitle, right = [], titleClick, cls = '' } = {}) {
  const titleBlock = title !== undefined
    ? h(titleClick ? 'button' : 'div', {
      class: 'appbar-title', type: titleClick ? 'button' : undefined, onclick: titleClick,
    },
    h('span', { class: 'appbar-t1', text: title }),
    subtitle ? h('span', { class: 'appbar-t2' }, subtitle) : null)
    : null;
  return h('header', { class: `appbar ${cls}`.trim() },
    h('div', { class: 'appbar-row' }, left, titleBlock, h('span', { class: 'appbar-spacer' }), right));
}

/** Settings-style list row (52px) with chevron; `value` on the right. */
export function listRow({ title, sub, value, onClick, href, chevron = true, danger = false, lead = null, cls = '' }) {
  const inner = [
    lead,
    h('span', { class: 'lr-text' },
      h('span', { class: 'lr-title', text: title }),
      sub ? (typeof sub === 'string' ? h('span', { class: 'lr-sub', text: sub }) : h('span', { class: 'lr-sub' }, sub)) : null),
    value !== undefined && value !== null ? (typeof value === 'string' ? h('span', { class: 'lr-value', text: value }) : value) : null,
    chevron ? icon('chevron-right', 18, 'lr-chev') : null,
  ];
  const cl = `list-row${danger ? ' danger' : ''}${onClick || href ? ' tappable' : ''} ${cls}`.trim();
  if (href) return h('a', { class: cl, href }, inner);
  if (onClick) return h('button', { type: 'button', class: cl, onclick: onClick }, inner);
  return h('div', { class: cl }, inner);
}

/** Key/value row (48px). */
export function kvRow(key, value, { mono = false, cls = '' } = {}) {
  return h('div', { class: `kv-row ${cls}`.trim() },
    h('span', { class: 'kv-k', text: key }),
    value instanceof Node ? h('span', { class: `kv-v${mono ? ' mono' : ''}` }, value) : h('span', { class: `kv-v${mono ? ' mono' : ''}`, text: value ?? '–' }));
}

/** Native <select> with a drawn chevron (appearance: none removes the platform arrow). */
export function selectWrap(select) {
  return h('span', { class: 'select-wrap' }, select, icon('chevron-down', 16, 'select-chev'));
}

export function group(children, cls = '') {
  return h('div', { class: `group ${cls}`.trim() }, children);
}
