// Log viewer (spec §3.6): file select, level chips, search, auto refresh (5 s) and line count.
// Mono, no wrap, newest at the bottom; follows the tail while scrolled to the bottom.

import { api, errorText } from '../../api.js';
import { findNode } from '../../store.js';
import { h, debounce, enc, fill, add } from '../../util.js';
import { toggle, iconButton, errorLine, selectWrap } from '../../ui/controls.js';
import { page } from './common.js';

const FILES = [['agent', 'agent'], ['errors', 'errors'], ['gateway', 'gateway'], ['mcp', 'mcp']];
const LEVELS = [['', '전체'], ['WARNING', '경고'], ['ERROR', '오류']];

/** @param {HTMLElement} root @param {{node:string}} o */
export function mountLogs(root, { node }) {
  const p = page({ title: '로그', subtitle: findNode(node)?.display_name || node, backTo: `#/settings/nodes/${enc(node)}` });
  fill(root, p.el);
  let file = 'agent';
  let level = '';
  let search = '';
  let lines = 200;
  let auto = false;
  let seq = 0;

  const fileSel = h('select', { class: 'input sm', 'aria-label': '로그 파일' }, FILES.map(([v, l]) => h('option', { value: v, text: l })));
  fileSel.addEventListener('change', () => { file = fileSel.value; load(true); });
  const levelChips = h('div', { class: 'chip-row tight' });
  const renderLevels = () => fill(levelChips, ...LEVELS.map(([v, l]) => h('button', {
    type: 'button', class: `chip${level === v ? ' on' : ''}`, 'aria-pressed': level === v ? 'true' : 'false', text: l,
    onclick: () => { level = v; renderLevels(); load(true); },
  })));
  const searchIn = h('input', { class: 'input sm', type: 'search', placeholder: '검색', 'aria-label': '로그 검색' });
  const doSearch = debounce(() => { search = searchIn.value.trim(); load(true); }, 400);
  searchIn.addEventListener('input', doSearch);
  const lineSel = h('select', { class: 'input sm', 'aria-label': '줄 수' }, [100, 200, 500, 1000].map((n) => h('option', { value: String(n), text: `${n}줄`, selected: n === lines })));
  lineSel.addEventListener('change', () => { lines = Number(lineSel.value); load(true); });
  const autoSw = toggle({ label: '자동 새로고침', onChange: (v) => { auto = v; } });
  const pre = h('pre', { class: 'log-pre', tabindex: '0', 'aria-label': '로그' });
  const status = h('div', { class: 'log-status' });

  add(p.body,
    h('div', { class: 'log-controls' },
      h('div', { class: 'log-ctl-row' }, selectWrap(fileSel), selectWrap(lineSel), iconButton('refresh', '새로 고침', () => load(true))),
      h('div', { class: 'log-ctl-row' }, levelChips, h('label', { class: 'log-auto' }, h('span', { text: '자동 새로고침' }), autoSw)),
      searchIn),
    status,
    h('div', { class: 'log-box' }, pre));
  renderLevels();

  async function load(scroll = false) {
    const my = ++seq;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    try {
      const res = await api.rest(node, 'GET', '/api/logs', { query: { file, lines, level: level || undefined, search: search || undefined } });
      if (my !== seq) return;
      const ls = Array.isArray(res?.lines) ? res.lines : [];
      pre.textContent = ls.map((l) => String(l).replace(/\n$/, '')).join('\n') || '(비어 있음)';
      fill(status);
      if (scroll || atBottom) pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      if (my !== seq) return;
      fill(status, errorLine(errorText(err, '로그를 불러오지 못했어요'), () => load(true)));
    }
  }

  const timer = setInterval(() => { if (auto && document.visibilityState === 'visible') load(false); }, 5000);
  load(true);
  return { destroy: () => clearInterval(timer) };
}
