// In-page modal dialogs (confirm / prompt). Native window.confirm/prompt are unreliable inside an
// Android WebView, and these share the back-button layer stack. Title 17/600, body 15, buttons
// on the right (spec §4.4).

import { h, add } from '../util.js';
import { pushLayer, layerHost } from './layer.js';

function open(build, { labelledBy } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy });
    const wrap = h('div', { class: 'dialog-wrap' }, h('div', { class: 'scrim' }), box);
    let settled = false;
    let release = () => {};
    const done = (v) => {
      if (settled) return;
      settled = true;
      release();
      wrap.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => wrap.remove(), 160);
      try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(null); }
    };
    wrap.firstChild.addEventListener('click', () => done(null));
    build(box, done);
    add(layerHost(), wrap);
    release = pushLayer(() => done(null));
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => {
      wrap.classList.add('open');
      (box.querySelector('[autofocus]') || box.querySelector('button'))?.focus({ preventScroll: true });
    });
  });
}

let seq = 0;

/** @returns {Promise<boolean>} */
export async function confirmDialog({ title, body, ok = '확인', cancel = '취소', danger = false }) {
  const id = `dlg-${++seq}`;
  const v = await open((box, done) => {
    add(box,
      h('h2', { class: 'dialog-title', id, text: title }),
      body ? h('p', { class: 'dialog-body', text: body }) : null,
      h('div', { class: 'dialog-btns' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => done(null), text: cancel }),
        h('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, autofocus: true, onclick: () => done(true), text: ok })));
  }, { labelledBy: id });
  return v === true;
}

/**
 * @param {{title:string, value?:string, placeholder?:string, ok?:string, maxLength?:number,
 *          validate?:(v:string)=>string|null, submit?:(v:string)=>Promise<string|null>}} o
 *   `submit` may return an error string to keep the dialog open.
 * @returns {Promise<string|null>} null when cancelled
 */
export function promptDialog({ title, value = '', placeholder = '', ok = '저장', maxLength = 200, validate, submit, body }) {
  const id = `dlg-${++seq}`;
  return open((box, done) => {
    const input = h('input', { class: 'input', value, placeholder, maxLength, autofocus: true, 'aria-labelledby': id, enterkeyhint: 'done' });
    const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const okBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: ok });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const v = input.value.trim();
        const msg = validate ? validate(v) : (v ? null : '');
        if (msg !== null) { err.textContent = msg; err.hidden = !msg; return; }
        if (submit) {
          okBtn.disabled = true;
          const res = await submit(v);
          okBtn.disabled = false;
          if (res) { err.textContent = res; err.hidden = false; return; }
        }
        done(v);
      },
    },
    h('h2', { class: 'dialog-title', id, text: title }),
    body ? h('p', { class: 'dialog-body', text: body }) : null,
    input, err,
    h('div', { class: 'dialog-btns' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => done(null), text: '취소' }),
      okBtn));
    add(box, form);
    requestAnimationFrame(() => { input.select(); });
  }, { labelledBy: id });
}
