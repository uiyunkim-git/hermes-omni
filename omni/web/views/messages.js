// #/messages[?address=] — agent-to-agent delivery log (GET /api/deliveries, live "delivery" pushes),
// address filter, expandable message/reply, and a form to send a message as "human" (POST /api/send).

import { api } from '../api.js';
import { bus, state } from '../store.js';
import { h, clear, relTime, absTime, sessionHref, loading, emptyState, truncate, debounce } from '../util.js';
import { markdownBlock } from '../components/markdown.js';
import { toast, toastError } from '../components/toast.js';

const STATUS_CLASS = {
  queued: 'st-queued', dispatched: 'st-running', done: 'st-done', error: 'st-error', cancelled: 'st-none',
};

function knownAddresses() {
  const out = [];
  for (const n of state.nodes) for (const p of n.projects || []) if (p.address) out.push(p.address);
  return out.sort();
}

/**
 * Client-side mirror of the hub's address filter (Store.list_deliveries) for live pushes:
 * a bare "node" matches from_node/to_node; "n/p", "n#sid" and "n/p#sid" match the address
 * exactly or as a prefix of "<addr>#…" (case-insensitive, like SQLite LIKE); a "#sid" filter
 * also matches from_stored/to_stored.
 */
function matches(d, addr) {
  if (!addr) return true;
  if (!addr.includes('/') && !addr.includes('#')) return d.from_node === addr || d.to_node === addr;
  const prefix = `${addr}#`.toLowerCase();
  const addrHit = [d.from_addr, d.to_addr].some((x) => typeof x === 'string'
    && (x === addr || x.toLowerCase().startsWith(prefix)));
  if (addrHit) return true;
  const sid = addr.includes('#') ? addr.slice(addr.indexOf('#') + 1) : '';
  return sid !== '' && (d.from_stored === sid || d.to_stored === sid);
}

export default function messagesView(main, ctx) {
  ctx.setTitle('Messages');
  let address = ctx.query.get('address') || '';
  let deliveries = [];
  let loaded = false;
  let alive = true;
  const open = new Set();

  const listId = 'addr-options';
  const datalist = h('datalist', { id: listId }, knownAddresses().map((a) => h('option', { value: a })));
  const filter = h('input', {
    class: 'input search', type: 'search', value: address, list: listId, placeholder: 'Filter by address (node/project)',
    'aria-label': 'Filter by address', autocapitalize: 'off', spellcheck: 'false',
  });
  const applyFilter = debounce(() => {
    address = filter.value.trim();
    const q = address ? `?address=${encodeURIComponent(address)}` : '';
    history.replaceState(null, '', `#/messages${q}`);
    load();
  }, 350);
  filter.addEventListener('input', applyFilter);

  const list = h('div', { class: 'list' });
  const composeHost = h('div');
  const composeBtn = h('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', onclick: () => toggleCompose() }, '✉ Send');

  main.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', { class: 'h1', text: 'Messages' }), h('span', { class: 'spacer' }), composeBtn),
    h('div', { class: 'toolbar' }, filter, datalist),
    composeHost,
    list));

  async function load() {
    if (!loaded) clear(list).append(loading());
    try {
      const res = await api.deliveries(address);
      if (!alive) return;
      deliveries = Array.isArray(res.deliveries) ? res.deliveries : [];
      loaded = true;
      render();
    } catch (err) {
      if (!alive) return;
      clear(list).append(h('div', { class: 'empty' }, h('p', { class: 'warn-text', text: err.message }),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: load }, 'Retry')));
    }
  }

  function render() {
    clear(list);
    if (!deliveries.length) {
      list.append(emptyState(address ? 'No messages for this address' : 'No messages yet',
        'Agents talk to each other with hub_send; every delivery shows up here.'));
      return;
    }
    const sorted = [...deliveries].sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
    for (const d of sorted) list.append(deliveryCard(d));
  }

  function addrLink(addr, node, storedId) {
    if (!addr) return h('span', { class: 'muted', text: '?' });
    if (addr === 'human') return h('span', { class: 'addr addr-human', text: 'you' });
    if (node && storedId) return h('a', { class: 'addr mono', href: sessionHref(node, storedId), text: addr });
    return h('span', { class: 'addr mono', text: addr });
  }

  function deliveryCard(d) {
    const det = h('details', { class: 'card delivery', open: open.has(d.id) });
    det.addEventListener('toggle', () => { if (det.open) open.add(d.id); else open.delete(d.id); });
    const summary = h('summary', { class: 'delivery-head' },
      h('div', { class: 'delivery-route' },
        addrLink(d.from_addr, d.from_node, d.from_stored),
        h('span', { class: 'arrow', 'aria-label': 'to' }, '→'),
        addrLink(d.to_addr, d.to_node, d.to_stored)),
      h('div', { class: 'delivery-meta small' },
        h('span', { class: `status-chip ${STATUS_CLASS[d.status] || 'st-none'}`, text: d.status || '?' }),
        d.kind === 'reply' ? h('span', { class: 'badge', text: 'reply' }) : null,
        d.expect_reply && d.kind !== 'reply' ? h('span', { class: 'badge', title: 'Sender expects a reply', text: d.wait ? 'waiting' : 'expects reply' }) : null,
        h('span', { class: 'spacer' }),
        h('time', { class: 'muted', title: absTime(d.created_at), text: relTime(d.created_at) })),
      h('div', { class: 'delivery-preview muted small', text: truncate((d.message || '').replace(/\s+/g, ' '), 140) }));
    det.append(summary);
    det.append(h('div', { class: 'delivery-body' },
      h('div', { class: 'field-label', text: 'Message' }),
      markdownBlock(d.message || '(empty)', 'quote'),
      d.reply ? [h('div', { class: 'field-label', text: 'Reply' }), markdownBlock(d.reply, 'quote')] : null,
      d.error ? h('p', { class: 'warn-text small', text: `Error: ${d.error}` }) : null,
      h('dl', { class: 'kv small' },
        h('dt', { text: 'Delivery' }), h('dd', { class: 'mono', text: d.id }),
        d.parent_id ? [h('dt', { text: 'In reply to' }), h('dd', { class: 'mono', text: d.parent_id })] : null,
        Array.isArray(d.chain) && d.chain.length ? [h('dt', { text: 'Chain' }), h('dd', { class: 'mono', text: d.chain.join(' → ') })] : null,
        d.updated_at ? [h('dt', { text: 'Updated' }), h('dd', { text: absTime(d.updated_at) })] : null)));
    return det;
  }

  function toggleCompose(force) {
    const show = force ?? !composeHost.firstChild;
    clear(composeHost);
    composeBtn.setAttribute('aria-expanded', String(show));
    if (!show) return;
    const to = h('input', { class: 'input', list: listId, value: address, placeholder: 'node/project', required: true, autocapitalize: 'off', spellcheck: 'false' });
    const msg = h('textarea', { class: 'input', rows: 4, required: true, maxlength: '20000', placeholder: 'Message for the agent…' });
    const expect = h('input', { type: 'checkbox' });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send');
    composeHost.append(h('form', {
      class: 'card form-inline', 'aria-label': 'Send a message to an agent',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const res = await api.send(to.value.trim(), msg.value, expect.checked);
          toast(`Sent (${res.delivery?.status || 'queued'})`, 'ok');
          if (res.delivery) upsert(res.delivery);
          toggleCompose(false);
        } catch (err) {
          toastError(err, 'Send failed');
          btn.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'To' }), to),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Message' }), msg),
    h('label', { class: 'check' }, expect, h('span', { text: 'Ask for a reply (arrives back as a delivery)' })),
    h('div', { class: 'row-btns' }, btn, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => toggleCompose(false) }, 'Cancel'))));
    (to.value ? msg : to).focus();
  }

  function upsert(d) {
    if (!d?.id || !matches(d, address)) return;
    const i = deliveries.findIndex((x) => x.id === d.id);
    if (i >= 0) deliveries[i] = d; else deliveries.unshift(d);
    if (loaded) render();
  }

  load();
  const offs = [
    bus.on('ws:delivery', (m) => upsert(m.delivery)),
    bus.on('ws:open', () => { if (loaded) load(); }),
    bus.on('nodes', () => { clear(datalist).append(...knownAddresses().map((a) => h('option', { value: a }))); }),
  ];
  const tick = setInterval(() => { if (loaded && !document.activeElement?.closest?.('.list')) render(); }, 60000);
  return () => { alive = false; applyFilter.cancel(); offs.forEach((o) => o()); clearInterval(tick); };
}
