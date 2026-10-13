// New-session sheet (spec §3.3): node, optional folder, optional first message and title.
// Nothing is requested until 시작; then the chat opens (replacing #/new in history).

import { api, errorText } from '../api.js';
import { state, bus, onlineNodes, upsertSessions } from '../store.js';
import { navigate } from '../router.js';
import { h, ls, sessionHref, nextId, fill, add } from '../util.js';
import { createSheet } from '../ui/sheet.js';
import { button, spinner } from '../ui/controls.js';
import { createFolderPicker } from './folderpicker.js';

const NODE_KEY = 'omni.new.node';

/** @param {{onRequestClose:()=>void}} o */
export function openNewSession(o) {
  const start = button('시작', { variant: 'primary', type: 'submit', cls: 'btn-block' });
  const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const footer = h('div', { class: 'ns-foot' }, err, start);
  const sheet = createSheet({ title: '새 세션', desktop: 'dialog', width: 560, onRequestClose: o.onRequestClose, footer, cls: 'new-sheet', layer: false });
  let node = null;
  let busy = false;

  const nodeSec = h('div', { class: 'field' });
  const picker = createFolderPicker({ node: null, value: null });
  const text = h('textarea', { class: 'input', rows: 3, id: nextId('ns'), placeholder: '무엇을 할까요? (비워 두고 시작해도 돼요)', 'aria-label': '첫 메시지' });
  const titleInput = h('input', { class: 'input', maxLength: 200, placeholder: '자동으로 정해져요', 'aria-label': '제목', hidden: true });
  const titleToggle = h('button', {
    type: 'button', class: 'btn-text', text: '제목 지정',
    onclick: () => { titleInput.hidden = false; titleToggle.hidden = true; titleInput.focus(); },
  });

  const folderField = h('div', { class: 'field' }, h('span', { class: 'field-label', text: '폴더' }), picker.el);
  const form = h('form', {
    class: 'ns-form', id: nextId('nsf'),
    onsubmit: (e) => { e.preventDefault(); submit(); },
  },
  h('div', { class: 'field' }, h('label', { class: 'field-label', text: '노드' }), nodeSec),
  folderField,
  h('div', { class: 'field' }, h('label', { class: 'field-label', for: text.id, text: '첫 메시지' }), text),
  h('div', { class: 'field' }, titleToggle, titleInput));
  start.setAttribute('form', form.id);
  add(sheet.body, form);

  function renderNodes() {
    const online = onlineNodes();
    if (!node || !online.some((n) => n.node_id === node)) {
      const pref = ls.get(NODE_KEY, '');
      node = online.find((n) => n.node_id === pref)?.node_id || online[0]?.node_id || null;
      picker.setNode(node);
    }
    if (!state.nodes.length) {
      fill(nodeSec, h('p', { class: 'field-note', text: '연결된 머신이 없어요. 설정 › 머신 추가에서 연결하세요.' }));
    } else if (online.length === 1 && state.nodes.length === 1) {
      const n = online[0];
      fill(nodeSec, h('div', { class: 'ns-static' },
        h('span', { class: 'lr-title', text: n.display_name || n.node_id }),
        h('span', { class: 'lr-sub', text: [n.hostname, n.hermes?.version ? `Hermes v${n.hermes.version}` : null].filter(Boolean).join(' · ') })));
    } else {
      const name = nextId('node');
      fill(nodeSec, h('div', { class: 'radio-list', role: 'radiogroup', 'aria-label': '노드' }, state.nodes.map((n) => {
        const input = h('input', {
          type: 'radio', name, value: n.node_id, checked: n.node_id === node, disabled: !n.online,
          onchange: () => { node = n.node_id; picker.setNode(node); renderStart(); },
        });
        return h('label', { class: `radio-row${n.online ? '' : ' disabled'}` }, input,
          h('span', { class: 'lr-text' },
            h('span', { class: 'lr-title', text: n.display_name || n.node_id }),
            h('span', { class: 'lr-sub', text: n.online ? [n.hostname, n.hermes?.version ? `Hermes v${n.hermes.version}` : null].filter(Boolean).join(' · ') : '오프라인' })));
      })));
    }
    renderStart();
  }

  function renderStart() {
    folderField.hidden = !node;
    start.disabled = busy || !node;
    fill(start, busy ? spinner(16, 'on-accent') : h('span', { text: '시작' }));
  }

  async function submit() {
    if (busy || !node) return;
    busy = true;
    err.hidden = true;
    renderStart();
    const body = { folder: picker.value || null };
    const t = titleInput.value.trim();
    if (t) body.title = t;
    const msg = text.value.trim();
    if (msg) body.text = msg;
    try {
      const res = await api.createSession(node, body);
      ls.set(NODE_KEY, node);
      if (res.row) upsertSessions([{ node, ...res.row }]);
      sheet.close();
      navigate(sessionHref(node, res.stored_id), { replace: true });
    } catch (ex) {
      busy = false;
      err.textContent = errorText(ex, '세션을 만들지 못했어요');
      err.hidden = false;
      renderStart();
    }
  }

  const off = bus.on('nodes', renderNodes);
  renderNodes();
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => text.focus({ preventScroll: true }), 60);
  const prevOnClose = sheet.onClose;
  sheet.onClose = () => { off(); prevOnClose?.(); };
  return sheet;
}
