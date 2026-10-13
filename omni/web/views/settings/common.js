// Shared bits for settings pages: the page frame (app bar + scroll body) and node chips.

import { state } from '../../store.js';
import { h, isDesktop } from '../../util.js';
import { appBar, iconButton } from '../../ui/controls.js';
import { back } from '../../router.js';

/**
 * Standard settings page: back button (mobile always; desktop only for sub-pages), title,
 * optional subtitle and right-side actions. Returns {el, body, setTitle}.
 */
export function page({ title, subtitle, right = [], backTo = '#/settings', root = false } = {}) {
  const showBack = !root || !isDesktop();
  const bar = appBar({
    left: showBack ? [iconButton('chevron-left', '뒤로', () => back(backTo), { cls: 'back-btn' })] : [],
    title, subtitle, right,
  });
  const body = h('div', { class: 'page-body' });
  const el = h('section', { class: 'page' }, bar, h('div', { class: 'page-scroll' }, body));
  return {
    el, body,
    setTitle(t, sub) {
      bar.querySelector('.appbar-t1').textContent = t;
      let t2 = bar.querySelector('.appbar-t2');
      // The subtitle may arrive later than the page (e.g. the node's hostname).
      if (!t2 && sub) {
        t2 = h('span', { class: 'appbar-t2' });
        bar.querySelector('.appbar-title')?.append(t2);
      }
      if (t2) {
        t2.textContent = sub || '';
        t2.hidden = !sub;
      }
    },
  };
}

/** Single-select chips for online nodes (offline ones disabled). */
export function nodeChips(selected, onPick) {
  return state.nodes.map((n) => h('button', {
    type: 'button', class: `chip${n.node_id === selected ? ' on' : ''}`, disabled: !n.online,
    'aria-pressed': n.node_id === selected ? 'true' : 'false', onclick: () => onPick(n.node_id),
  }, h('span', { class: `chip-dot ${n.online ? 'on' : 'off'}`, 'aria-hidden': 'true' }), h('span', { text: n.display_name || n.node_id })));
}
