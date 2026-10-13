// Request cards docked above the composer (spec §3.4.3): approval, clarify, sudo, secret.
// Result shapes follow Hermes server requests:
//   approval → {choice}, clarify → {answer} | {answers:{qid:answer}}, sudo/secret → {value} ('' = skip).

import { api } from '../api.js';
import { h, truncate, nextId, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

const TITLES = {
  approval: '명령 실행 승인',
  clarify: '질문이 있어요',
  sudo: '관리자 비밀번호가 필요해요',
  secret: '비밀 값이 필요해요',
};

// `once` and `deny` are always in view; the broader grants (`alt`) sit behind "다른 선택" on a
// phone and join the same row on desktop.
const APPROVAL = {
  once: { label: '허용', cls: 'btn-primary', record: '승인함 · 한 번' },
  session: { label: '이 세션 동안 허용', cls: 'btn-secondary alt', record: '승인함 · 이 세션 동안' },
  always: { label: '항상 허용', cls: 'btn-secondary alt', record: '승인함 · 항상' },
  deny: { label: '거부', cls: 'btn-danger-outline', record: '거부함' },
};

export const requestTitle = (method) => TITLES[method] || '응답이 필요해요';

const HANGUL = /[가-힣]/;

/**
 * Hermes approval reasons are English pattern descriptions ("recursive delete", or the long
 * execute_code notice). Known families map to one plain Korean line; the original text stays
 * available behind "자세히". First match wins, so specific families come first.
 */
const REASONS = [
  [/execute_code/i, '스크립트가 파일을 바꾸거나 다른 명령을 실행할 수 있어요'],
  [/delete in root path/i, '루트(/) 아래 경로를 삭제해요'],
  [/gateway|hermes update|launchd/i, 'Hermes를 멈추거나 다시 시작해요. 실행 중인 작업이 끊겨요'],
  [/docker|podman|container/i, '컨테이너를 멈추거나 다른 Docker 데몬에 연결해요'],
  [/metadata endpoint/i, '클라우드 인증 정보에 접근해요'],
  [/exfiltration|credential|ssh keys|secrets/i, '비밀 정보나 인증 파일에 접근해요'],
  [/obfuscation|invisible|bidirectional/i, '내용이 가려진 명령을 실행해요'],
  [/remote (content|script)|\| iex/i, '인터넷에서 받은 내용을 바로 실행해요'],
  [/\bSQL\b/, '데이터베이스의 데이터를 지우거나 비워요'],
  [/backups|shadow copies/i, '백업을 삭제해요'],
  [/delete|\brm\b/i, '파일이나 폴더를 통째로 삭제해요'],
  [/fork bomb|kill/i, '프로세스를 강제로 종료해요'],
  [/permissions|chmod|chown|acl|everyone access/i, '파일 권한을 넓게 바꿔요'],
  [/format|disk|block device|wipe/i, '디스크를 포맷하거나 덮어써요'],
  [/config|system file|shell-rc|registry/i, '시스템이나 프로젝트 설정 파일을 덮어써요'],
  [/service|systemctl/i, '시스템 서비스를 멈추거나 다시 시작해요'],
];

/** Korean title and reason line for an approval request; `detail` is Hermes' own text. */
export function approvalCopy(p = {}) {
  const raw = String(p.description || '').trim();
  const key = String(p.pattern_key || '');
  const isCode = key === 'execute_code' || /^execute_code\b/.test(raw) || /^execute_code\b/.test(String(p.command || ''));
  const title = isCode ? '코드 실행 승인' : TITLES.approval;
  if (!raw) return { title, reason: '', detail: '' };
  if (HANGUL.test(raw)) return { title, reason: raw, detail: '' };
  const hit = REASONS.find(([re]) => re.test(`${key} ${raw}`));
  return { title, reason: hit ? hit[1] : '위험할 수 있는 작업이라 확인이 필요해요', detail: raw };
}

/** The record line for a result we know (ours, or one a resolution frame carries). */
export function recordFor(method, result) {
  const r = result && typeof result === 'object' ? result : {};
  if (typeof r.choice === 'string') {
    return { ok: r.choice !== 'deny', text: APPROVAL[r.choice]?.record || `선택함: ${r.choice}` };
  }
  if (typeof r.answer === 'string') return { ok: true, text: `답변함: ${truncate(r.answer, 60)}` };
  if (r.answers && typeof r.answers === 'object') return { ok: true, text: '답변함' };
  if (typeof r.value === 'string') return r.value ? { ok: true, text: '보냈어요' } : { ok: false, text: '건너뜀' };
  return null;
}

/**
 * Record line for a request that closed without our answer (`session.request_cancel`).
 * The hub may carry the resolution (`resolved`/`result`); otherwise the reason says whether
 * someone answered (another device through the hub, or another Hermes surface) or it was
 * withdrawn (turn ended, interrupt, timeout).
 */
export function cancelRecord(m, method) {
  const known = recordFor(method, m?.resolved || m?.result || (m?.choice ? { choice: m.choice } : null));
  if (known) return { ...known, text: `${known.text} · 다른 기기` };
  // An approval's verdict is read off the call it guarded once that call ends (`via`, see
  // transcript.settledRecord): "다른 기기에서 허용함" / "…거부함".
  const via = (where) => (method === 'approval' ? { via: where } : {});
  switch (m?.reason) {
    case undefined: case null: case '': case 'answered':
      return { ok: true, text: '다른 기기에서 응답함', ...via('다른 기기에서') };
    case 'resolved':
      return { ok: true, text: '다른 곳에서 응답함', ...via('다른 곳에서') };
    case 'gone':
      return { ok: true, text: '다른 곳에서 처리됨', ...via('다른 곳에서') };
    case 'timeout':
      return { ok: false, text: '시간이 지나 취소됨' };
    default:
      return { ok: false, text: '취소됨' };
  }
}

/**
 * @param {{node:string, sid:string, request:{request_id:string, method:string, params:object}}} o
 * @param {{onStart?:() => void, onDone?:(record:{ok:boolean,text:string}) => void,
 *          onFail?:(err:Error) => boolean}} [cb]  onFail returns true when it handled the failure
 */
export function requestCard({ node, sid, request }, cb = {}) {
  const p = request.params || {};
  const method = request.method;
  const copy = method === 'approval' ? approvalCopy(p) : null;
  const title = copy?.title || requestTitle(method);
  const card = h('section', { class: `req-card req-${method}`, dataset: { requestId: request.request_id }, 'aria-label': title });
  // The head and the approval buttons stay put; only the middle scrolls when the content is
  // tall (a long script on a phone), so the answer buttons are always on screen.
  const body = h('div', { class: 'req-body' });
  add(card, h('div', { class: 'req-head' }, icon('alert', 18, 'req-icon'), h('h3', { class: 'req-title', text: title })),
    h('div', { class: 'req-scroll' }, body));

  const controls = [];
  const reg = (el) => { controls.push(el); return el; };
  const setBusy = (busy) => {
    for (const c of controls) c.disabled = busy;
    card.classList.toggle('busy', busy);
  };

  async function answer(result, record) {
    setBusy(true);
    cb.onStart?.();
    try {
      await api.respond(node, sid, request.request_id, result);
      cb.onDone?.(record);
    } catch (err) {
      if (cb.onFail?.(err)) return;
      setBusy(false);
      toast('응답을 보내지 못했어요', { tone: 'error' });
    }
  }

  const cmdBlock = (text) => {
    const pre = h('pre', { class: 'req-cmd clamp', text });
    const wrap = h('div', { class: 'req-cmd-wrap' }, pre);
    // ~6 lines visible; the rest one tap away (it then scrolls inside the card).
    if (text.split('\n').length > 6 || text.length > 300) {
      const more = h('button', { type: 'button', class: 'btn-link req-cmd-more', text: '더 보기', 'aria-expanded': 'false' });
      more.addEventListener('click', () => {
        const clamped = pre.classList.toggle('clamp');
        more.textContent = clamped ? '더 보기' : '접기';
        more.setAttribute('aria-expanded', clamped ? 'false' : 'true');
      });
      add(wrap, more);
    } else pre.classList.remove('clamp');
    return wrap;
  };

  switch (method) {
    case 'approval': {
      if (copy.reason) add(body, h('p', { class: 'req-desc', text: copy.reason }));
      if (copy.detail) {
        add(body, h('details', { class: 'req-detail' },
          h('summary', {}, h('span', { text: '자세히' }), icon('chevron-right', 14, 'det-chev')),
          h('p', { class: 'req-detail-text', text: copy.detail })));
      }
      if (p.command) add(body, cmdBlock(String(p.command)));
      let choices = Array.isArray(p.choices) && p.choices.length ? p.choices : ['once', 'session', 'always', 'deny'];
      if (p.allow_session === false) choices = choices.filter((c) => c !== 'session');
      if (p.allow_permanent === false) choices = choices.filter((c) => c !== 'always');
      const btn = (c) => {
        const spec = APPROVAL[c] || { label: c, cls: 'btn-secondary alt', record: `선택함: ${c}` };
        return reg(h('button', {
          type: 'button', class: `btn ${spec.cls}`, text: spec.label, dataset: { choice: c },
          onclick: () => answer({ choice: c }, { ok: c !== 'deny', text: spec.record }),
        }));
      };
      const isAlt = (c) => !APPROVAL[c] || APPROVAL[c].cls.includes('alt');
      const main = choices.filter((c) => !isAlt(c)).map(btn);
      const alts = choices.filter(isAlt).map(btn);
      const foot = h('div', { class: 'req-foot' }, h('div', { class: `req-actions approval req-main n${main.length}` }, main));
      if (alts.length) {
        const altRow = h('div', { class: `req-actions approval req-alts n${alts.length}` }, alts);
        const toggleAlt = h('button', { type: 'button', class: 'req-alt-toggle', 'aria-expanded': 'false' },
          h('span', { text: '다른 선택' }), icon('chevron-down', 14, 'det-chev'));
        toggleAlt.addEventListener('click', () => {
          const open = !card.classList.contains('alts-open');
          card.classList.toggle('alts-open', open);
          toggleAlt.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        add(foot, toggleAlt, altRow);
      }
      add(card, foot);
      break;
    }
    case 'clarify':
      if (Array.isArray(p.questions) && p.questions.length) buildBatch(body, p, reg, answer);
      else buildClarify(body, p, reg, answer);
      break;
    case 'sudo':
    case 'secret': {
      const isSudo = method === 'sudo';
      if (isSudo && p.command) add(body, cmdBlock(String(p.command)));
      if (!isSudo && p.prompt) add(body, h('p', { class: 'req-desc', text: p.prompt }));
      if (!isSudo && p.env_var) add(body, h('p', { class: 'req-meta' }, '변수 ', h('code', { text: p.env_var })));
      const id = nextId('pw');
      const input = reg(h('input', {
        id, type: 'password', class: 'input', autocomplete: isSudo ? 'current-password' : 'off',
        autocapitalize: 'off', spellcheck: 'false', placeholder: isSudo ? '비밀번호' : '값',
        'aria-label': isSudo ? '관리자 비밀번호' : `${p.env_var || '비밀'} 값`,
      }));
      const eye = h('button', { type: 'button', class: 'icon-btn input-eye', 'aria-label': '보기' }, icon('eye', 18));
      eye.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        fill(eye, icon(show ? 'eye-off' : 'eye', 18));
        eye.setAttribute('aria-label', show ? '숨기기' : '보기');
      });
      const send = reg(h('button', { type: 'submit', class: 'btn btn-primary', text: '보내기' }));
      const skip = reg(h('button', { type: 'button', class: 'btn btn-ghost', text: '건너뛰기', onclick: () => answer({ value: '' }, { ok: false, text: '건너뜀' }) }));
      add(body, h('form', {
        class: 'req-form',
        onsubmit: (e) => {
          e.preventDefault();
          const v = input.value;
          input.value = '';
          answer({ value: v }, { ok: true, text: '보냈어요' });
        },
      }, h('div', { class: 'input-with-btn' }, input, eye), h('div', { class: 'req-actions' }, skip, send)));
      break;
    }
    default:
      add(body, h('pre', { class: 'req-cmd', text: truncate(JSON.stringify(p, null, 2), 2000) }));
  }
  return card;
}

function buildClarify(body, p, reg, answer) {
  if (p.question) add(body, h('p', { class: 'req-q', text: p.question }));
  const choices = Array.isArray(p.choices) ? p.choices.map(String) : [];
  if (choices.length && p.multi_select) {
    const boxes = choices.map((c) => {
      const cb = reg(h('input', { type: 'checkbox', value: c }));
      return h('label', { class: 'check-row' }, cb, h('span', { text: c }));
    });
    const send = reg(h('button', {
      type: 'button', class: 'btn btn-primary', text: '보내기',
      onclick: () => {
        const picked = boxes.map((l) => l.querySelector('input')).filter((x) => x.checked).map((x) => x.value);
        if (picked.length) answer({ answer: picked.join(', ') }, { ok: true, text: `답변함: ${truncate(picked.join(', '), 60)}` });
      },
    }));
    add(body, h('div', { class: 'check-list' }, boxes), h('div', { class: 'req-actions' }, send));
  } else if (choices.length) {
    add(body, h('div', { class: 'req-choices' }, choices.map((c) => reg(h('button', {
      type: 'button', class: 'btn btn-secondary choice', text: c,
      onclick: () => answer({ answer: c }, { ok: true, text: `답변함: ${truncate(c, 60)}` }),
    })))));
  }
  const ta = reg(h('textarea', { class: 'input', rows: 2, placeholder: '직접 입력', 'aria-label': '직접 입력' }));
  const send = reg(h('button', { type: 'submit', class: `btn ${choices.length ? 'btn-secondary' : 'btn-primary'}`, text: '보내기' }));
  add(body, h('form', {
    class: 'req-form',
    onsubmit: (e) => {
      e.preventDefault();
      const v = ta.value.trim();
      if (v) answer({ answer: v }, { ok: true, text: `답변함: ${truncate(v, 60)}` });
    },
  }, ta, h('div', { class: 'req-actions' }, send)));
}

function buildBatch(body, p, reg, answer) {
  const locked = p.answers && typeof p.answers === 'object' ? p.answers : {};
  const getters = [];
  for (const q of p.questions) {
    const qid = String(q.qid);
    const block = h('fieldset', { class: 'req-qblock' }, h('legend', { class: 'req-q', text: q.question || qid }));
    const choices = Array.isArray(q.choices) ? q.choices.map(String) : [];
    if (choices.length) {
      const name = nextId('q');
      const inputs = choices.map((c) => {
        const inp = reg(h('input', { type: q.multi_select ? 'checkbox' : 'radio', name, value: c, checked: locked[qid] === c }));
        return h('label', { class: 'check-row' }, inp, h('span', { text: c }));
      });
      const other = reg(h('input', { class: 'input', type: 'text', placeholder: '직접 입력', 'aria-label': `${q.question || qid} 직접 입력` }));
      add(block, h('div', { class: 'check-list' }, inputs), other);
      getters.push([qid, () => other.value.trim() || inputs.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value).join(', ')]);
    } else {
      const ta = reg(h('textarea', { class: 'input', rows: 2, value: locked[qid] || '', 'aria-label': q.question || qid }));
      add(block, ta);
      getters.push([qid, () => ta.value.trim()]);
    }
    add(body, block);
  }
  const submit = reg(h('button', { type: 'submit', class: 'btn btn-primary', text: '모두 보내기' }));
  add(body, h('form', {
    class: 'req-form',
    onsubmit: (e) => {
      e.preventDefault();
      const answers = {};
      for (const [qid, get] of getters) answers[qid] = get();
      answer({ answers }, { ok: true, text: '답변함' });
    },
  }, h('div', { class: 'req-actions' }, submit)));
}
