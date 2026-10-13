// Settings index (spec §3.6): 노드 · 에이전트 · 머신 · 앱 · 계정, with the hub version footer.

import { bus, state } from '../../store.js';
import { h, relTime, enc, fill } from '../../util.js';
import { listRow, sectionHeader, group } from '../../ui/controls.js';
import { confirmDialog } from '../../ui/dialog.js';
import { page } from './common.js';
import { icon } from '../../ui/icons.js';

/** @param {HTMLElement} root @param {{logout:()=>void}} o */
export function mountSettings(root, o) {
  const p = page({ title: '설정', backTo: '#/', root: true });
  fill(root, p.el);

  function render() {
    const nodes = state.nodes.map((n) => listRow({
      title: n.display_name || n.node_id,
      sub: n.online
        ? `온라인${n.hermes?.version ? ` · Hermes v${n.hermes.version}` : ''}`
        : `오프라인${n.last_seen ? ` · ${relTime(n.last_seen)}` : ''}`,
      lead: h('span', { class: `status-dot ${n.online ? 'on' : 'off'}`, 'aria-hidden': 'true' }),
      href: `#/settings/nodes/${enc(n.node_id)}`,
    }));
    const connected = state.conn === 'open';
    fill(p.body,
      sectionHeader('노드'),
      group(nodes.length ? nodes : [h('p', { class: 'group-empty', text: '아직 연결된 머신이 없어요' })]),
      sectionHeader('에이전트'),
      group([
        listRow({ title: '예약 작업', lead: icon('calendar', 20, 'lr-lead'), href: '#/settings/cron' }),
        listRow({ title: '스킬', lead: icon('book', 20, 'lr-lead'), href: '#/settings/skills' }),
        listRow({ title: '메모리', lead: icon('brain', 20, 'lr-lead'), href: '#/settings/memory' }),
      ]),
      sectionHeader('머신'),
      group([listRow({ title: '머신 추가', lead: icon('plus', 20, 'lr-lead'), href: '#/settings/join' })]),
      sectionHeader('앱'),
      group([listRow({ title: '앱', sub: '테마, Android 앱', lead: icon('phone', 20, 'lr-lead'), href: '#/settings/app' })]),
      sectionHeader('계정'),
      group([listRow({
        title: '로그아웃', lead: icon('logout', 20, 'lr-lead'), danger: true, chevron: false,
        onClick: async () => {
          if (await confirmDialog({ title: '로그아웃할까요?', ok: '로그아웃', danger: true })) o.logout();
        },
      })]),
      h('p', { class: 'settings-foot', text: `hub ${state.hubVersion ? `v${state.hubVersion}` : ''}${state.user ? ` · ${state.user}` : ''} · ${connected ? '연결됨' : '연결 중'}`.replace(/^hub  · /, 'hub · ') }),
    );
  }

  const offs = [bus.on('nodes', render), bus.on('conn', render)];
  render();
  if (!state.hubVersion) {
    fetch('/healthz', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (j?.version) { state.hubVersion = j.version; render(); } }).catch(() => {});
  }
  return { destroy: () => offs.forEach((f) => f()) };
}

