// Markdown → sanitized DOM via the vendored marked + DOMPurify (spec §4.5). Code blocks get a
// header (language + copy), diff blocks get line backgrounds, tables scroll inside a wrapper,
// links open externally. Images are limited to same-origin/data URLs (no external requests).

import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';
import { h, copyText, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    const href = node.getAttribute('href') || '';
    if (!href.startsWith('#')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (!/^(data:image\/|\/(?!\/))/i.test(src)) {
      node.removeAttribute('src');
      node.setAttribute('alt', `[이미지: ${node.getAttribute('alt') || src}]`);
    }
  }
});

const PURIFY_OPTS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
  FORBID_ATTR: ['style'],
};

/** Very long texts are rendered as plain text: parsing megabytes per frame would stall the UI. */
const MAX_MD_CHARS = 200000;

export function renderMarkdown(el, text) {
  const src = typeof text === 'string' ? text : '';
  if (src.length > MAX_MD_CHARS) {
    el.classList.add('plain');
    el.textContent = src;
    return el;
  }
  el.classList.remove('plain');
  let html;
  try {
    html = marked.parse(src);
  } catch {
    el.textContent = src;
    return el;
  }
  el.innerHTML = DOMPurify.sanitize(html, PURIFY_OPTS);
  enhance(el);
  return el;
}

export function markdownBlock(text, cls = '') {
  const el = document.createElement('div');
  el.className = `md ${cls}`.trim();
  return renderMarkdown(el, text);
}

function looksLikeDiff(text) {
  const lines = text.split('\n');
  if (lines.some((l) => l.startsWith('@@ '))) return true;
  if (lines.some((l) => l.startsWith('+++ ')) && lines.some((l) => l.startsWith('--- '))) return true;
  return false;
}

function enhance(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('code-body')) continue;
    const code = pre.querySelector('code');
    const cls = code?.className || '';
    const lang = (cls.match(/language-([\w+#.-]+)/) || [])[1] || '';
    const text = (code || pre).textContent.replace(/\n$/, '');
    const isDiff = lang === 'diff' || lang === 'patch' || looksLikeDiff(text);
    if (isDiff) {
      const target = code || pre;
      fill(target, ...text.split('\n').map((line) => {
        const c = line.startsWith('+') && !line.startsWith('+++') ? 'dl-add'
          : line.startsWith('-') && !line.startsWith('---') ? 'dl-del'
            : line.startsWith('@@') ? 'dl-hunk' : '';
        return h('span', { class: `dl ${c}`.trim(), text: `${line}\n` });
      }));
    }
    const copyBtn = h('button', { type: 'button', class: 'code-copy', 'aria-label': '코드 복사' }, icon('copy', 14), h('span', { text: '복사' }));
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(text);
      const label = copyBtn.querySelector('span');
      label.textContent = ok ? '복사됨' : '복사 실패';
      setTimeout(() => { label.textContent = '복사'; }, 1500);
    });
    const block = h('div', { class: `code-block${isDiff ? ' is-diff' : ''}` },
      h('div', { class: 'code-head' }, h('span', { class: 'code-lang', text: lang || (isDiff ? 'diff' : '') }), copyBtn),
      h('div', { class: 'code-body' }));
    pre.replaceWith(block);
    block.querySelector('.code-body').append(pre);
  }
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('table-wrap')) continue;
    const wrap = h('div', { class: 'table-wrap' });
    table.replaceWith(wrap);
    add(wrap, table);
  }
}
