// Skills (spec §3.6 스킬; also the session info 스킬 tab): per-node list with search, enable
// toggles (optimistic, reverted on error) and a read-only SKILL.md viewer.

import { api, errorText } from '../../api.js';
import { state, onlineNodes, bus } from '../../store.js';
import { h, fill, add } from '../../util.js';
import { loadingLine, errorLine, toggle, emptyState } from '../../ui/controls.js';
import { createSheet } from '../../ui/sheet.js';
import { toast } from '../../ui/toast.js';
import { markdownBlock } from '../../chat/markdown.js';
import { nodeChips } from './common.js';

const PROVENANCE = { bundled: '기본', hub: '허브', agent: '에이전트', user: '사용자', local: '사용자' };

/** @param {{node?:string|null, hideNodeSelector?:boolean, onNode?:(n:string)=>void}} o */
export function skillsPanel(o = {}) {
  let node = o.node || onlineNodes()[0]?.node_id || state.nodes[0]?.node_id || null;
  let skills = null;
  let err = null;
  let q = '';
  let seq = 0;

  const chips = h('div', { class: 'chip-row' });
  const search = h('input', { class: 'input search-box', type: 'search', placeholder: '스킬 검색', 'aria-label': '스킬 검색', autocomplete: 'off' });
  search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); renderList(); });
  const listEl = h('div', { class: 'skill-list' });
  const el = h('div', { class: 'panel' },
    o.hideNodeSelector ? null : chips,
    h('p', { class: 'caption', text: '켜고 끈 설정은 이 노드의 새 대화부터 적용돼요' }),
    search, listEl);

  function renderChips() {
    if (o.hideNodeSelector) return;
    fill(chips, nodeChips(node, (n) => { node = n; o.onNode?.(n); load(); renderChips(); }));
  }

  function renderList() {
    if (err) { fill(listEl, errorLine(errorText(err, '스킬을 불러오지 못했어요'), load)); return; }
    if (!skills) { fill(listEl, loadingLine()); return; }
    const rows = skills.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q));
    if (!rows.length) { fill(listEl, emptyState({ title: q ? '일치하는 스킬이 없어요' : '스킬이 없어요' })); return; }
    fill(listEl, ...rows.map(skillRow));
  }

  function skillRow(s) {
    const sw = toggle({
      checked: s.enabled !== false, label: `${s.name} 사용`,
      onChange: async (on, input) => {
        s.enabled = on;
        try {
          await api.rest(node, 'PUT', '/api/skills/toggle', { body: { name: s.name, enabled: on } });
        } catch {
          s.enabled = !on;
          input.checked = !on;
          toast('바꾸지 못했어요', { tone: 'error' });
        }
      },
    });
    const meta = [s.category, PROVENANCE[s.provenance] || s.provenance].filter(Boolean).join(' · ');
    return h('div', { class: 'skill-row' },
      h('button', { type: 'button', class: 'skill-main', onclick: () => view(s) },
        h('span', { class: 'lr-title', text: s.name }),
        s.description ? h('span', { class: 'skill-desc', text: s.description }) : null,
        meta ? h('span', { class: 'lr-sub', text: meta }) : null),
      sw);
  }

  async function view(s) {
    const sheet = createSheet({ title: s.name, desktop: 'dialog', width: 720, tall: true });
    add(sheet.body, loadingLine());
    try {
      const res = await api.rest(node, 'GET', '/api/skills/content', { query: { name: s.name } });
      fill(sheet.body, markdownBlock(String(res?.content || '').replace(/^---\n[\s\S]*?\n---\n/, ''), 'skill-md'));
    } catch (ex) {
      fill(sheet.body, errorLine(errorText(ex, 'SKILL.md를 불러오지 못했어요')));
    }
  }

  async function load() {
    const my = ++seq;
    skills = null;
    err = null;
    renderList();
    if (!node) { fill(listEl, emptyState({ title: '온라인 노드가 없어요' })); return; }
    try {
      const res = await api.rest(node, 'GET', '/api/skills');
      if (my !== seq) return;
      skills = Array.isArray(res) ? res : (res?.skills || []);
    } catch (ex) {
      if (my !== seq) return;
      err = ex;
    }
    renderList();
  }

  const off = bus.on('nodes', renderChips);
  renderChips();
  load();
  return { el, destroy: off };
}
