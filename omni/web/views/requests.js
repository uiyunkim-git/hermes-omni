// #/requests — every open approval/clarify/sudo/secret request across all nodes, answerable inline.

import { api } from '../api.js';
import { bus, findNode } from '../store.js';
import { h, clear, loading, emptyState, debounce } from '../util.js';
import { requestCard } from '../components/requests.js';

function sessionLabel(node, sid) {
  const n = findNode(node);
  const p = n?.projects?.find((x) => x.canonical?.stored_id === sid);
  const name = n?.display_name || node;
  return p ? `${name} · ${p.name}` : `${name} · ${sid}`;
}

export default function requestsView(main, ctx) {
  ctx.setTitle('Requests');
  let alive = true;
  let loaded = false;
  const answered = new Set();
  const list = h('div', { class: 'list' });
  main.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', { class: 'h1', text: 'Requests' })),
    h('p', { class: 'muted small', text: 'Approvals, questions and passwords your agents are waiting for.' }),
    list));

  async function load() {
    if (!loaded) clear(list).append(loading());
    try {
      const res = await api.requests();
      if (!alive) return;
      loaded = true;
      const items = (Array.isArray(res.requests) ? res.requests : []).filter((x) => x?.request?.request_id && !answered.has(x.request.request_id));
      render(items);
    } catch (err) {
      if (!alive) return;
      clear(list).append(h('div', { class: 'empty' }, h('p', { class: 'warn-text', text: err.message }),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: load }, 'Retry')));
    }
  }

  function render(items) {
    // Keep cards the user is typing into: only rebuild when the set of request ids changed.
    const ids = items.map((x) => x.request.request_id).join(',');
    if (list.dataset.ids === ids && list.querySelector('.req-card')) return;
    list.dataset.ids = ids;
    clear(list);
    if (!items.length) {
      list.append(emptyState('Nothing waiting', 'When an agent needs approval or an answer, it shows up here.'));
      return;
    }
    for (const it of items) {
      list.append(requestCard(it, {
        context: true,
        sessionTitle: sessionLabel(it.node, it.stored_id),
        onAnswered: (id) => { answered.add(id); setTimeout(reload, 1200); },
      }));
    }
  }

  const reload = debounce(load, 300);
  load();
  const offs = [
    bus.on('requests-count', reload),
    bus.on('ws:session.request', reload),
    bus.on('ws:session.request_cancel', reload),
    bus.on('ws:open', reload),
  ];
  return () => { alive = false; reload.cancel(); offs.forEach((o) => o()); };
}
