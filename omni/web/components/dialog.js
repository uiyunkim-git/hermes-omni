// In-page modal dialogs (prompt / confirm). Native window.prompt/confirm are unreliable inside an
// Android WebView, so the UI uses these instead.

import { h } from '../util.js';

function open(build) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog' });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done(null); });
    build(dlg, done);
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[autofocus]')?.focus();
  });
}

/** @returns {Promise<string|null>} null when cancelled */
export function promptDialog({ title, label, value = '', placeholder = '', okLabel = 'OK' }) {
  return open((dlg, done) => {
    const input = h('input', { class: 'input', value, placeholder, autofocus: true, 'aria-label': label || title });
    dlg.append(h('form', {
      class: 'dialog-body',
      onsubmit: (e) => { e.preventDefault(); done(input.value); },
    },
    h('h2', { class: 'h2', text: title }),
    label ? h('p', { class: 'muted small', text: label }) : null,
    input,
    h('div', { class: 'row-btns end' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => done(null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, okLabel))));
  });
}

/** @returns {Promise<boolean>} */
export async function confirmDialog({ title, message, okLabel = 'OK', danger = false }) {
  const v = await open((dlg, done) => {
    dlg.append(h('div', { class: 'dialog-body' },
      h('h2', { class: 'h2', text: title }),
      message ? h('p', { text: message }) : null,
      h('div', { class: 'row-btns end' },
        h('button', { type: 'button', class: 'btn btn-ghost', autofocus: true, onclick: () => done(null) }, 'Cancel'),
        h('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true) }, okLabel))));
  });
  return v === true;
}
