// Answer cards for server→client requests forwarded by the hub (approval, clarify, sudo, secret).
// Result shapes follow tui_gateway/contracts/server_requests.py:
//   approval → {choice}, clarify → {answer} | {answers:{qid:answer}}, sudo/secret → {value} ('' = skip).

import { api } from '../api.js';
import { h, sessionHref, truncate } from '../util.js';
import { toastError } from './toast.js';

const APPROVAL_LABELS = {
  once: 'Allow once',
  session: 'Allow for session',
  always: 'Always allow',
  deny: 'Deny',
};

const METHOD_TITLES = {
  approval: 'Approval needed',
  clarify: 'Question',
  sudo: 'Sudo password',
  secret: 'Secret needed',
};

/**
 * @param {{node:string, stored_id:string, request:{request_id:string, method:string, params:object}}} item
 * @param {{context?: boolean, sessionTitle?: string, onAnswered?: (id:string)=>void}} [opts]
 */
export function requestCard(item, opts = {}) {
  const { node, stored_id: sid, request } = item;
  const p = request.params || {};
  const card = h('section', {
    class: `req-card req-${request.method}`,
    dataset: { requestId: request.request_id },
    'aria-label': METHOD_TITLES[request.method] || request.method,
  });

  const head = h('div', { class: 'req-head' },
    h('span', { class: 'req-icon', 'aria-hidden': 'true' }, request.method === 'approval' ? '⚠' : request.method === 'clarify' ? '?' : '🔑'),
    h('span', { class: 'req-title', text: METHOD_TITLES[request.method] || request.method }));
  if (opts.context) {
    head.append(h('a', { class: 'req-ctx', href: sessionHref(node, sid), text: truncate(opts.sessionTitle || `${node}#${sid}`, 48) }));
  }
  card.append(head);
  const body = h('div', { class: 'req-body' });
  card.append(body);

  const controls = [];
  const setBusy = (busy) => {
    for (const c of controls) c.disabled = busy;
    card.classList.toggle('busy', busy);
  };

  async function answer(result, label) {
    setBusy(true);
    try {
      await api.respond(node, sid, request.request_id, result);
      card.classList.add('answered');
      clearAnswerUi();
      body.append(h('p', { class: 'req-done', text: `Answered${label ? `: ${label}` : ''}` }));
      opts.onAnswered?.(request.request_id);
    } catch (err) {
      setBusy(false);
      toastError(err, 'Could not send answer');
    }
  }

  function clearAnswerUi() {
    card.querySelectorAll('.req-actions, .req-form').forEach((e) => e.remove());
  }

  const btn = (label, cls, onclick) => {
    const b = h('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
    controls.push(b);
    return b;
  };

  switch (request.method) {
    case 'approval': {
      if (p.description) body.append(h('p', { class: 'req-desc', text: p.description }));
      if (p.command) body.append(h('pre', { class: 'code req-cmd', text: p.command }));
      if (p.tool_name) body.append(h('p', { class: 'muted small', text: `Tool: ${p.tool_name}` }));
      let choices = Array.isArray(p.choices) && p.choices.length ? p.choices : ['once', 'session', 'always', 'deny'];
      if (p.allow_session === false) choices = choices.filter((c) => c !== 'session');
      if (p.allow_permanent === false) choices = choices.filter((c) => c !== 'always');
      body.append(h('div', { class: 'req-actions' }, choices.map((c) =>
        btn(APPROVAL_LABELS[c] || c, c === 'deny' ? 'btn-danger' : c === 'once' ? 'btn-primary' : '', () => answer({ choice: c }, APPROVAL_LABELS[c] || c)))));
      break;
    }
    case 'clarify':
      if (Array.isArray(p.questions) && p.questions.length) buildBatchClarify(body, p, controls, answer);
      else buildClarify(body, p, controls, answer, btn);
      break;
    case 'sudo':
    case 'secret': {
      const isSudo = request.method === 'sudo';
      if (isSudo && p.command) body.append(h('pre', { class: 'code req-cmd', text: p.command }));
      if (!isSudo && p.prompt) body.append(h('p', { class: 'req-desc', text: p.prompt }));
      if (!isSudo && p.env_var) body.append(h('p', { class: 'muted small' }, 'Variable: ', h('code', { text: p.env_var })));
      const id = `pw-${request.request_id}`;
      const input = h('input', {
        id, type: 'password', class: 'input', autocomplete: isSudo ? 'current-password' : 'off',
        autocapitalize: 'off', spellcheck: 'false', placeholder: isSudo ? 'Password' : 'Value',
      });
      controls.push(input);
      const form = h('form', {
        class: 'req-form',
        onsubmit: (e) => {
          e.preventDefault();
          const v = input.value;
          input.value = '';
          answer({ value: v }, 'sent');
        },
      },
      h('label', { class: 'sr-only', for: id, text: isSudo ? 'Sudo password' : `Value for ${p.env_var || 'secret'}` }),
      input,
      h('div', { class: 'req-actions' },
        (() => { const b = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send'); controls.push(b); return b; })(),
        btn('Skip', '', () => answer({ value: '' }, 'skipped'))));
      body.append(form);
      break;
    }
    default:
      body.append(h('pre', { class: 'code', text: truncate(JSON.stringify(p, null, 2), 2000) }));
  }
  return card;
}

function buildClarify(body, p, controls, answer, btn) {
  if (p.question) body.append(h('p', { class: 'req-desc', text: p.question }));
  const choices = Array.isArray(p.choices) ? p.choices : [];
  if (choices.length && p.multi_select) {
    const boxes = choices.map((c, i) => {
      const cb = h('input', { type: 'checkbox', value: c, id: `cb-${i}-${Math.random().toString(36).slice(2, 8)}` });
      controls.push(cb);
      return h('label', { class: 'check', for: cb.id }, cb, h('span', { text: c }));
    });
    body.append(h('div', { class: 'req-form' }, h('div', { class: 'checks' }, boxes),
      h('div', { class: 'req-actions' }, btn('Submit', 'btn-primary', () => {
        const picked = boxes.map((l) => l.querySelector('input')).filter((cb) => cb.checked).map((cb) => cb.value);
        answer({ answer: picked.join(', ') }, picked.join(', ') || '(none)');
      }))));
  } else if (choices.length) {
    body.append(h('div', { class: 'req-actions choices' }, choices.map((c) => btn(c, '', () => answer({ answer: c }, c)))));
  }
  const input = h('textarea', { class: 'input', rows: 2, placeholder: choices.length ? 'Or type an answer…' : 'Type your answer…', 'aria-label': 'Answer' });
  controls.push(input);
  body.append(h('form', {
    class: 'req-form',
    onsubmit: (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) answer({ answer: v }, truncate(v, 60));
    },
  }, input, h('div', { class: 'req-actions' },
    (() => { const b = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Answer'); controls.push(b); return b; })(),
    btn('Skip', '', () => answer({ answer: '' }, 'skipped')))));
}

function buildBatchClarify(body, p, controls, answer) {
  const locked = p.answers && typeof p.answers === 'object' ? p.answers : {};
  const getters = [];
  for (const q of p.questions) {
    const qid = String(q.qid);
    const wrap = h('fieldset', { class: 'req-q' }, h('legend', { text: q.question || qid }));
    const choices = Array.isArray(q.choices) ? q.choices : [];
    if (choices.length) {
      const name = `q-${qid}-${Math.random().toString(36).slice(2, 8)}`;
      const inputs = choices.map((c) => {
        const inp = h('input', { type: q.multi_select ? 'checkbox' : 'radio', name, value: c, checked: locked[qid] === c });
        controls.push(inp);
        return h('label', { class: 'check' }, inp, h('span', { text: c }));
      });
      const other = h('input', { class: 'input', type: 'text', placeholder: 'Other…', 'aria-label': `Other answer for: ${q.question || qid}` });
      controls.push(other);
      wrap.append(h('div', { class: 'checks' }, inputs), other);
      getters.push([qid, () => other.value.trim() || inputs.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value).join(', ')]);
    } else {
      const ta = h('textarea', { class: 'input', rows: 2, value: locked[qid] || '', 'aria-label': q.question || qid });
      controls.push(ta);
      wrap.append(ta);
      getters.push([qid, () => ta.value.trim()]);
    }
    body.append(wrap);
  }
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Submit answers');
  controls.push(submit);
  body.append(h('form', {
    class: 'req-form',
    onsubmit: (e) => {
      e.preventDefault();
      const answers = {};
      for (const [qid, get] of getters) answers[qid] = get();
      answer({ answers }, 'submitted');
    },
  }, h('div', { class: 'req-actions' }, submit)));
}
