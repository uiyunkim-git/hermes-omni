// Keyboard-navigable list popover shown above the composer (slash palette, @mention picker).
// Rows are 44px+; ↑/↓ move, Enter/Tab pick, Esc closes. Registers on the layer stack so the
// Android back button closes it first.

import { h, fill, add } from '../util.js';
import { pushLayer } from '../ui/layer.js';

/**
 * @param {HTMLElement} host  positioned container (the composer); the popover sits above it
 * @param {{label:string, onPick:(item:any)=>void, onClose?:()=>void}} o
 */
export function createListPopover(host, { label, onPick, onClose }) {
  const list = h('div', { class: 'pop-list', role: 'listbox', 'aria-label': label });
  const el = h('div', { class: 'pop', hidden: true }, list);
  add(host, el);
  let items = [];       // selectable items (rows with .item)
  let rows = [];        // their elements
  let active = -1;
  let release = null;

  const setActive = (i) => {
    if (!rows.length) { active = -1; return; }
    active = (i + rows.length) % rows.length;
    rows.forEach((r, k) => r.setAttribute('aria-selected', k === active ? 'true' : 'false'));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  };

  const api = {
    el,
    get open() { return !el.hidden; },
    /**
     * entries: Array<{section:string} | {item:any, title:string, sub?:string, mono?:boolean} | {node:Node}>
     */
    show(entries, emptyText) {
      fill(list);
      items = [];
      rows = [];
      for (const e of entries) {
        if (e.section) { add(list, h('div', { class: 'pop-section', text: e.section })); continue; }
        if (e.node) { add(list, e.node); continue; }
        const idx = items.length;
        const row = h('div', {
          class: `pop-row${e.mono ? ' pop-mono' : ''}`, role: 'option', 'aria-selected': 'false',
          onpointerdown: (ev) => ev.preventDefault(),   // keep textarea focus
          onclick: () => onPick(items[idx]),
        }, h('span', { class: 'pop-title', text: e.title }), e.sub ? h('span', { class: 'pop-sub', text: e.sub }) : null);
        items.push(e.item);
        rows.push(row);
        add(list, row);
      }
      if (!items.length && emptyText) add(list, h('div', { class: 'pop-empty', text: emptyText }));
      if (el.hidden) {
        el.hidden = false;
        release = pushLayer(() => api.close());
      }
      setActive(0);
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      release?.();
      release = null;
      onClose?.();
    },
    /** Returns true if the key was handled. */
    key(e) {
      if (el.hidden) return false;
      if (e.key === 'ArrowDown') { setActive(active + 1); return true; }
      if (e.key === 'ArrowUp') { setActive(active - 1); return true; }
      if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && items[active] !== undefined) { onPick(items[active]); return true; }
      if (e.key === 'Escape') { api.close(); return true; }
      return false;
    },
    destroy() { api.close(); el.remove(); },
  };
  return api;
}
