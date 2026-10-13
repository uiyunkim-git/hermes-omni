// Composer (spec §3.4.4): one docked box — attachment chips, autosizing textarea, and a quiet
// bottom row (attach, slash, model chip … context ring, send/stop). Owns the slash palette and
// the @mention picker, per-session drafts and desktop key handling.

import { api } from '../api.js';
import { h, autosize, debounce, desktopKeys, fmtBytes, ls, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';
import { createListPopover } from './popover.js';
import { normalizeCatalog, paletteEntries } from './slash.js';
import { folderLabel, rowTitle } from '../store.js';

const MAX_ATTACH = 20 * 1024 * 1024;
const SLASH_RE = /^\/[A-Za-z][\w-]*(?=\s|$)/;
const EFFORT_KO = { none: '끔', minimal: '최소', low: '낮음', medium: '중간', high: '높음', xhigh: '매우 높음', max: '최대' };

export const effortKo = (e) => EFFORT_KO[e] || e || '';

/** Strip "provider/" and "org/" prefixes; cap at 22 chars. */
export function shortModel(m) {
  if (!m || typeof m !== 'string') return '';
  const s = m.split('/').pop();
  return s.length > 22 ? `${s.slice(0, 21)}…` : s;
}

function ring(pct) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const track = document.createElementNS(NS, 'circle');
  const arc = document.createElementNS(NS, 'circle');
  for (const el of [track, arc]) {
    el.setAttribute('cx', '8');
    el.setAttribute('cy', '8');
    el.setAttribute('r', String(r));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', '2');
  }
  track.setAttribute('class', 'ring-track');
  arc.setAttribute('class', 'ring-arc');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('transform', 'rotate(-90 8 8)');
  arc.setAttribute('stroke-dasharray', `${(c * Math.min(100, Math.max(0, pct))) / 100} ${c}`);
  add(svg, track, arc);
  return svg;
}

/**
 * @param {{
 *   node:string, sid:string, key:string,
 *   send:(text:string, mode:'queue'|'steer')=>Promise<boolean>,
 *   interrupt:()=>void,
 *   slash:(text:string, item?:object)=>void,
 *   catalog:()=>Promise<object>,
 *   openModel:(anchor:Element)=>void,
 *   openContext:()=>void,
 *   lastPrompt:()=>string|null,
 * }} o
 */
export function createComposer(o) {
  const draftKey = `omni.draft.${o.key}`;
  let running = false;
  let disabled = false;
  let features = true;
  let disabledPlaceholder = '';
  /** @type {Array<{id:number, file:File, name:string, size:number, state:'uploading'|'ready'|'error', kind?:string, el:HTMLElement, abort?:()=>void}>} */
  const atts = [];
  let attSeq = 0;
  let catalogNorm = null;
  let showMore = false;

  // ---------------------------------------------------------------- DOM
  const queueEl = h('div', { class: 'queue-strip', hidden: true });
  const attRow = h('div', { class: 'att-row', hidden: true });
  const ta = h('textarea', {
    class: 'composer-input', rows: 1, 'aria-label': '메시지', placeholder: '메시지를 입력하세요',
    enterkeyhint: desktopKeys() ? 'send' : 'enter', autocapitalize: 'sentences', spellcheck: 'false',
  });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1' });
  const attachBtn = h('button', { type: 'button', class: 'c-btn', 'aria-label': '파일 첨부', title: '파일 첨부', onclick: () => fileInput.click() }, icon('paperclip', 20));
  const slashBtn = h('button', {
    type: 'button', class: 'c-btn slash-btn', 'aria-label': '명령', title: '명령 (/)',
    onclick: () => {
      if (!ta.value.startsWith('/')) { ta.value = `/${ta.value}`; }
      ta.focus();
      ta.setSelectionRange(1, 1);
      onInput();
    },
  }, icon('slash', 20));
  const modelLabel = h('span', { class: 'mc-label' });
  const modelChip = h('button', { type: 'button', class: 'model-chip', hidden: true, 'aria-label': '모델', onclick: () => o.openModel(modelChip) }, modelLabel, icon('chevron-down', 12));
  const ctxPct = h('span', { class: 'ctx-pct' });
  const ctxBtn = h('button', { type: 'button', class: 'ctx-meter', hidden: true, 'aria-label': '컨텍스트 사용량', onclick: () => o.openContext() }, h('span', { class: 'ctx-ring' }), ctxPct);
  const steerBtn = h('button', { type: 'button', class: 'steer-btn', hidden: true, text: '끼어들기', onclick: () => submit('steer') });
  const stopGhost = h('button', { type: 'button', class: 'send-btn is-stop', hidden: true, 'aria-label': '중단', title: '중단', onclick: () => o.interrupt() }, icon('stop', 16));
  const primary = h('button', { type: 'button', class: 'send-btn', 'aria-label': '보내기', onclick: () => onPrimary() }, icon('arrow-up', 18));
  const bar = h('div', { class: 'composer-bar' },
    attachBtn, slashBtn, modelChip, h('span', { class: 'appbar-spacer' }), ctxBtn, steerBtn, stopGhost, primary);
  const box = h('div', { class: 'composer-box' }, attRow, ta, bar);
  const el = h('div', { class: 'composer' }, queueEl, box, fileInput);

  // ---------------------------------------------------------------- drafts
  const saved = ls.get(draftKey, '');
  if (saved) ta.value = saved;
  const saveDraft = debounce(() => ls.set(draftKey, ta.value || null), 300);

  // ---------------------------------------------------------------- state rendering
  const hasContent = () => ta.value.trim().length > 0 || atts.some((a) => a.state === 'ready');
  function renderButtons() {
    const text = hasContent();
    const uploading = atts.some((a) => a.state === 'uploading');
    steerBtn.hidden = !(running && ta.value.trim());
    el.classList.toggle('steering', !steerBtn.hidden);
    stopGhost.hidden = !(running && text);
    fill(primary, icon(running && !text ? 'stop' : 'arrow-up', running && !text ? 16 : 18));
    primary.classList.toggle('is-stop', running && !text);
    primary.setAttribute('aria-label', running && !text ? '중단' : running ? '대기열에 추가' : '보내기');
    primary.title = primary.getAttribute('aria-label');
    primary.disabled = disabled || (!running && !text) || uploading;
    ta.placeholder = disabled ? disabledPlaceholder : running ? '다음 메시지 (대기열에 추가돼요)' : '메시지를 입력하세요';
  }

  function setRunning(r) {
    running = !!r;
    renderButtons();
  }

  function setDisabled(on, placeholder = '') {
    disabled = !!on;
    disabledPlaceholder = placeholder;
    ta.disabled = disabled;
    attachBtn.disabled = disabled;
    slashBtn.disabled = disabled;
    el.classList.toggle('disabled', disabled);
    renderButtons();
  }

  function setFeatures(on) {
    features = !!on;
    slashBtn.hidden = !features;
    if (!features) { modelChip.hidden = true; ctxBtn.hidden = true; }
  }

  function setMeta(meta) {
    if (!features || !meta) { modelChip.hidden = true; ctxBtn.hidden = true; return; }
    const m = shortModel(meta.model);
    if (m) {
      // Only the model name shrinks on a narrow bar; the effort stays readable.
      fill(modelLabel, h('span', { class: 'mc-model', text: m }),
        meta.reasoning_effort ? h('span', { class: 'mc-effort', text: `\u00a0· ${effortKo(meta.reasoning_effort)}` }) : null);
      modelChip.title = meta.reasoning_effort ? `${m} · ${effortKo(meta.reasoning_effort)}` : m;
      modelChip.hidden = false;
    } else modelChip.hidden = true;
    const pct = meta.context?.percent;
    if (Number.isFinite(pct)) {
      ctxBtn.hidden = false;
      const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
      ctxBtn.className = `ctx-meter${tone ? ` ${tone}` : ''}`;
      ctxBtn.querySelector('.ctx-ring').replaceChildren(ring(pct));
      ctxPct.textContent = `${Math.round(pct)}%`;
      ctxBtn.title = `컨텍스트 ${Math.round(pct)}%`;
    } else ctxBtn.hidden = true;
  }

  /** items: [{text, at}] — prompts waiting for the running turn. */
  function setQueue(items) {
    fill(queueEl);
    if (!items || !items.length) { queueEl.hidden = true; return; }
    queueEl.hidden = false;
    for (const it of items) {
      const t = String(it.text || '').replace(/\s+/g, ' ');
      add(queueEl, h('div', { class: 'q-item' }, icon('clock', 14), h('span', { text: `대기 중 · ${t.length > 60 ? `${t.slice(0, 59)}…` : t}` })));
    }
    add(queueEl, h('div', { class: 'q-caption', text: '지금 작업이 끝나면 차례로 보내요' }));
  }

  // ---------------------------------------------------------------- attachments
  function renderAtts() {
    attRow.hidden = atts.length === 0;
    fill(attRow, ...atts.map((a) => a.el));
    renderButtons();
  }

  function addFiles(files) {
    for (const file of files) {
      if (file.size > MAX_ATTACH) { toast('20MB 이하 파일만 첨부할 수 있어요', { tone: 'error' }); continue; }
      const a = { id: ++attSeq, file, name: file.name, size: file.size, state: 'uploading' };
      const prog = h('span', { class: 'att-prog' }, h('span', { class: 'att-prog-fill' }));
      let thumb = null;
      if (/^image\//.test(file.type)) {
        try { thumb = h('img', { class: 'att-thumb', alt: '', src: URL.createObjectURL(file) }); } catch { thumb = null; }
      }
      a.el = h('span', { class: 'att-chip uploading' },
        thumb || icon('paperclip', 14),
        h('span', { class: 'att-name', text: `${file.name} · ${fmtBytes(file.size)}` }),
        h('button', { type: 'button', class: 'att-x', 'aria-label': `${file.name} 제거`, onclick: () => removeAtt(a) }, icon('x', 14)),
        prog);
      atts.push(a);
      const up = api.attach(o.node, o.sid, file, (p) => { prog.firstChild.style.width = `${Math.round(p * 100)}%`; });
      a.abort = up.abort;
      up.promise.then((res) => {
        if (!atts.includes(a)) return;
        a.state = 'ready';
        a.kind = res.kind;
        a.el.classList.remove('uploading');
        prog.remove();
        if (res.kind === 'file' && res.ref_text) {
          insertAtCaret(`${res.ref_text} `);
          removeAtt(a, true);
        }
        renderButtons();
      }).catch((err) => {
        if (!atts.includes(a)) return;
        a.state = 'error';
        a.el.classList.add('error');
        prog.remove();
        if (err.code !== 'aborted') toastError(err, '첨부하지 못했어요');
        renderButtons();
      });
    }
    renderAtts();
  }

  function removeAtt(a, silent = false) {
    const i = atts.indexOf(a);
    if (i < 0) return;
    atts.splice(i, 1);
    if (a.state === 'uploading') a.abort?.();
    const img = a.el.querySelector('img');
    if (img) { try { URL.revokeObjectURL(img.src); } catch { /* ignore */ } }
    if (!silent) ta.focus();
    renderAtts();
  }

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    if (files.length) addFiles(files);
  });

  // ---------------------------------------------------------------- text helpers
  function insertAtCaret(text) {
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    const c = s + text.length;
    ta.setSelectionRange(c, c);
    autosize(ta, maxLines());
    saveDraft();
    renderButtons();
  }

  const maxLines = () => (desktopKeys() ? 12 : 8);

  // ---------------------------------------------------------------- popovers
  const pop = createListPopover(el, {
    label: '명령',
    onPick: (item) => (mode === 'slash' ? pickSlash(item) : pickMention(item)),
    onClose: () => { mode = null; },
  });
  let mode = null;            // 'slash' | 'mention' | null
  let mentionStart = -1;

  async function ensureCatalog() {
    if (catalogNorm) return catalogNorm;
    try {
      catalogNorm = normalizeCatalog(await o.catalog());
    } catch {
      catalogNorm = null;
    }
    return catalogNorm;
  }

  async function showSlash() {
    const q = (ta.value.slice(1).match(/^[\w-]*/) || [''])[0];
    mode = 'slash';
    pop.show(paletteEntries(catalogNorm, q, { showMore, features }), '일치하는 명령이 없어요');
    if (!catalogNorm && features) {
      await ensureCatalog();
      if (mode === 'slash' && ta.value.startsWith('/')) {
        pop.show(paletteEntries(catalogNorm, (ta.value.slice(1).match(/^[\w-]*/) || [''])[0], { showMore, features }), '일치하는 명령이 없어요');
      }
    }
  }

  function pickSlash(item) {
    if (item.kind === 'more') { showMore = true; showSlash(); return; }
    pop.close();
    if (item.kind === 'native') {
      ta.value = '';
      afterChange();
      o.slash(item.cmd, item);
      return;
    }
    if (item.argMode) {
      ta.value = `${item.cmd} `;
      afterChange();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return;
    }
    ta.value = '';
    afterChange();
    o.slash(item.cmd, item);
  }

  const mentionQuery = debounce(async (q) => {
    try {
      const res = await api.sessions({ q, limit: 8 });
      if (mode !== 'mention') return;
      const rows = (res.sessions || []).filter((r) => r.key !== o.key).slice(0, 8);
      pop.show(rows.map((r) => ({
        item: r,
        title: rowTitle(r),
        sub: [r.node_name || r.node, folderLabel(r), r.running ? '실행 중' : null].filter(Boolean).join(' · '),
      })), '일치하는 세션이 없어요');
    } catch {
      if (mode === 'mention') pop.show([], '세션을 불러오지 못했어요');
    }
  }, 150);

  function pickMention(row) {
    pop.close();
    const caret = ta.selectionStart;
    const mention = row.mention || `@${rowTitle(row)} (${row.key})`;
    ta.value = `${ta.value.slice(0, mentionStart)}${mention} ${ta.value.slice(caret)}`;
    const c = mentionStart + mention.length + 1;
    ta.focus();
    ta.setSelectionRange(c, c);
    afterChange();
  }

  function detectPopovers() {
    const v = ta.value;
    const caret = ta.selectionStart ?? v.length;
    if (features && v.startsWith('/') && !/\s/.test(v.slice(0, caret))) {
      showSlash();
      return;
    }
    const before = v.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@()]{0,40})$/);
    if (m) {
      mentionStart = caret - m[1].length - 1;
      if (mode !== 'mention') {
        mode = 'mention';
        pop.show([], '');
      }
      mentionQuery(m[1]);
      return;
    }
    if (pop.open) pop.close();
  }

  // ---------------------------------------------------------------- input / keys
  function afterChange() {
    autosize(ta, maxLines());
    saveDraft();
    renderButtons();
  }

  function onInput() {
    afterChange();
    detectPopovers();
  }

  ta.addEventListener('input', onInput);
  ta.addEventListener('click', () => { if (pop.open || ta.value.includes('@')) detectPopovers(); });
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) pop.close(); }, 150));
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (pop.open && pop.key(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape' && running && !ta.value) {
      e.preventDefault();
      o.interrupt();
      toast('중단했어요');
      return;
    }
    if (e.key === 'ArrowUp' && !ta.value) {
      const last = o.lastPrompt();
      if (last) {
        e.preventDefault();
        ta.value = last;
        afterChange();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && desktopKeys()) {
      e.preventDefault();
      submit('queue');
    }
  });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !disabled) { e.preventDefault(); addFiles(files); }
  });

  // ---------------------------------------------------------------- send
  let sending = false;
  function onPrimary() {
    if (running && !hasContent()) { o.interrupt(); return; }
    submit('queue');
  }

  async function submit(sendMode) {
    if (disabled || sending) return;
    if (atts.some((a) => a.state === 'uploading')) { toast('첨부 파일을 올리는 중이에요'); return; }
    const text = ta.value.trim();
    const ready = atts.filter((a) => a.state === 'ready');
    if (!text && !ready.length) return;
    if (features && SLASH_RE.test(text) && !ready.length) {
      ta.value = '';
      afterChange();
      pop.close();
      o.slash(text);
      return;
    }
    sending = true;
    pop.close();
    const prev = ta.value;
    ta.value = '';
    afterChange();
    const attSnapshot = atts.splice(0, atts.length);
    renderAtts();
    let ok = false;
    try {
      ok = await o.send(text || attSnapshot.map((a) => a.name).join(', '), sendMode, attSnapshot.map((a) => ({ name: a.name })));
    } finally {
      sending = false;
    }
    if (!ok && !ta.value) {
      ta.value = prev;
      afterChange();
    } else {
      ls.set(draftKey, null);
    }
    if (desktopKeys()) ta.focus();
  }

  requestAnimationFrame(() => autosize(ta, maxLines()));
  renderButtons();

  return {
    el,
    textarea: ta,
    setRunning,
    setDisabled,
    setFeatures,
    setMeta,
    setQueue,
    focus: () => ta.focus({ preventScroll: true }),
    insertText: (t) => { ta.focus(); insertAtCaret(t); },
    setText: (t) => { ta.value = t; afterChange(); },
    get value() { return ta.value; },
    invalidateCatalog: () => { catalogNorm = null; },
    destroy: () => {
      saveDraft.flush();
      mentionQuery.cancel();
      pop.destroy();
      for (const a of atts) if (a.state === 'uploading') a.abort?.();
    },
  };
}
