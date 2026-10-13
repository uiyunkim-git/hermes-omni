// #/ — overview of all nodes (cards: online state, Hermes status, GPUs, projects, dashboard link).

import { bus, state } from '../store.js';
import { h, clear, enc, relTime, absTime, loading, emptyState } from '../util.js';
import { api } from '../api.js';
import { confirmDialog } from '../components/dialog.js';
import { toast, toastError } from '../components/toast.js';

export function sortNodes(nodes) {
  return [...nodes].sort((a, b) => (Number(!!b.online) - Number(!!a.online))
    || (Number(b.role === 'hub') - Number(a.role === 'hub'))
    || String(a.display_name || a.node_id).localeCompare(String(b.display_name || b.node_id)));
}

function pct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

export function gpuBars(gpus) {
  if (!Array.isArray(gpus) || !gpus.length) return null;
  return h('div', { class: 'gpus' }, gpus.map((g) => {
    const util = pct(g.util_pct);
    const memPct = g.mem_total_mb ? pct((g.mem_used_mb / g.mem_total_mb) * 100) : 0;
    const memLabel = g.mem_total_mb ? `${(g.mem_used_mb / 1024).toFixed(1)} / ${(g.mem_total_mb / 1024).toFixed(0)} GB` : '—';
    return h('div', { class: 'gpu' },
      h('div', { class: 'gpu-name', text: `GPU${g.index ?? ''} ${g.name || ''}`.trim() }),
      bar('Util', util, `${Math.round(util)}%`),
      bar('Mem', memPct, memLabel));
  }));
}

function bar(label, value, text) {
  const level = value >= 90 ? 'hi' : value >= 60 ? 'mid' : 'lo';
  return h('div', { class: 'bar-row' },
    h('span', { class: 'bar-label', text: label }),
    h('span', {
      class: `bar bar-${level}`, role: 'meter', 'aria-label': `${label} ${text}`,
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(value)),
    }, h('span', { class: 'bar-fill', style: { width: `${value}%` } })),
    h('span', { class: 'bar-text', text }));
}

export function hermesLine(n) {
  const hm = n.hermes || {};
  if (!n.online) return h('span', { class: 'muted', text: 'Offline' });
  if (!hm.ok) return h('span', { class: 'warn-text', text: 'Hermes unreachable' });
  const parts = [hm.version ? `Hermes ${hm.version}` : 'Hermes', hm.gateway_state, hm.model].filter(Boolean);
  return h('span', { text: parts.join(' · ') });
}

function nodeCard(n) {
  const projects = Array.isArray(n.projects) ? n.projects : [];
  const running = projects.filter((p) => p.canonical?.running).length;
  const name = n.display_name || n.node_id;
  return h('article', { class: `card node-card ${n.online ? 'is-online' : 'is-offline'}` },
    h('div', { class: 'node-head' },
      h('span', { class: `dot ${n.online ? 'dot-on' : 'dot-off'}`, role: 'img', 'aria-label': n.online ? 'online' : 'offline' }),
      h('a', { class: 'node-name stretched', href: `#/n/${enc(n.node_id)}`, text: name }),
      n.role === 'hub' ? h('span', { class: 'badge', text: 'hub' }) : null,
      h('span', { class: 'spacer' }),
      n.dashboard_url ? h('a', {
        class: 'link-ext', href: n.dashboard_url, target: '_blank', rel: 'noopener noreferrer',
        'aria-label': `Open Hermes dashboard of ${name} in a new tab`,
      }, 'Dashboard ↗') : null),
    h('div', { class: 'node-sub muted small' },
      n.hostname && n.hostname !== name ? `${n.hostname} · ` : '',
      n.online ? `seen ${relTime(n.last_seen)}` : `last seen ${relTime(n.last_seen)}`),
    h('div', { class: 'node-hermes small' }, hermesLine(n)),
    gpuBars(n.gpus),
    h('div', { class: 'node-foot small' },
      h('span', { text: `${projects.length} project${projects.length === 1 ? '' : 's'}` }),
      running ? h('span', { class: 'status-chip st-running', text: `${running} running` }) : null,
      h('span', { class: 'spacer' }),
      n.link_version ? h('span', { class: 'muted', title: absTime(n.last_seen), text: `link ${n.link_version}` }) : null,
      n.online ? null : h('button', {
        class: 'btn btn-sm btn-danger node-forget', type: 'button', text: 'Forget',
        'aria-label': `Remove offline node ${name} from the hub`, onclick: (e) => forget(e, n.node_id, name),
      })));
}

async function forget(e, nodeId, name) {
  e.preventDefault();
  e.stopPropagation();
  const ok = await confirmDialog({
    title: `Forget ${name}?`, okLabel: 'Forget', danger: true,
    message: 'The node is removed from the hub. Its message history stays. If the machine runs its link again it re-registers.',
  });
  if (!ok) return;
  try {
    await api.forgetNode(nodeId);
    toast(`${name} removed`);
  } catch (err) {
    toastError(err, 'Forget failed: ');
  }
}

export default function nodesView(main, ctx) {
  ctx.setTitle('Nodes');
  const list = h('div', { class: 'grid' });
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', { class: 'h1', text: 'Nodes' })),
    list);
  main.append(page);

  function render() {
    clear(list);
    if (!state.nodesLoaded) {
      list.append(loading('Loading nodes…'));
      return;
    }
    if (!state.nodes.length) {
      list.append(emptyState('No nodes yet', 'Open Join to connect your first machine.'),
        h('a', { class: 'btn btn-primary', href: '#/join' }, 'Join a machine'));
      return;
    }
    for (const n of sortNodes(state.nodes)) list.append(nodeCard(n));
  }

  render();
  const off = bus.on('nodes', render);
  const tick = setInterval(render, 30000);
  return () => { off(); clearInterval(tick); };
}
