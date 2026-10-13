// Session info sheet (spec §3.5): 정보 · 파일 · 스킬 · 메모리. Bottom sheet (92vh) on mobile,
// a 400px right drawer on desktop. Tabs update the hash with replace.

import { api } from '../api.js';
import { bus, getSession, findNode, nodeSupportsFeatures, rowTitle, sourceLabel } from '../store.js';
import { navigate } from '../router.js';
import { h, copyText, download, fmtDateTime, fmtInt, fmtTokens, sessionHref, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';
import { createSheet } from '../ui/sheet.js';
import { segmented, toggle, progressBar, button, loadingLine, kvRow, spinner } from '../ui/controls.js';
import { toast, toastError } from '../ui/toast.js';
import { getMeta, setMeta, active } from '../chat/active.js';
import { shortModel, effortKo } from '../chat/composer.js';
import { openModelSheet } from '../chat/modelsheet.js';
import { createFileBrowser } from './files.js';
import { skillsPanel } from './settings/skills.js';
import { memoryPanel } from './settings/memory.js';

const APPROVAL_KO = { manual: '수동', smart: '스마트', off: '끔' };
const TABS = [
  { value: 'info', label: '정보' }, { value: 'files', label: '파일' },
  { value: 'skills', label: '스킬' }, { value: 'memory', label: '메모리' },
];

/**
 * @param {{node:string, sid:string, tab:string, section?:string|null, onRequestClose:()=>void}} o
 * @returns {{sheet, setTab:(tab:string, section?:string|null)=>void, close:()=>void}}
 */
export function openInfoSheet(o) {
  const { node, sid } = o;
  const key = `${node}#${sid}`;
  const features = nodeSupportsFeatures(node);
  const tabs = features ? TABS : TABS.slice(0, 1);
  let tab = tabs.some((t) => t.value === o.tab) ? o.tab : 'info';
  const seg = segmented({
    label: '세션 정보 탭', options: tabs, value: tab,
    onChange: (v) => {
      navigate(`${sessionHref(node, sid)}/info${v === 'info' ? '' : `/${v}`}`, { replace: true });
    },
  });
  const sheet = createSheet({
    title: rowTitle(getSession(node, sid)), desktop: 'drawer', tall: true, onRequestClose: o.onRequestClose,
    cls: 'info-sheet', layer: false,
  });
  sheet.head.after(h('div', { class: 'info-tabs' }, seg));
  const panes = new Map();
  const destroyers = [];

  function paneFor(t) {
    if (panes.has(t)) return panes.get(t);
    let el;
    if (t === 'info') el = infoPane();
    else if (t === 'files') {
      const row = getSession(node, sid);
      const fb = createFileBrowser({
        node, path: row?.folder?.path || row?.cwd || null,
        caption: row?.folder?.path || row?.cwd ? null : '폴더가 없는 세션이라 작업 폴더를 보여줘요',
        onAttach: () => o.onRequestClose(),
      });
      el = fb.el;
    } else if (t === 'skills') {
      const p = skillsPanel({ node, hideNodeSelector: true });
      destroyers.push(p.destroy);
      el = p.el;
    } else {
      const p = memoryPanel({ node, hideNodeSelector: true });
      destroyers.push(p.destroy);
      el = p.el;
    }
    const wrap = h('div', { class: 'info-pane', dataset: { tab: t } }, el);
    panes.set(t, wrap);
    return wrap;
  }

  function show(t, section) {
    tab = t;
    seg.set(t);
    const pane = paneFor(t);
    fill(sheet.body, pane);
    sheet.body.scrollTop = 0;
    if (section) requestAnimationFrame(() => pane.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'start' }));
  }

  // ---------------------------------------------------------------- 정보 tab
  function infoPane() {
    const el = h('div', { class: 'info' });
    const ctxBody = h('div');
    const usageBody = h('div');
    const modelBody = h('div');
    const permBody = h('div');
    const toolsBody = h('div');
    const sessBody = h('div');
    let caps = null;
    let breakdown = null;
    let toolsets = null;
    let toolsOpen = false;

    const sec = (name, title, body) => h('section', { class: 'info-sec', dataset: { section: name } }, h('h3', { class: 'info-h', text: title }), body);
    if (features) {
      add(el, sec('model', '모델', modelBody), sec('context', '컨텍스트', ctxBody), sec('usage', '사용량', usageBody),
        sec('perm', '권한', permBody), sec('tools', '도구', toolsBody));
    }
    add(el, sec('session', '세션', sessBody));
    const n = findNode(node);
    add(el, h('div', { class: 'info-actions' },
      button('내보내기 (JSON)', { variant: 'secondary', icon: 'download', cls: 'btn-block', onClick: () => download(api.exportUrl(node, sid), `${rowTitle(getSession(node, sid))}.json`) }),
      n?.dashboard_url ? h('a', { class: 'btn btn-secondary btn-block', href: n.dashboard_url, target: '_blank', rel: 'noopener' }, icon('external', 18), h('span', { text: 'Hermes 대시보드 열기' })) : null,
      h('button', { type: 'button', class: 'btn btn-text danger', text: '세션 삭제', onclick: () => deleteSession() })));

    function openModel(focus) {
      const m = getMeta(key);
      if (active.chat?.key === key && !focus) { active.chat.openModel(); return; }
      openModelSheet({ node, sid, meta: m, running: !!getSession(node, sid)?.running, focus, onMeta: (p) => setMeta(key, p) });
    }

    function renderModel() {
      const m = getMeta(key) || {};
      const c = caps?.[m.model] || null;
      fill(modelBody,
        h('button', { type: 'button', class: 'list-row tappable', onclick: () => openModel() },
          h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '모델' })),
          h('span', { class: 'lr-value' }, h('span', { text: shortModel(m.model) || '–' }), providerLabel(m.provider) ? h('span', { class: 'lr-faint', text: ` · ${providerLabel(m.provider)}` }) : null),
          icon('chevron-right', 18, 'lr-chev')),
        c?.reasoning === false ? null : h('button', { type: 'button', class: 'list-row tappable', onclick: () => openModel('reasoning') },
          h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '추론 강도' })),
          h('span', { class: 'lr-value', text: effortKo(m.reasoning_effort) || '기본' }),
          icon('chevron-right', 18, 'lr-chev')),
        c?.fast ? h('div', { class: 'list-row' },
          h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '빠른 모드' }), h('span', { class: 'lr-sub', text: '더 빠르지만 비쌀 수 있어요' })),
          toggle({
            checked: !!m.fast, label: '빠른 모드',
            onChange: async (on, input) => {
              try { await api.rpc(node, 'config.set', { key: 'fast', value: on ? 'on' : 'off' }, sid); setMeta(key, { fast: on }); } catch (err) { input.checked = !on; toastError(err, '바꾸지 못했어요'); }
            },
          })) : null);
    }

    function renderContext() {
      const m = getMeta(key) || {};
      const ctx = m.context || {};
      // One source for the total and its parts: the breakdown call when it answered.
      const fromBreakdown = Number.isFinite(breakdown?.context_used) && breakdown.context_max > 0;
      const used = fromBreakdown ? breakdown.context_used : ctx.used;
      const max = fromBreakdown ? breakdown.context_max : ctx.max;
      const pct = fromBreakdown ? (used / max) * 100 : Number.isFinite(ctx.percent) ? ctx.percent : (max ? (used / max) * 100 : null);
      const running = !!getSession(node, sid)?.running;
      const kids = [];
      if (Number.isFinite(pct) && max) {
        kids.push(h('div', { class: 'ctx-sum' },
          progressBar(pct, { tone: 'auto', thick: true }),
          h('p', { class: 'ctx-line', text: `${fmtTokens(used)} / ${fmtTokens(max)} 토큰 · ${Math.round(pct)}%` })));
      } else kids.push(h('p', { class: 'muted-line', text: '첫 응답 후에 보여요' }));
      const cats = (breakdown?.categories || []).filter((c) => Number(c.tokens) > 0);
      if (cats.length) {
        // Hermes measures the total from the provider but estimates each part locally, so the
        // parts rarely add up. Scale them to the total and say they are estimates.
        const sum = cats.reduce((s, c) => s + Number(c.tokens), 0);
        const raw = Number.isFinite(used) && used > 0 && sum > 0 ? used / sum : 1;
        const k = Math.abs(raw - 1) < 0.02 ? 1 : raw;
        kids.push(h('div', { class: 'ctx-list' }, cats.map((c) => h('div', { class: 'ctx-item' },
          h('span', { class: 'ctx-sw', style: { background: c.color || 'var(--text-3)' } }),
          h('span', { class: 'ctx-label', text: CATEGORY_KO[c.id] || c.label || c.id }),
          h('span', { class: 'ctx-tok', text: `${k !== 1 ? '약 ' : ''}${fmtTokens(Number(c.tokens) * k)}` })))));
        if (k !== 1) kids.push(h('p', { class: 'caption info-caption', text: '항목별 크기는 추정치를 전체 사용량에 맞춘 값이에요' }));
      } else if (breakdown === null) kids.push(loadingLine('구성 불러오는 중…'));
      const canCompress = Number.isFinite(pct) && pct >= 50 && !running;
      const btn = button('컨텍스트 압축', {
        variant: 'secondary', disabled: !canCompress, small: true,
        title: running ? '작업 중에는 압축할 수 없어요' : (!Number.isFinite(pct) || pct < 50) ? '50% 이상일 때 쓸 수 있어요' : undefined,
        onClick: async () => {
          btn.disabled = true;
          fill(btn, spinner(12), h('span', { text: '압축 중…' }));
          if (active.chat?.key === key) await active.chat.compress();
          else {
            try { await api.rpc(node, 'session.compress', {}, sid, { timeout: 70000 }); toast('압축했어요'); } catch (err) { toastError(err, '압축하지 못했어요'); }
          }
          loadBreakdown();
        },
      });
      kids.push(h('div', { class: 'ctx-actions' }, btn, running ? h('span', { class: 'caption', text: '작업 중에는 압축할 수 없어요' }) : null));
      fill(ctxBody, ...kids);
    }

    function renderUsage() {
      const u = getMeta(key)?.usage || {};
      // Hermes counts usage per running agent: after a node restart the counters start at zero
      // even though the session has turns. "0 / 0" would read as "free"; say what it means.
      if (!(u.input > 0 || u.output > 0 || u.calls > 0)) {
        const had = (getSession(node, sid)?.message_count || 0) > 0;
        fill(usageBody,
          kvRow('입력 / 출력 토큰', '—'), kvRow('모델 호출', '—'),
          h('p', { class: 'caption info-caption', text: had ? '노드가 다시 시작된 뒤로 집계된 사용량이 없어요' : '아직 사용량이 없어요' }));
        return;
      }
      const rows = [];
      rows.push(kvRow('입력 / 출력 토큰', `${fmtInt(u.input || 0)} / ${fmtInt(u.output || 0)}`));
      if (Number.isFinite(u.cache_hit_pct)) rows.push(kvRow('캐시 적중', `${Math.round(u.cache_hit_pct)}%`));
      if (Number.isFinite(u.cost_usd) && u.cost_usd > 0 && u.cost_status && u.cost_status !== 'unknown') rows.push(kvRow('예상 비용', `$${u.cost_usd.toFixed(2)}`));
      rows.push(kvRow('모델 호출', `${fmtInt(u.calls || 0)}회`));
      fill(usageBody, ...rows);
    }

    function renderPerm() {
      const m = getMeta(key) || {};
      const sw = toggle({
        checked: !!m.yolo, label: '자동 승인 (이 세션)',
        onChange: async (on, input) => {
          input.checked = !on;   // apply only after confirmation/success
          let ok = false;
          if (active.chat?.key === key) ok = await active.chat.setYolo(on);
          else {
            try { await api.rpc(node, 'config.set', { key: 'yolo', value: on ? 'on' : 'off' }, sid); setMeta(key, { yolo: on }); ok = true; } catch (err) { toastError(err, '바꾸지 못했어요'); }
          }
          if (ok) input.checked = on;
        },
      });
      fill(permBody, h('div', { class: 'list-row' },
        h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '자동 승인 (이 세션)' }),
          h('span', { class: 'lr-sub', text: `노드 기본값: ${APPROVAL_KO[m.approval_mode] || m.approval_mode || '알 수 없음'}` })),
        sw));
    }

    function renderTools() {
      const on = (toolsets || []).filter((t) => t.enabled !== false);
      const head = h('button', {
        type: 'button', class: 'list-row tappable', 'aria-expanded': toolsOpen ? 'true' : 'false',
        onclick: () => { toolsOpen = !toolsOpen; if (toolsOpen && !toolsets) loadTools(); renderTools(); },
      },
      h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: toolsets ? `도구 모음 ${on.length}개 사용 중` : '도구 모음' })),
      icon(toolsOpen ? 'chevron-down' : 'chevron-right', 18, 'lr-chev'));
      const kids = [head];
      if (toolsOpen) {
        if (!toolsets) kids.push(loadingLine());
        else {
          kids.push(h('div', { class: 'toolset-list' }, toolsets.map((t) => h('div', { class: 'toolset-row' },
            h('span', { class: 'ts-name', text: t.name }),
            h('span', { class: 'ts-count', text: `${t.tool_count ?? (t.tools || []).length}개` }),
            t.enabled !== false ? icon('check', 16, 'ts-on') : h('span', { class: 'ts-off', text: '꺼짐' })))));
          kids.push(h('p', { class: 'caption', text: '변경은 설정 › 노드에서 해요' }));
        }
      }
      fill(toolsBody, ...kids);
    }

    function renderSession() {
      const r = getSession(node, sid) || {};
      const path = r.folder?.path || r.cwd || null;
      fill(sessBody,
        kvRow('주소', h('span', { class: 'kv-copy' }, h('span', { class: 'mono', text: key }),
          h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': '주소 복사', onclick: async () => toast((await copyText(key)) ? '복사했어요' : key) }, icon('copy', 16)))),
        kvRow('세션 ID', sid, { mono: true }),
        path ? h('button', { type: 'button', class: 'kv-row tappable', onclick: () => navigate(`${sessionHref(node, sid)}/info/files`, { replace: true }) },
          h('span', { class: 'kv-k', text: '폴더' }), h('span', { class: 'kv-v mono small', text: path })) : kvRow('폴더', '폴더 없음'),
        kvRow('출처', sourceLabel(r.source) || (r.source ? String(r.source).toUpperCase() : '–')),
        kvRow('시작', fmtDateTime(r.started_at) || '–'),
        kvRow('최근 활동', fmtDateTime(r.last_active) || '–'),
        kvRow('메시지', Number.isFinite(r.message_count) ? `${fmtInt(r.message_count)}개` : '–'));
    }

    async function loadBreakdown() {
      try {
        breakdown = await api.rpc(node, 'session.context_breakdown', {}, sid);
        if (Number.isFinite(breakdown?.context_used) && breakdown.context_max) {
          setMeta(key, { context: { used: breakdown.context_used, max: breakdown.context_max, percent: breakdown.context_percent ?? (breakdown.context_used / breakdown.context_max) * 100 } });
        }
      } catch { breakdown = { categories: [] }; }
      renderContext();
    }
    async function loadTools() {
      try {
        const res = await api.rpc(node, 'tools.list', {}, sid);
        toolsets = res?.toolsets || [];
      } catch (err) {
        toolsets = [];
        toastError(err, '도구 목록을 불러오지 못했어요');
      }
      renderTools();
    }
    async function loadCaps() {
      try {
        const res = await api.rpc(node, 'model.options', {}, sid);
        caps = {};
        for (const p of res?.providers || []) Object.assign(caps, p.capabilities || {});
        if (res?.model && !getMeta(key)?.model) setMeta(key, { model: res.model, provider: res.provider });
      } catch { caps = {}; }
      renderModel();
    }
    async function loadUsage() {
      try {
        const u = await api.rpc(node, 'session.usage', {}, sid);
        if (u && typeof u === 'object') setMeta(key, { usage: { ...(getMeta(key)?.usage || {}), ...u } });
      } catch { /* meta.usage stays */ }
    }

    const renderAll = () => {
      if (features) { renderModel(); renderContext(); renderUsage(); renderPerm(); renderTools(); }
      renderSession();
    };
    renderAll();
    if (features) { loadCaps(); loadBreakdown(); loadUsage(); }
    destroyers.push(bus.on('meta', (e) => { if (e.key === key && features) { renderModel(); renderContext(); renderUsage(); renderPerm(); } }));
    destroyers.push(bus.on('sessions', () => { renderSession(); sheet.setTitle(rowTitle(getSession(node, sid))); }));
    return el;
  }

  async function deleteSession() {
    if (active.chat?.key === key) { active.chat.remove(); return; }
    toast('채팅 화면에서 삭제할 수 있어요');
  }

  show(tab, o.section);
  const prev = sheet.onClose;
  sheet.onClose = () => { destroyers.forEach((d) => { try { d(); } catch { /* ignore */ } }); prev?.(); };
  return {
    sheet,
    setTab: (t, section) => { if (tabs.some((x) => x.value === t)) show(t, section); else show('info', section); },
    close: () => sheet.close(),
  };
}

const CATEGORY_KO = {
  system_prompt: '시스템 프롬프트', tool_definitions: '도구 정의', rules: '규칙', skills: '스킬', mcp: 'MCP',
  subagent_definitions: '하위 에이전트', memory: '메모리', conversation: '대화',
};


// Provider slugs → display names. Hermes' "custom" (an OpenAI-compatible endpoint from the
// config) and "auto" say nothing useful next to the model name, so they are not shown.
const PROVIDER_NAMES = {
  anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', google: 'Google', gemini: 'Google',
  nous: 'Nous', xai: 'xAI', deepseek: 'DeepSeek', mistral: 'Mistral', groq: 'Groq', ollama: 'Ollama',
  zai: 'Z.ai', 'z-ai': 'Z.ai', moonshot: 'Moonshot', kimi: 'Moonshot', bedrock: 'Bedrock', azure: 'Azure',
  copilot: 'Copilot', 'openai-codex': 'Codex', codex: 'Codex',
};
function providerLabel(p) {
  const s = String(p || '').trim();
  if (!s || s === 'custom' || s === 'auto') return '';
  return PROVIDER_NAMES[s.toLowerCase()] || s;
}
