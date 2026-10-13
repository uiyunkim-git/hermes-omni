// Memory (spec §3.6 메모리; also the session info 메모리 tab): entries of MEMORY.md (메모리) and
// USER.md (사용자 프로필) from the learning graph; edit/delete through /api/learning/node.
// Ids carry a content fingerprint and go stale after any write, so we refetch after each one.

import { api, errorText } from '../../api.js';
import { state, onlineNodes, bus } from '../../store.js';
import { h, fill, add } from '../../util.js';
import { loadingLine, errorLine, emptyState, button } from '../../ui/controls.js';
import { createSheet } from '../../ui/sheet.js';
import { confirmDialog } from '../../ui/dialog.js';
import { toast, toastError } from '../../ui/toast.js';
import { nodeChips } from './common.js';

/** @param {{node?:string|null, hideNodeSelector?:boolean}} o */
export function memoryPanel(o = {}) {
  let node = o.node || onlineNodes()[0]?.node_id || state.nodes[0]?.node_id || null;
  let entries = null;
  let err = null;
  let seq = 0;

  const chips = h('div', { class: 'chip-row' });
  const listEl = h('div', { class: 'mem-list' });
  const el = h('div', { class: 'panel' },
    o.hideNodeSelector ? null : chips,
    h('p', { class: 'caption', text: "새 기억은 대화에서 '기억해 줘'라고 말하면 추가돼요" }),
    listEl);

  function renderChips() {
    if (o.hideNodeSelector) return;
    fill(chips, nodeChips(node, (n) => { node = n; load(); renderChips(); }));
  }

  /** Graph → [{id, source:'memory'|'profile', text}] */
  function parse(graph) {
    const cards = Array.isArray(graph?.memory) ? graph.memory : [];
    const byFp = new Map(cards.map((c) => [c.fingerprint, c]));
    const nodes = (graph?.nodes || []).filter((n) => n.kind === 'memory' || String(n.id).startsWith('memory:'));
    const out = [];
    for (const n of nodes) {
      const parts = String(n.id).split(':');
      const source = n.memorySource || parts[1] || 'memory';
      const card = byFp.get(parts[3]) || null;
      out.push({ id: n.id, source, text: card?.body || n.label || '' });
    }
    if (!nodes.length) {
      cards.forEach((c, i) => out.push({ id: `memory:${c.source}:${i}:${c.fingerprint}`, source: c.source, text: c.body || c.title || '' }));
    }
    return out;
  }

  function renderList() {
    if (err) { fill(listEl, errorLine(errorText(err, '메모리를 불러오지 못했어요'), load)); return; }
    if (!entries) { fill(listEl, loadingLine()); return; }
    if (!entries.length) { fill(listEl, emptyState({ title: '저장된 기억이 없어요' })); return; }
    const kids = [];
    for (const [src, title] of [['memory', '메모리'], ['profile', '사용자 프로필']]) {
      const rows = entries.filter((e) => e.source === src);
      if (!rows.length) continue;
      kids.push(h('div', { class: 'list-sh' }, h('h2', { text: title })));
      for (const e of rows) {
        kids.push(h('button', { type: 'button', class: 'mem-row', onclick: () => edit(e) }, h('span', { class: 'mem-text', text: e.text })));
      }
    }
    fill(listEl, ...kids);
  }

  async function edit(e) {
    const ta = h('textarea', { class: 'input mem-edit', rows: 8, 'aria-label': '기억 내용' });
    const save = button('저장', { variant: 'primary' });
    const del = button('삭제', { variant: 'danger-outline' });
    const sheet = createSheet({ title: e.source === 'profile' ? '사용자 프로필' : '메모리', desktop: 'dialog', width: 560, footer: h('div', { class: 'row-btns spread' }, del, save) });
    add(sheet.body, ta);
    ta.value = e.text;
    try {
      const res = await api.rest(node, 'GET', '/api/learning/node', { query: { id: e.id } });
      if (typeof res?.content === 'string' && !sheet.closed) ta.value = res.content;
    } catch { /* keep the list text */ }
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api.rest(node, 'PUT', '/api/learning/node', { body: { id: e.id, content: ta.value } });
        sheet.close();
        toast('저장했어요');
        load();
      } catch (ex) {
        save.disabled = false;
        toastError(ex, '저장하지 못했어요');
        if (/stale/i.test(ex.message)) load();
      }
    });
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '이 기억을 지울까요?', ok: '삭제', danger: true });
      if (!ok) return;
      try {
        await api.rest(node, 'DELETE', '/api/learning/node', { body: { id: e.id } });
        sheet.close();
        toast('삭제했어요');
        load();
      } catch (ex) {
        toastError(ex, '삭제하지 못했어요');
      }
    });
  }

  async function load() {
    const my = ++seq;
    entries = null;
    err = null;
    renderList();
    if (!node) { fill(listEl, emptyState({ title: '온라인 노드가 없어요' })); return; }
    try {
      const res = await api.rest(node, 'GET', '/api/learning/graph');
      if (my !== seq) return;
      entries = parse(res);
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
