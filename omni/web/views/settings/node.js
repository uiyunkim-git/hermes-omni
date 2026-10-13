// Node detail (spec §3.6): status, system (polled every 10 s), GPUs (the only place GPU data
// appears), approval mode, folders, logs, profiles, dashboard link and "이 노드 잊기".

import { api, errorText } from '../../api.js';
import { bus, findNode, nodeSupportsFeatures } from '../../store.js';
import { navigate } from '../../router.js';
import { h, relTime, fmtUptime, fmtGB, enc, fill, add } from '../../util.js';
import { icon } from '../../ui/icons.js';
import {
  sectionHeader, group, kvRow, listRow, progressBar, segmented, loadingLine, errorLine, button, emptyState, selectWrap,
} from '../../ui/controls.js';
import { confirmDialog } from '../../ui/dialog.js';
import { toast, toastError } from '../../ui/toast.js';
import { page } from './common.js';

const MODES = [
  { value: 'manual', label: '수동', caption: '위험한 명령마다 물어봐요' },
  { value: 'smart', label: '스마트', caption: '필요할 때만 물어봐요' },
  { value: 'off', label: '끔', caption: '묻지 않고 실행해요 (주의)' },
];

const GATEWAY_KO = {
  running: '실행 중', starting: '시작 중', stopping: '멈추는 중', stopped: '멈춤', restarting: '다시 시작 중',
  error: '오류', failed: '오류', unknown: '알 수 없음',
};
const gatewayKo = (s) => (s ? GATEWAY_KO[String(s).toLowerCase()] || String(s) : '–');

/** @param {HTMLElement} root @param {{node:string}} o */
export function mountNodeDetail(root, { node }) {
  const p = page({ title: node, subtitle: '' });
  fill(root, p.el);
  let alive = true;
  let status = null;
  let stats = null;
  let statsErr = null;
  let mode = null;
  let folders = null;
  let profiles = null;

  const statusSec = h('div');
  const systemSec = h('div');
  const gpuSec = h('div');
  const modeSec = h('div');
  const folderSec = h('div');
  const profileSec = h('div');
  const actionSec = h('div', { class: 'page-actions' });

  function n() { return findNode(node); }

  function renderStatus() {
    const info = n();
    p.setTitle(info?.display_name || node, info?.hostname || '');
    if (!info) {
      fill(statusSec, emptyState({ title: '이 노드를 찾을 수 없어요' }));
      return;
    }
    const online = !!info.online;
    fill(statusSec, sectionHeader('상태'), group([
      kvRow('상태', online ? '온라인' : `오프라인${info.last_seen ? ` · ${relTime(info.last_seen)}` : ''}`, { cls: online ? 'ok' : '' }),
      kvRow('Hermes', info.hermes?.version ? `v${info.hermes.version}` : '–'),
      kvRow('기본 모델', info.hermes?.model || '–', { mono: true }),
      kvRow('게이트웨이', gatewayKo(status?.gateway_state || info.hermes?.gateway_state)),
      kvRow('실행 중 에이전트', Number.isFinite(status?.active_agents) ? `${status.active_agents}개` : '–'),
      kvRow('link', info.link_version ? `v${info.link_version}` : '–'),
      kvRow('프로토콜', info.proto !== undefined ? String(info.proto) : '–'),
    ]));
  }

  function meter(label, pct, valueText) {
    return h('div', { class: 'meter' },
      h('div', { class: 'meter-top' }, h('span', { class: 'meter-k', text: label }), h('span', { class: 'meter-v', text: valueText })),
      progressBar(pct));
  }

  function renderSystem() {
    if (!n()?.online || !nodeSupportsFeatures(node)) { fill(systemSec); return; }
    let body;
    if (statsErr && !stats) body = errorLine(errorText(statsErr, '시스템 정보를 불러오지 못했어요'));
    else if (!stats) body = loadingLine();
    else {
      const m = stats.memory || {};
      const d = stats.disk || {};
      body = h('div', { class: 'meters' },
        meter('CPU', stats.cpu_percent, `${Math.round(stats.cpu_percent ?? 0)}%`),
        meter('메모리', m.percent, `${fmtGB(m.used)} / ${fmtGB(m.total)} GB`),
        meter('디스크', d.percent, `${fmtGB(d.used)} / ${fmtGB(d.total)} GB`),
        h('div', { class: 'meter-top uptime' }, h('span', { class: 'meter-k', text: '가동 시간' }), h('span', { class: 'meter-v', text: fmtUptime(stats.uptime_seconds) })));
    }
    fill(systemSec, sectionHeader('시스템'), group([body], 'pad'));
  }

  function renderGpus() {
    const gpus = n()?.gpus || [];
    if (!gpus.length) { fill(gpuSec); return; }
    fill(gpuSec, sectionHeader('GPU'), group(gpus.map((g) => {
      const memPct = g.mem_total_mb ? (g.mem_used_mb / g.mem_total_mb) * 100 : 0;
      return h('div', { class: 'gpu' },
        h('div', { class: 'gpu-name', text: `${g.index ?? ''} · ${g.name || 'GPU'}` }),
        h('div', { class: 'meter-top' }, h('span', { class: 'meter-k', text: '사용률' }), h('span', { class: 'meter-v', text: `${g.util_pct ?? 0}%` })),
        progressBar(g.util_pct, { tone: 'accent' }),
        h('div', { class: 'meter-top' }, h('span', { class: 'meter-k', text: '메모리' }),
          h('span', { class: 'meter-v', text: `${((g.mem_used_mb || 0) / 1024).toFixed(1)} / ${((g.mem_total_mb || 0) / 1024).toFixed(1)} GB` })),
        progressBar(memPct, { tone: 'accent' }));
    }), 'pad'));
  }

  function renderMode() {
    if (!n()?.online || !nodeSupportsFeatures(node)) { fill(modeSec); return; }
    if (mode === null) { fill(modeSec, sectionHeader('승인 모드'), group([loadingLine()], 'pad')); return; }
    const caption = h('p', { class: 'caption', text: MODES.find((m) => m.value === mode)?.caption || '' });
    const seg = segmented({
      label: '승인 모드', options: MODES, value: mode,
      onChange: async (v) => {
        if (v === 'off') {
          const ok = await confirmDialog({ title: '승인을 끌까요?', body: '이 노드의 에이전트가 묻지 않고 모든 명령을 실행해요.', ok: '끄기', danger: true });
          if (!ok) return false;
        }
        try {
          await api.rpc(node, 'config.set', { key: 'approvals.mode', value: v });
          const res = await api.rpc(node, 'config.get', { key: 'approvals.mode' });
          mode = res?.value || v;
          caption.textContent = MODES.find((m) => m.value === mode)?.caption || '';
          toast('승인 모드를 바꿨어요');
          return true;
        } catch (err) {
          toastError(err, '바꾸지 못했어요');
          return false;
        }
      },
    });
    fill(modeSec, sectionHeader('승인 모드'), group([seg, caption], 'pad'));
  }

  function renderFolders() {
    if (!n()?.online) { fill(folderSec); return; }
    let body;
    if (folders === null) body = [loadingLine()];
    else if (folders instanceof Error) body = [errorLine(errorText(folders, '폴더를 불러오지 못했어요'), loadFolders)];
    else {
      const list = folders.folders || [];
      body = list.map((f) => h('div', { class: 'folder-row' },
        h('span', { class: 'lr-title', text: f.name }),
        h('span', { class: 'lr-sub mono', text: f.path }),
        f.git_branch ? h('span', { class: 'fr-branch mono', text: f.git_branch }) : null));
      if (!list.length) body.push(h('p', { class: 'group-empty', text: '폴더가 없어요' }));
      body.push(newFolderForm(folders.roots || []));
    }
    fill(folderSec, sectionHeader(`폴더${folders && !(folders instanceof Error) ? ` ${(folders.folders || []).length}` : ''}`), group(body));
  }

  function newFolderForm(roots) {
    const wrap = h('div', { class: 'nf' });
    const open = () => {
      const name = h('input', { class: 'input', placeholder: '폴더 이름', 'aria-label': '새 폴더 이름', autocapitalize: 'off', spellcheck: 'false' });
      const rootSel = roots.length > 1 ? h('select', { class: 'input', 'aria-label': '상위 폴더' }, roots.map((r) => h('option', { value: r, text: r }))) : null;
      const err = h('p', { class: 'field-error', hidden: true });
      const make = button('만들기', { variant: 'primary', small: true, type: 'submit' });
      fill(wrap, h('form', {
        class: 'fp-create',
        onsubmit: async (e) => {
          e.preventDefault();
          const v = name.value.trim();
          if (!/^[A-Za-z0-9._-]+$/.test(v)) { err.textContent = '영문, 숫자, . _ - 만 쓸 수 있어요'; err.hidden = false; return; }
          make.disabled = true;
          try {
            await api.createFolder(node, rootSel ? rootSel.value : roots[0], v);
            toast('폴더를 만들었어요');
            loadFolders();
          } catch (ex) {
            err.textContent = errorText(ex, '폴더를 만들지 못했어요');
            err.hidden = false;
            make.disabled = false;
          }
        },
      }, name, rootSel ? selectWrap(rootSel) : null, err, h('div', { class: 'row-btns' }, button('취소', { variant: 'ghost', small: true, onClick: closeForm }), make)));
      name.focus();
    };
    const closeForm = () => fill(wrap, h('button', { type: 'button', class: 'list-row tappable', onclick: open },
      icon('plus', 20, 'lr-lead'), h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '새 폴더' }))));
    closeForm();
    return wrap;
  }

  function renderProfiles() {
    if (!profiles || profiles.length < 2) { fill(profileSec); return; }
    fill(profileSec, sectionHeader('프로필'), group(profiles.map((pr) => kvRow(pr.display_name || pr.name,
      [pr.model, Number.isFinite(pr.skill_count) ? `스킬 ${pr.skill_count}개` : null].filter(Boolean).join(' · ')))));
  }

  function renderActions() {
    const info = n();
    const kids = [];
    if (info?.online && nodeSupportsFeatures(node)) {
      kids.push(group([listRow({ title: '로그 보기', lead: icon('terminal', 20, 'lr-lead'), href: `#/settings/nodes/${enc(node)}/logs` })]));
    }
    const btns = [];
    if (info?.dashboard_url) {
      btns.push(h('a', { class: 'btn btn-secondary btn-block', href: info.dashboard_url, target: '_blank', rel: 'noopener' }, icon('external', 18), h('span', { text: 'Hermes 대시보드 열기' })));
    }
    if (info && !info.online) {
      btns.push(button('이 노드 잊기', {
        variant: 'danger-outline', cls: 'btn-block',
        onClick: async () => {
          const ok = await confirmDialog({ title: '노드를 목록에서 지울까요?', body: '다시 연결하면 다시 나타나요.', ok: '지우기', danger: true });
          if (!ok) return;
          try {
            await api.forgetNode(node);
            toast('노드를 지웠어요');
            navigate('#/settings', { replace: true });
          } catch (err) { toastError(err, '지우지 못했어요'); }
        },
      }));
    }
    if (btns.length) kids.push(h('div', { class: 'btn-stack' }, btns));
    fill(actionSec, ...kids);
  }

  async function loadStatus() {
    if (!n()?.online || !nodeSupportsFeatures(node)) return;
    try { status = await api.rest(node, 'GET', '/api/status'); } catch { status = null; }
    if (alive) renderStatus();
  }
  async function loadStats() {
    if (!n()?.online || !nodeSupportsFeatures(node) || document.visibilityState !== 'visible') return;
    try { stats = await api.rest(node, 'GET', '/api/system/stats'); statsErr = null; } catch (err) { statsErr = err; }
    if (alive) renderSystem();
  }
  async function loadMode() {
    if (!n()?.online || !nodeSupportsFeatures(node)) return;
    try { const r = await api.rpc(node, 'config.get', { key: 'approvals.mode' }); mode = r?.value || 'smart'; } catch { mode = 'smart'; }
    if (alive) renderMode();
  }
  async function loadFolders() {
    if (!n()?.online) return;
    try { folders = await api.folders(node); } catch (err) { folders = err; }
    if (alive) renderFolders();
  }
  async function loadProfiles() {
    if (!n()?.online || !nodeSupportsFeatures(node)) return;
    try {
      const r = await api.rest(node, 'GET', '/api/profiles');
      profiles = Array.isArray(r) ? r : (r?.profiles || []);
    } catch { profiles = null; }
    if (alive) renderProfiles();
  }

  add(p.body, statusSec, systemSec, gpuSec, modeSec, folderSec, profileSec, actionSec);
  const renderAll = () => { renderStatus(); renderSystem(); renderGpus(); renderMode(); renderFolders(); renderProfiles(); renderActions(); };
  renderAll();
  loadStatus(); loadStats(); loadMode(); loadFolders(); loadProfiles();
  const poll = setInterval(loadStats, 10000);
  let wasOnline = !!n()?.online;
  const off = bus.on('nodes', () => {
    const on = !!n()?.online;
    renderStatus(); renderGpus(); renderActions();
    if (on !== wasOnline) {
      wasOnline = on;
      renderAll();
      if (on) { loadStatus(); loadStats(); loadMode(); loadFolders(); loadProfiles(); }
    }
  });
  return { destroy: () => { alive = false; clearInterval(poll); off(); } };
}
