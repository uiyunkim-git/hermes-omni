// Markdown → sanitized DOM via the vendored marked + DOMPurify. All agent/user text goes through
// here; links open in a new tab with rel=noopener, and images are restricted to same-origin/data.

import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // No external network requests from rendered content (privacy + offline tailnet use).
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (!/^(data:image\/|\/(?!\/))/i.test(src)) {
      node.removeAttribute('src');
      node.setAttribute('alt', `[image: ${node.getAttribute('alt') || src}]`);
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
  return el;
}

export function markdownBlock(text, cls = '') {
  const el = document.createElement('div');
  el.className = `md ${cls}`.trim();
  return renderMarkdown(el, text);
}
