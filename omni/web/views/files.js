// File browser for a node folder (spec §3.5 파일 tab, §5b.6): breadcrumb, dirs-first listing,
// hidden-file toggle, preview sheet (text with line numbers, markdown, images), download, upload
// with overwrite confirmation, and "채팅에 첨부" (@file: reference into the open composer).

import { api, errorText } from '../api.js';
import { h, fmtBytes, relTime, download, basename, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';
import { loadingLine, errorLine, toggle, button, iconButton, segmented, emptyState } from '../ui/controls.js';
import { createSheet } from '../ui/sheet.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { markdownBlock } from '../chat/markdown.js';
import { active } from '../chat/active.js';

const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MD_RE = /\.(md|markdown|mdx)$/i;

/**
 * @param {{node:string, path:string|null, caption?:string|null, onAttach?:()=>void}} o
 *   path null → the node's first project root (workspace).
 */
export function createFileBrowser(o) {
  let path = o.path;
  let rootPath = null;
  let showHidden = false;
  let listing = null;
  let seq = 0;

  const crumbs = h('div', { class: 'fb-crumbs', role: 'navigation', 'aria-label': '경로' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const uploadBtn = button('업로드', { variant: 'secondary', icon: 'upload', small: true, onClick: () => fileInput.click() });
  const refreshBtn = iconButton('refresh', '새로 고침', () => load());
  const hiddenToggle = toggle({ label: '숨김 파일 보기', onChange: (v) => { showHidden = v; renderList(); } });
  const tools = h('div', { class: 'fb-tools' },
    h('label', { class: 'fb-hidden' }, h('span', { text: '숨김 파일 보기' }), hiddenToggle), h('span', { class: 'appbar-spacer' }), uploadBtn, refreshBtn);
  const listEl = h('div', { class: 'fb-list' });
  const progress = h('div', { class: 'fb-progress', hidden: true });
  const el = h('div', { class: 'file-browser' },
    o.caption ? h('p', { class: 'caption', text: o.caption }) : null, crumbs, tools, progress, listEl, fileInput);

  function renderCrumbs() {
    fill(crumbs);
    if (!listing) return;
    const root = listing.root || rootPath || listing.path;
    const rel = listing.path.startsWith(root) ? listing.path.slice(root.length).split('/').filter(Boolean) : [];
    const parts = [{ label: basename(root) || root, path: root }];
    let acc = root;
    for (const seg of rel) { acc = `${acc.replace(/\/$/, '')}/${seg}`; parts.push({ label: seg, path: acc }); }
    parts.forEach((p, i) => {
      if (i) add(crumbs, h('span', { class: 'fb-sep', text: '/' }));
      const last = i === parts.length - 1;
      add(crumbs, last ? h('span', { class: 'fb-crumb cur', text: p.label })
        : h('button', { type: 'button', class: 'fb-crumb', text: p.label, onclick: () => { path = p.path; load(); } }));
    });
    requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
  }

  function renderList() {
    if (!listing) return;
    const entries = (listing.entries || []).filter((e) => showHidden || !e.name.startsWith('.'));
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const kids = [];
    if (listing.parent && listing.path !== (listing.root || rootPath)) {
      kids.push(h('button', { type: 'button', class: 'file-row', onclick: () => { path = listing.parent; load(); } },
        icon('chevron-left', 18, 'fr-icon'), h('span', { class: 'fr-name', text: '상위 폴더' })));
    }
    for (const e of entries) {
      kids.push(h('button', {
        type: 'button', class: 'file-row',
        onclick: () => { if (e.dir) { path = e.path; load(); } else preview(e); },
      },
      icon(e.dir ? 'folder' : 'file', 18, 'fr-icon'),
      h('span', { class: 'fr-name', text: e.name }),
      h('span', { class: 'fr-meta', text: [e.dir ? '' : fmtBytes(e.size), relTime(e.mtime)].filter(Boolean).join(' · ') })));
    }
    if (!entries.length) kids.push(emptyState({ title: '빈 폴더예요' }));
    if (listing.truncated) kids.push(h('p', { class: 'caption', text: '항목이 많아 일부만 보여줘요' }));
    fill(listEl, ...kids);
    uploadBtn.disabled = listing.writable === false;
  }

  async function load() {
    const my = ++seq;
    fill(listEl, loadingLine());
    try {
      if (!path) {
        const f = await api.folders(o.node);
        rootPath = (f.roots || [])[0] || null;
        path = rootPath;
        if (!path) { fill(listEl, emptyState({ title: '열 수 있는 폴더가 없어요' })); return; }
      }
      const res = await api.files(o.node, path);
      if (my !== seq) return;
      listing = res;
      if (!rootPath) rootPath = res.root;
      renderCrumbs();
      renderList();
    } catch (err) {
      if (my !== seq) return;
      listing = null;
      fill(crumbs);
      if (err.code === 'outside_roots') fill(listEl, emptyState({ title: '이 폴더는 허브에서 열 수 없어요' }));
      else fill(listEl, errorLine(errorText(err, '폴더를 열지 못했어요'), () => load()));
    }
  }

  // ---------------------------------------------------------------- preview
  async function preview(e) {
    const isImg = IMG_RE.test(e.name);
    const isMd = MD_RE.test(e.name);
    const dl = button('다운로드', { variant: 'secondary', icon: 'download', onClick: () => download(api.fileRawUrl(o.node, e.path, true), e.name) });
    const attach = active.chat && active.chat.node === o.node
      ? button('채팅에 첨부', {
        variant: 'primary', icon: 'paperclip',
        onClick: () => {
          active.chat?.insertText(`@file:${e.path} `);
          sheet.close();
          toast('채팅에 첨부했어요');
          o.onAttach?.();
        },
      })
      : null;
    const sheet = createSheet({ title: e.name, desktop: 'dialog', width: 760, tall: true, cls: 'preview-sheet', footer: h('div', { class: 'row-btns end' }, dl, attach) });
    add(sheet.body, h('p', { class: 'caption mono', text: `${e.path} · ${fmtBytes(e.size)}` }));
    if (isImg) {
      add(sheet.body, h('div', { class: 'pv-img' }, h('img', { src: api.fileRawUrl(o.node, e.path, false), alt: e.name })));
      return;
    }
    const box = h('div', { class: 'pv-box' }, loadingLine());
    add(sheet.body, box);
    try {
      const res = await api.fileText(o.node, e.path);
      if (res.binary || res.text === null || res.text === undefined) {
        fill(box, emptyState({ title: '미리 볼 수 없는 파일이에요' }));
        return;
      }
      const raw = codeWithLines(res.text);
      if (isMd) {
        const rendered = markdownBlock(res.text, 'pv-md');
        const seg = segmented({
          label: '보기', options: [{ value: 'md', label: '미리보기' }, { value: 'raw', label: '원문' }], value: 'md',
          onChange: (v) => { fill(box, seg, v === 'md' ? rendered : raw); },
        });
        fill(box, seg, rendered);
      } else fill(box, raw);
      if (res.truncated) add(box, h('p', { class: 'caption', text: '파일이 커서 앞부분만 보여줘요' }));
    } catch (err) {
      fill(box, err.code === 'sensitive' ? emptyState({ title: '보안상 열 수 없는 파일이에요' }) : errorLine(errorText(err, '파일을 열지 못했어요')));
    }
  }

  function codeWithLines(text) {
    const lines = text.replace(/\n$/, '').split('\n');
    const gutter = h('pre', { class: 'pv-gutter', 'aria-hidden': 'true', text: lines.map((_, i) => i + 1).join('\n') });
    const code = h('pre', { class: 'pv-code', text: lines.join('\n') });
    return h('div', { class: 'pv-text' }, gutter, code);
  }

  // ---------------------------------------------------------------- upload
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (files.length) upload(files, false);
  });

  async function upload(files, overwrite) {
    if (!listing) return;
    const big = files.find((f) => f.size > 50 * 1024 * 1024);
    if (big) { toast('50MB 이하 파일만 올릴 수 있어요', { tone: 'error' }); return; }
    progress.hidden = false;
    fill(progress, h('span', { class: 'fb-progress-fill' }));
    const bar = progress.firstChild;
    const up = api.uploadFiles(o.node, listing.path, files, overwrite, (p) => { bar.style.width = `${Math.round(p * 100)}%`; });
    try {
      await up.promise;
      toast(files.length > 1 ? `${files.length}개 파일을 올렸어요` : '파일을 올렸어요');
      load();
    } catch (err) {
      if (err.code === 'exists' && !overwrite) {
        const ok = await confirmDialog({ title: '같은 이름의 파일이 있어요. 덮어쓸까요?', body: (err.data?.names || []).join(', '), ok: '덮어쓰기' });
        if (ok) { upload(files, true); return; }
      } else toastError(err, '올리지 못했어요');
    } finally {
      progress.hidden = true;
    }
  }

  load();
  return { el, reload: load };
}
