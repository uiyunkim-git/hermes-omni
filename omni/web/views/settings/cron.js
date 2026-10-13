// 예약 작업 (spec §3.6): jobs grouped by node; detail sheet (prompt, schedule, runs; run now,
// pause/resume, delete); create sheet with schedule quick chips and an optional folder.

import { api, errorText } from '../../api.js';
import { bus, state, onlineNodes } from '../../store.js';
import { h, relFuture, fmtDateTime, fmtDuration, firstLine, nextId, toMs, fill, add } from '../../util.js';
import { icon } from '../../ui/icons.js';
import { sectionHeader, group, loadingLine, errorLine, emptyState, button, toggle, kvRow } from '../../ui/controls.js';
import { createSheet } from '../../ui/sheet.js';
import { confirmDialog } from '../../ui/dialog.js';
import { toast, toastError } from '../../ui/toast.js';
import { createFolderPicker } from '../folderpicker.js';
import { page } from './common.js';

const QUICK = [['매시간', 'every 1h'], ['매일 오전 9시', '0 9 * * *'], ['평일 오전 9시', '0 9 * * 1-5'], ['매주 월요일', '0 9 * * 1']];

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function clockKo(hh, mm) {
  const h24 = Number(hh);
  const m = Number(mm);
  const half = h24 < 12 ? '오전' : '오후';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${half} ${h12}시${m ? ` ${m}분` : ''}`;
}

/** Common schedules in plain Korean ("매일 오전 9시", "30분마다"); anything else stays as written. */
export function scheduleKo(s) {
  const t = String(s || '').trim();
  let m = t.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hours?|d|days?)$/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2][0].toLowerCase();
    if (u === 'm') return n % 60 === 0 && n >= 60 ? (n === 60 ? '매시간' : `${n / 60}시간마다`) : `${n}분마다`;
    if (u === 'h') return n === 1 ? '매시간' : `${n}시간마다`;
    return n === 1 ? '매일' : `${n}일마다`;
  }
  m = t.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5|[0-6])$/);
  if (m) {
    const when = clockKo(m[2], m[1]);
    if (m[3] === '*') return `매일 ${when}`;
    if (m[3] === '1-5') return `평일 ${when}`;
    return `매주 ${DOW[Number(m[3])]}요일 ${when}`;
  }
  return t;
}

const jobPaused = (j) => j.enabled === false || j.state === 'paused';
const jobTitle = (j) => j.name || firstLine(j.prompt, 40) || j.id;

const DELIVER_KO = { local: '노드에만 저장', origin: '요청한 곳으로', all: '연결된 모든 채널' };
/** Where results go: Hermes keywords in Korean; platform targets as "Telegram · 1234". */
function deliverKo(d) {
  const s = String(d || 'local').trim();
  if (DELIVER_KO[s]) return DELIVER_KO[s];
  return s.split(',').map((t) => {
    const [p, ...rest] = t.trim().split(':');
    const name = p ? p[0].toUpperCase() + p.slice(1) : '';
    return rest.length ? `${name} · ${rest.join(':')}` : name;
  }).join(', ');
}

/**
 * The next run as a phrase. A paused job has none; an active job whose time has passed is due
 * on the scheduler's next tick ("곧 실행"), never "3분 전".
 */
function nextRunText(j, { long = false } = {}) {
  if (jobPaused(j)) return long ? '일시정지됨' : null;
  if (!j.next_run_at) return long ? '–' : null;
  const ms = toMs(j.next_run_at);
  if (ms !== null && ms <= Date.now() + 30000) return '곧 실행';
  return long ? `${fmtDateTime(j.next_run_at)} (${relFuture(j.next_run_at)})` : `다음 실행 ${relFuture(j.next_run_at)}`;
}
const isDue = (j) => !jobPaused(j) && j.next_run_at && (toMs(j.next_run_at) ?? Infinity) <= Date.now() + 30000;

export function mountCron(root) {
  const fabBtn = button('예약 작업', { variant: 'primary', icon: 'plus', small: true, onClick: () => openCreate() });
  const p = page({ title: '예약 작업', right: [fabBtn] });
  fill(root, p.el);
  const byNode = new Map();       // node → {jobs?, err?}
  let alive = true;

  function render() {
    const kids = [];
    let total = 0;
    for (const n of state.nodes) {
      const d = byNode.get(n.node_id);
      const head = sectionHeader(n.display_name || n.node_id, n.online ? null : h('span', { class: 'sh-note', text: '오프라인' }));
      if (!n.online) { kids.push(h('div', { class: 'offline-sec' }, head)); continue; }
      let body;
      if (!d) body = [loadingLine()];
      else if (d.err) body = [errorLine(errorText(d.err, '예약 작업을 불러오지 못했어요'), () => loadNode(n.node_id))];
      else if (!d.jobs.length) body = [h('p', { class: 'group-empty', text: '예약 작업이 없어요' })];
      else {
        total += d.jobs.length;
        body = d.jobs.map((j) => jobRow(n.node_id, j));
      }
      kids.push(head, group(body));
    }
    if (!state.nodes.length) kids.push(emptyState({ title: '예약 작업이 없어요' }));
    fill(p.body, ...kids);
    return total;
  }

  function jobRow(node, j) {
    const next = nextRunText(j);
    let st = null;
    if (jobPaused(j)) st = h('span', { class: 'job-st', text: '일시정지' });
    else if (j.last_status === 'error' || j.last_status === 'failed') st = h('span', { class: 'job-st danger', text: '실패' });
    return h('button', { type: 'button', class: 'job-row', onclick: () => openDetail(node, j) },
      h('span', { class: 'lr-text' },
        h('span', { class: 'lr-title', text: jobTitle(j) }),
        h('span', { class: 'lr-sub', text: [scheduleKo(j.schedule_display || j.schedule?.display), next].filter(Boolean).join(' · ') })),
      st, icon('chevron-right', 18, 'lr-chev'));
  }

  const dueTimers = new Map();   // node → refetch timer while a job is due
  async function loadNode(node) {
    try {
      const res = await api.rest(node, 'GET', '/api/cron/jobs', { query: { profile: 'all' } });
      byNode.set(node, { jobs: Array.isArray(res) ? res : (res?.jobs || []) });
    } catch (err) {
      byNode.set(node, { err });
    }
    if (!alive) return;
    render();
    // A job shown as "곧 실행" gets a new next run after the scheduler's tick (about a minute).
    if (byNode.get(node)?.jobs?.some(isDue) && !dueTimers.has(node)) {
      dueTimers.set(node, setTimeout(() => { dueTimers.delete(node); if (alive) loadNode(node); }, 45000));
    }
  }
  const loadAll = () => { for (const n of onlineNodes()) loadNode(n.node_id); render(); };

  // ---------------------------------------------------------------- detail
  function openDetail(node, j) {
    const sheet = createSheet({ title: jobTitle(j), desktop: 'dialog', width: 560, tall: false, cls: 'job-sheet' });
    const runs = h('div', { class: 'runs' }, loadingLine());
    let paused = jobPaused(j);
    const act = async (path, okMsg, method = 'POST') => {
      try {
        await api.rest(node, method, path);
        toast(okMsg);
        return true;
      } catch (err) { toastError(err, '처리하지 못했어요'); return false; }
    };
    const base = `/api/cron/jobs/${encodeURIComponent(j.id)}`;
    // Pause/resume updates the open sheet in place (label, next run) and refreshes the list.
    const pauseBtn = button(paused ? '재개' : '일시정지', {
      variant: 'secondary', small: true,
      onClick: async () => {
        pauseBtn.disabled = true;
        const ok = await act(`${base}/${paused ? 'resume' : 'pause'}`, paused ? '재개했어요' : '일시정지했어요');
        pauseBtn.disabled = false;
        if (!ok) return;
        paused = !paused;
        j.enabled = !paused;
        j.state = paused ? 'paused' : 'scheduled';
        pauseBtn.lastChild.textContent = paused ? '재개' : '일시정지';
        renderKv();
        await loadNode(node);
        const fresh = byNode.get(node)?.jobs?.find((x) => x.id === j.id);
        if (fresh && !sheet.closed) {
          Object.assign(j, fresh);
          paused = jobPaused(j);
          pauseBtn.lastChild.textContent = paused ? '재개' : '일시정지';
          renderKv();
        }
      },
    });
    const buttons = h('div', { class: 'row-btns wrap' },
      button('지금 실행', { variant: 'primary', small: true, icon: 'arrow-up', onClick: async () => { if (await act(`${base}/trigger`, '실행을 요청했어요')) setTimeout(loadRuns, 1500); } }),
      pauseBtn,
      button('삭제', {
        variant: 'danger-outline', small: true,
        onClick: async () => {
          if (!(await confirmDialog({ title: '예약 작업을 삭제할까요?', ok: '삭제', danger: true }))) return;
          if (await act(base, '삭제했어요', 'DELETE')) { sheet.close(); loadNode(node); }
        },
      }));
    const kv = h('div');
    function renderKv() {
      fill(kv, group([
        kvRow('일정', scheduleKo(j.schedule_display || j.schedule?.display) || '–'),
        kvRow('다음 실행', nextRunText(j, { long: true })),
        kvRow('작업 폴더', j.workdir || '기본', { mono: !!j.workdir }),
        kvRow('모델', j.model || '기본'),
        kvRow('결과 전달', deliverKo(j.deliver)),
        kvRow('노드', state.nodes.find((n) => n.node_id === node)?.display_name || node),
      ]));
    }
    renderKv();
    add(sheet.body,
      h('pre', { class: 'job-prompt', text: j.prompt || '' }),
      kv,
      j.last_error ? h('p', { class: 'caption danger', text: `최근 오류: ${j.last_error}` }) : null,
      buttons,
      sectionHeader('최근 실행'),
      runs);
    async function loadRuns() {
      try {
        const res = await api.rest(node, 'GET', `${base}/runs`, { query: { limit: 10 } });
        const list = Array.isArray(res) ? res : (res?.runs || []);
        fill(runs, ...(list.length ? list.map((r) => {
          const ok = !(r.status === 'error' || r.status === 'failed' || r.success === false);
          const dur = Number(r.duration_s ?? r.duration);
          return h('div', { class: 'run-row' },
            icon(ok ? 'check' : 'x', 14, ok ? 'ok' : 'bad'),
            h('span', { class: 'run-t', text: fmtDateTime(r.started_at ?? r.at ?? r.created_at) }),
            h('span', { class: 'run-d', text: Number.isFinite(dur) ? fmtDuration(dur) : (r.status || '') }));
        }) : [h('p', { class: 'group-empty', text: '아직 실행 기록이 없어요' })]));
      } catch (err) {
        fill(runs, errorLine(errorText(err, '실행 기록을 불러오지 못했어요')));
      }
    }
    loadRuns();
  }

  // ---------------------------------------------------------------- create
  function openCreate() {
    const online = onlineNodes();
    if (!online.length) { toast('온라인 노드가 없어요', { tone: 'error' }); return; }
    let node = online[0].node_id;
    const make = button('만들기', { variant: 'primary', cls: 'btn-block', type: 'submit' });
    const err = h('p', { class: 'field-error', hidden: true });
    const formId = nextId('cron');
    make.setAttribute('form', formId);
    const sheet = createSheet({ title: '예약 작업 만들기', desktop: 'dialog', width: 560, tall: true, footer: h('div', { class: 'ns-foot' }, err, make) });
    const name = nextId('n');
    const nodeList = h('div', { class: 'radio-list', role: 'radiogroup', 'aria-label': '노드' }, state.nodes.map((n) => h('label', { class: `radio-row${n.online ? '' : ' disabled'}` },
      h('input', { type: 'radio', name, value: n.node_id, checked: n.node_id === node, disabled: !n.online, onchange: () => { node = n.node_id; picker.setNode(node); } }),
      h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: n.display_name || n.node_id }), n.online ? null : h('span', { class: 'lr-sub', text: '오프라인' })))));
    const nameIn = h('input', { class: 'input', placeholder: '이름 (선택)', 'aria-label': '이름', maxLength: 120 });
    const promptIn = h('textarea', { class: 'input', rows: 4, placeholder: '무엇을 할까요?', 'aria-label': '프롬프트', required: true });
    const schedIn = h('input', { class: 'input mono', placeholder: '예: every 2h 또는 0 9 * * *', 'aria-label': '일정', autocapitalize: 'off', spellcheck: 'false', required: true });
    const quick = h('div', { class: 'chip-row wrap' }, QUICK.map(([l, v]) => h('button', {
      type: 'button', class: 'chip', text: l, onclick: (e) => { schedIn.value = v; quick.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget)); },
    })));
    const picker = createFolderPicker({ node, value: null, noneLabel: '기본 작업 폴더' });
    const startNow = toggle({ checked: true, label: '바로 시작' });
    const field = (label, ...kids) => h('div', { class: 'field' }, h('span', { class: 'field-label', text: label }), ...kids);
    add(sheet.body, h('form', {
      id: formId, class: 'ns-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const prompt = promptIn.value.trim();
        const schedule = schedIn.value.trim();
        if (!prompt || !schedule) { err.textContent = '프롬프트와 일정을 입력하세요'; err.hidden = false; return; }
        make.disabled = true;
        err.hidden = true;
        try {
          const body = { prompt, schedule, deliver: 'local' };
          if (nameIn.value.trim()) body.name = nameIn.value.trim();
          if (picker.value) body.workdir = picker.value;
          const job = await api.rest(node, 'POST', '/api/cron/jobs', { body });
          if (startNow.input.checked && job?.id) {
            try { await api.rest(node, 'POST', `/api/cron/jobs/${encodeURIComponent(job.id)}/resume`); } catch { /* created paused */ }
          }
          sheet.close();
          toast('예약 작업을 만들었어요');
          loadNode(node);
        } catch (ex) {
          make.disabled = false;
          err.textContent = errorText(ex, '만들지 못했어요');
          err.hidden = false;
        }
      },
    },
    field('노드', nodeList),
    field('이름', nameIn),
    field('프롬프트', promptIn),
    field('일정', schedIn, quick),
    field('작업 폴더', picker.el),
    h('div', { class: 'list-row' }, h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '바로 시작' })), startNow)));
  }

  const off = bus.on('nodes', () => {
    for (const n of onlineNodes()) if (!byNode.has(n.node_id)) loadNode(n.node_id);
    render();
  });
  loadAll();
  return { destroy: () => { alive = false; off(); for (const t of dueTimers.values()) clearTimeout(t); } };
}

