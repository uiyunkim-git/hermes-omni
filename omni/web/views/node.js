// #/n/<node> — projects of one node: search, canonical status, new project, rescan, open canonical
// chat (POST sessions {path, canonical:true}), other sessions per folder, new session in folder.

import { api } from '../api.js';
import { bus, findNode, state } from '../store.js';
import { h, clear, relTime, absTime, sessionHref, loading, emptyState, truncate } from '../util.js';
import { toast, toastError } from '../components/toast.js';
import { promptDialog } from '../components/dialog.js';
import { gpuBars, hermesLine } from './nodes.js';

const NEW_PROJECT_RE = /^[A-Za-z0-9._-]+$/;

function lastActive(p) {
  return p.canonical?.last_active ?? null;
}

function sortProjects(list) {
  return [...list].sort((a, b) => (Number(!!b.is_root) - Number(!!a.is_root))
    || (Number(!!b.canonical?.running) - Number(!!a.canonical?.running))
    || ((Number(lastActive(b)) || 0) - (Number(lastActive(a)) || 0))
    || String(a.name).localeCompare(String(b.name)));
}

function statusBadge(c) {
  if (!c) return h('span', { class: 'status-chip st-none', text: 'no session' });
  if (c.running) return h('span', { class: 'status-chip st-running', text: 'running' });
  return h('span', { class: 'status-chip st-idle', text: 'idle' });
}

export default function nodeView(main, ctx) {
  const nodeId = ctx.params.node;
  ctx.setTitle(nodeId);
  let rescanned = null;          // projects from an explicit rescan, until the next nodes push
  let opening = false;
  let alive = true;
  const expanded = new Set();    // project paths whose session list is open
  const sessionCache = new Map(); // path → {loading, error, sessions}

  const headEl = h('div', { class: 'node-detail' });
  const search = h('input', {
    class: 'input search', type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects',
    autocapitalize: 'off', spellcheck: 'false', oninput: () => renderList(),
  });
  const newBtn = h('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', onclick: () => toggleNewForm() }, '+ New project');
  const rescanBtn = h('button', { type: 'button', class: 'btn', onclick: () => doRescan() }, 'Rescan');
  const formHost = h('div');
  const list = h('div', { class: 'list', role: 'list' });

  main.append(h('div', { class: 'page' },
    h('a', { class: 'back', href: '#/' }, '← Nodes'),
    headEl,
    h('div', { class: 'toolbar' }, search, h('div', { class: 'toolbar-btns' }, newBtn, rescanBtn)),
    formHost,
    list));

  function node() { return findNode(nodeId); }
  function projects() { return rescanned || node()?.projects || []; }

  function renderHead() {
    clear(headEl);
    const n = node();
    if (!n) {
      headEl.append(state.nodesLoaded ? emptyState('Unknown node', `No node named “${nodeId}” is registered.`) : loading());
      return;
    }
    const name = n.display_name || n.node_id;
    ctx.setTitle(name);
    headEl.append(
      h('div', { class: 'node-head' },
        h('span', { class: `dot ${n.online ? 'dot-on' : 'dot-off'}`, role: 'img', 'aria-label': n.online ? 'online' : 'offline' }),
        h('h1', { class: 'h1', text: name }),
        n.role === 'hub' ? h('span', { class: 'badge', text: 'hub' }) : null,
        h('span', { class: 'spacer' }),
        n.dashboard_url ? h('a', { class: 'link-ext', href: n.dashboard_url, target: '_blank', rel: 'noopener noreferrer' }, 'Dashboard ↗') : null),
      h('div', { class: 'muted small' }, hermesLine(n), n.online ? '' : ` · last seen ${relTime(n.last_seen)}`),
      gpuBars(n.gpus));
    rescanBtn.disabled = newBtn.disabled = !n.online;
  }

  function renderList() {
    clear(list);
    const n = node();
    if (!n) return;
    const q = search.value.trim().toLowerCase();
    const all = sortProjects(projects());
    const shown = q ? all.filter((p) => `${p.name} ${p.path} ${p.canonical?.title || ''}`.toLowerCase().includes(q)) : all;
    if (!all.length) {
      list.append(emptyState('No projects', 'Create one or rescan the project roots.'));
      return;
    }
    if (!shown.length) {
      list.append(emptyState('No matches', `Nothing matches “${search.value}”.`));
      return;
    }
    for (const p of shown) list.append(projectRow(p, n));
  }

  function projectRow(p, n) {
    const c = p.canonical;
    const isOpen = expanded.has(p.path);
    const openBtn = h('button', {
      type: 'button', class: 'proj-main', disabled: !n.online,
      'aria-label': `Open chat for project ${p.name}`,
      onclick: (e) => openCanonical(p, e.currentTarget),
    },
    h('span', { class: 'proj-title' },
      h('span', { class: 'proj-name', text: p.name }),
      p.is_root ? h('span', { class: 'badge', text: 'workspace' }) : null,
      p.git_branch ? h('span', { class: 'badge badge-git', title: 'git branch', text: `⎇ ${truncate(p.git_branch, 24)}` }) : (p.is_git ? h('span', { class: 'badge badge-git', text: 'git' }) : null)),
    h('span', { class: 'proj-path muted small mono', text: p.path }),
    h('span', { class: 'proj-meta small' },
      statusBadge(c),
      c ? h('span', { class: 'muted', title: absTime(c.last_active), text: `active ${relTime(c.last_active)}` }) : null,
      c && Number.isFinite(c.message_count) ? h('span', { class: 'muted', text: `${c.message_count} msgs` }) : null));

    const count = Number(p.session_count) || 0;
    const toggle = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm', 'aria-expanded': String(isOpen),
      onclick: () => {
        if (expanded.has(p.path)) expanded.delete(p.path);
        else { expanded.add(p.path); loadSessions(p.path, true); }
        renderList();
      },
    }, `${isOpen ? '▾' : '▸'} Sessions${count ? ` (${count})` : ''}`);
    const newSess = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: !n.online, onclick: (e) => newSession(p, e.currentTarget) }, '+ New session');

    const row = h('div', { class: `card proj ${c?.running ? 'is-running' : ''}`, role: 'listitem' },
      openBtn,
      h('div', { class: 'proj-actions' }, toggle, newSess));
    if (isOpen) row.append(sessionsBlock(p));
    return row;
  }

  function sessionsBlock(p) {
    const entry = sessionCache.get(p.path);
    const box = h('div', { class: 'sessions' });
    if (!entry || entry.loading) { box.append(loading('Loading sessions…')); return box; }
    if (entry.error) {
      box.append(h('p', { class: 'warn-text small', text: entry.error }),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => loadSessions(p.path, true) }, 'Retry'));
      return box;
    }
    if (!entry.sessions.length) { box.append(h('p', { class: 'muted small', text: 'No sessions in this folder yet.' })); return box; }
    for (const s of entry.sessions) {
      box.append(h('a', { class: 'sess-link', href: sessionHref(nodeId, s.stored_id) },
        h('span', { class: 'sess-title' },
          s.canonical ? h('span', { class: 'badge', title: 'Canonical session of this folder', text: 'canonical' }) : null,
          h('span', { text: s.title || s.stored_id })),
        h('span', { class: 'sess-meta small muted' },
          s.running ? h('span', { class: 'status-chip st-running', text: 'running' }) : null,
          ` ${relTime(s.last_active)}`,
          Number.isFinite(s.message_count) ? ` · ${s.message_count} msgs` : '',
          s.source ? ` · ${s.source}` : '')));
    }
    return box;
  }

  async function loadSessions(path, force = false) {
    if (!force && sessionCache.has(path)) return;
    sessionCache.set(path, { loading: true });
    renderList();
    try {
      const res = await api.sessions(nodeId, path);
      sessionCache.set(path, { sessions: Array.isArray(res.sessions) ? res.sessions : [] });
    } catch (err) {
      sessionCache.set(path, { error: err.message });
    }
    if (alive) renderList();
  }

  async function openCanonical(p, btn) {
    if (opening) return;
    opening = true;
    btn.classList.add('busy');
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.openSession(nodeId, { path: p.path, canonical: true });
      if (alive) ctx.navigate(sessionHref(nodeId, res.stored_id));
    } catch (err) {
      toastError(err, `Could not open ${p.name}`);
    } finally {
      opening = false;
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
    }
  }

  async function newSession(p, btn) {
    const title = await promptDialog({
      title: `New session in ${p.name}`, label: 'Optional title (leave empty for an automatic one).', okLabel: 'Create',
    });
    if (title === null) return;
    btn.disabled = true;
    try {
      const body = { path: p.path };
      if (title.trim()) body.title = title.trim();
      const res = await api.openSession(nodeId, body);
      if (alive) ctx.navigate(sessionHref(nodeId, res.stored_id));
    } catch (err) {
      toastError(err, 'Could not create session');
      btn.disabled = false;
    }
  }

  async function doRescan() {
    rescanBtn.disabled = true;
    rescanBtn.textContent = 'Scanning…';
    try {
      const res = await api.rescan(nodeId);
      rescanned = Array.isArray(res.projects) ? res.projects : null;
      sessionCache.clear();
      for (const path of expanded) loadSessions(path, true);
      toast(`Found ${projects().length} projects`, 'ok', 2500);
    } catch (err) {
      toastError(err, 'Rescan failed');
    } finally {
      rescanBtn.textContent = 'Rescan';
      rescanBtn.disabled = !node()?.online;
      if (alive) renderList();
    }
  }

  function toggleNewForm(force) {
    const open = force ?? !formHost.firstChild;
    clear(formHost);
    newBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const n = node();
    const roots = n?.project_roots || [];
    const rootSel = h('select', { class: 'input', 'aria-label': 'Project root' }, roots.map((r) => h('option', { value: r, text: r })));
    const name = h('input', {
      class: 'input', placeholder: 'my-project', 'aria-label': 'Project folder name', autocapitalize: 'off', spellcheck: 'false',
      required: true, maxlength: '100',
    });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const create = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create');
    formHost.append(h('form', {
      class: 'card form-inline', 'aria-label': 'New project',
      onsubmit: async (e) => {
        e.preventDefault();
        const v = name.value.trim();
        if (!NEW_PROJECT_RE.test(v) || v.startsWith('.')) {
          err.textContent = 'Use letters, digits, dot, dash or underscore (no leading dot).';
          err.hidden = false;
          return;
        }
        err.hidden = true;
        create.disabled = true;
        try {
          const res = await api.createProject(nodeId, rootSel.value, v);
          toast(`Created ${res.project?.name || v}`, 'ok');
          toggleNewForm(false);
          const p = res.project;
          if (p) {
            const base = projects().filter((x) => x.path !== p.path);
            rescanned = [...base, p];
            renderList();
          }
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          create.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Root' }), rootSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Folder name' }), name),
    err,
    h('div', { class: 'row-btns' }, create, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => toggleNewForm(false) }, 'Cancel'))));
    name.focus();
  }

  renderHead();
  renderList();
  const off = bus.on('nodes', () => {
    rescanned = null;
    renderHead();
    if (document.activeElement?.closest?.('.list')) return; // don't yank focus mid-interaction
    renderList();
  });
  const tick = setInterval(() => { if (!document.activeElement?.closest?.('.list')) renderList(); }, 60000);
  return () => { alive = false; off(); clearInterval(tick); };
}

