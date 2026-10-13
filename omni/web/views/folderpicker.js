// Folder picker (spec §3.3): a collapsed row showing the choice; expands inline into search,
// "폴더 없음", 최근, 전체 폴더 and "새 폴더 만들기". Browsing has no side effects — nothing is
// created until the user presses 만들기 (folder) or 시작 (session).

import { api, errorText } from '../api.js';
import { h, basename, fill } from '../util.js';
import { icon } from '../ui/icons.js';
import { loadingLine, errorLine, button, selectWrap } from '../ui/controls.js';

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const NONE_LABEL = '폴더 없음 (작업 폴더)';

/**
 * @param {{node:string|null, value?:string|null, onChange?:(path:string|null, folder:object|null)=>void, noneLabel?:string}} o
 */
export function createFolderPicker(o) {
  let node = o.node;
  let value = o.value ?? null;
  let data = null;          // {roots, folders}
  let loadErr = null;
  let open = false;
  let filter = '';
  let creating = false;
  let seq = 0;
  const noneLabel = o.noneLabel || NONE_LABEL;

  const valueEl = h('span', { class: 'fp-value' });
  const head = h('button', { type: 'button', class: 'fp-head', 'aria-expanded': 'false', onclick: () => toggle() },
    icon('folder', 18), valueEl, icon('chevron-right', 18, 'fp-chev'));
  const panel = h('div', { class: 'fp-panel', hidden: true });
  const el = h('div', { class: 'folder-picker' }, head, panel);

  function currentFolder() {
    return data?.folders?.find((f) => f.path === value) || null;
  }

  function renderHead() {
    const f = currentFolder();
    fill(valueEl,
      h('span', { class: 'fp-name', text: value ? (f?.name || basename(value)) : noneLabel }),
      value ? h('span', { class: 'fp-path', text: value }) : null);
  }

  function toggle(force) {
    open = force ?? !open;
    panel.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.classList.toggle('open', open);
    if (open) renderPanel();
  }

  function select(path) {
    value = path;
    renderHead();
    toggle(false);
    o.onChange?.(path, currentFolder());
  }

  function option(label, sub, path, { mono = false } = {}) {
    const sel = value === path;
    return h('button', { type: 'button', class: `fp-opt${sel ? ' sel' : ''}`, role: 'option', 'aria-selected': sel ? 'true' : 'false', onclick: () => select(path) },
      h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: label }), sub ? h('span', { class: `lr-sub${mono ? ' mono' : ''}`, text: sub }) : null),
      sel ? icon('check', 18, 'fp-check') : null);
  }

  function renderPanel() {
    if (!open) return;
    if (!node) { fill(panel, h('p', { class: 'fp-msg', text: '먼저 노드를 고르세요' })); return; }
    if (loadErr) { fill(panel, errorLine(`폴더를 불러오지 못했어요 · ${errorText(loadErr)}`, () => load())); return; }
    if (!data) { fill(panel, loadingLine('폴더 불러오는 중…')); return; }
    const search = h('input', { class: 'input fp-search', type: 'search', placeholder: '폴더 검색', value: filter, 'aria-label': '폴더 검색', autocomplete: 'off' });
    search.addEventListener('input', () => { filter = search.value; renderList(); });
    const listEl = h('div', { class: 'fp-list', role: 'listbox', 'aria-label': '폴더' });
    const tail = h('div', { class: 'fp-tail' });
    fill(panel, search, listEl, tail);
    function renderList() {
      const q = filter.trim().toLowerCase();
      const folders = data.folders || [];
      const match = (f) => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
      const kids = [];
      if (!q) kids.push(option(noneLabel, null, null));
      const recent = folders.filter((f) => f.last_active && match(f)).sort((a, b) => b.last_active - a.last_active).slice(0, 5);
      if (recent.length && !q) {
        kids.push(h('div', { class: 'fp-sh', text: '최근' }));
        for (const f of recent) kids.push(option(f.name, f.git_branch || tailPath(f.path), f.path, { mono: !!f.git_branch }));
      }
      const all = folders.filter(match).sort((a, b) => a.name.localeCompare(b.name));
      if (all.length) {
        kids.push(h('div', { class: 'fp-sh', text: '전체 폴더' }));
        for (const f of all) kids.push(option(f.name, f.git_branch || tailPath(f.path), f.path, { mono: !!f.git_branch }));
      } else if (q) kids.push(h('p', { class: 'fp-msg', text: '일치하는 폴더가 없어요' }));
      fill(listEl, ...kids);
    }
    renderList();
    renderCreate(tail);
    if (!matchMedia('(pointer: coarse)').matches) search.focus({ preventScroll: true });
  }

  function renderCreate(tail) {
    if (!creating) {
      fill(tail, h('button', { type: 'button', class: 'fp-opt fp-new', onclick: () => { creating = true; renderCreate(tail); } },
        icon('plus', 18), h('span', { class: 'lr-title', text: '새 폴더 만들기' })));
      return;
    }
    const roots = data?.roots || [];
    const name = h('input', { class: 'input', placeholder: '폴더 이름', 'aria-label': '새 폴더 이름', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
    const rootSel = roots.length > 1
      ? h('select', { class: 'input', 'aria-label': '상위 폴더' }, roots.map((r) => h('option', { value: r, text: r })))
      : null;
    const rootField = rootSel ? selectWrap(rootSel) : null;
    const err = h('p', { class: 'field-error', hidden: true });
    const make = button('만들기', { variant: 'primary', small: true, type: 'submit' });
    const form = h('form', {
      class: 'fp-create',
      onsubmit: async (e) => {
        e.preventDefault();
        const v = name.value.trim();
        if (!NAME_RE.test(v)) { err.textContent = '영문, 숫자, . _ - 만 쓸 수 있어요'; err.hidden = false; return; }
        make.disabled = true;
        try {
          const res = await api.createFolder(node, rootSel ? rootSel.value : roots[0], v);
          const f = res.folder || res.project;
          creating = false;
          if (f) {
            data.folders = [...(data.folders || []).filter((x) => x.path !== f.path), f];
            select(f.path);
          } else await load();
        } catch (ex) {
          err.textContent = errorText(ex, '폴더를 만들지 못했어요');
          err.hidden = false;
          make.disabled = false;
        }
      },
    }, name, rootField, err, h('div', { class: 'row-btns' },
      button('취소', { variant: 'ghost', small: true, onClick: () => { creating = false; renderCreate(tail); } }), make));
    fill(tail, form);
    name.focus();
  }

  const tailPath = (p) => {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
  };

  async function load() {
    const my = ++seq;
    data = null;
    loadErr = null;
    renderPanel();
    if (!node) return;
    try {
      const res = await api.folders(node);
      if (my !== seq) return;
      data = { roots: res.roots || [], folders: res.folders || [] };
    } catch (err) {
      if (my !== seq) return;
      loadErr = err;
    }
    renderHead();
    renderPanel();
  }

  renderHead();
  if (node) load();

  return {
    el,
    get value() { return value; },
    setNode(n) {
      if (n === node) return;
      node = n;
      value = null;
      creating = false;
      filter = '';
      renderHead();
      load();
      o.onChange?.(null, null);
    },
    collapse: () => toggle(false),
  };
}
