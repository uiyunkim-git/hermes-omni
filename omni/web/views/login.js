// Login (spec §3.1): wordmark, tagline, 아이디/비밀번호, one primary button, inline errors.

import { api } from '../api.js';
import { h, nextId, fill } from '../util.js';
import { spinner } from '../ui/controls.js';

/** @param {HTMLElement} root @param {{onLogin:(user:string)=>void}} o */
export function mountLogin(root, o) {
  const uid = nextId('user');
  const pid = nextId('pass');
  const user = h('input', { id: uid, class: 'input lg', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true, enterkeyhint: 'next' });
  const pass = h('input', { id: pid, class: 'input lg', type: 'password', autocomplete: 'current-password', required: true, enterkeyhint: 'go' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, h('span', { text: '로그인' }));
  const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
  let busy = false;

  const form = h('form', {
    class: 'login-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      err.hidden = true;
      submit.disabled = true;
      fill(submit, spinner(16, 'on-accent'));
      try {
        const res = await api.login(user.value.trim(), pass.value);
        o.onLogin(res.user || user.value.trim());
      } catch (ex) {
        err.textContent = ex.status === 401 ? '아이디 또는 비밀번호가 맞지 않아요'
          : ex.status === 429 ? '잠시 후 다시 시도하세요'
            : ex.status === 0 ? '허브에 연결할 수 없어요' : (ex.message || '로그인하지 못했어요');
        err.hidden = false;
        busy = false;
        submit.disabled = false;
        fill(submit, h('span', { text: '로그인' }));
        pass.select();
      }
    },
  },
  h('div', { class: 'field' }, h('label', { class: 'field-label', for: uid, text: '아이디' }), user),
  h('div', { class: 'field' }, h('label', { class: 'field-label', for: pid, text: '비밀번호' }), pass),
  submit, err);

  fill(root, h('main', { class: 'login' },
    h('div', { class: 'login-col' },
      h('div', { class: 'login-brand' },
        h('h1', { class: 'wordmark', text: 'Hermes' }),
        h('p', { class: 'tagline', text: '모든 머신의 세션을 한곳에서' })),
      form)));
  setTimeout(() => user.focus(), 50);
  return { destroy() {} };
}
