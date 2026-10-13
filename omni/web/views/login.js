// #/login — hub admin sign-in (POST /api/login sets the omni_session cookie).

import { api } from '../api.js';
import { h } from '../util.js';

export default function loginView(main, ctx) {
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const user = h('input', { id: 'login-user', class: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true });
  const pass = h('input', { id: 'login-pass', class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');

  const form = h('form', { class: 'card login-card', onsubmit: onSubmit, 'aria-labelledby': 'login-h' },
    h('h1', { id: 'login-h', class: 'h1', text: 'Sign in' }),
    h('p', { class: 'muted', text: 'Use the Hermes dashboard credentials of the hub machine.' }),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Username' }), user),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Password' }), pass),
    err,
    submit);

  main.append(h('div', { class: 'page narrow' }, form));
  setTimeout(() => user.focus(), 0);

  async function onSubmit(e) {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const res = await api.login(user.value.trim(), pass.value);
      pass.value = '';
      ctx.onLogin(res.user || user.value.trim());
      ctx.navigate(ctx.query.get('next') || '#/', { replace: true });
    } catch (ex) {
      err.textContent = ex.status === 401 ? 'Wrong username or password.'
        : ex.status === 429 ? 'Too many attempts — wait a minute and try again.'
          : ex.message;
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Sign in';
      pass.select();
    }
  }
  return null;
}
