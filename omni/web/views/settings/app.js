// 앱 (spec §3.6): theme, app version, Android APK download/update, hub URL (APK only).

import { api } from '../../api.js';
import { h, bridge, isApk, ls, fill, add } from '../../util.js';
import { segmented, kvRow, sectionHeader, group, loadingLine } from '../../ui/controls.js';
import { applyTheme } from '../../theme.js';
import { page } from './common.js';

export function mountAppSettings(root) {
  const p = page({ title: '앱' });
  fill(root, p.el);
  const theme = segmented({
    label: '테마', value: ls.get('omni.theme', 'system'),
    options: [{ value: 'system', label: '시스템' }, { value: 'light', label: '라이트' }, { value: 'dark', label: '다크' }],
    onChange: (v) => { ls.set('omni.theme', v === 'system' ? null : v); applyTheme(); },
  });
  const apkVer = isApk() ? (bridge('appVersion') || '–') : '브라우저';
  const apkBox = h('div', {}, loadingLine());
  add(p.body,
    sectionHeader('화면'),
    group([h('div', { class: 'list-row' }, h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '테마' })), theme)]),
    sectionHeader('앱'),
    group([kvRow('앱 버전', apkVer), apkBox]),
    isApk() ? group([h('button', { type: 'button', class: 'list-row tappable', onclick: () => bridge('changeHubUrl') },
      h('span', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '허브 주소 변경' })))]) : null,
  );

  api.app().then((a) => {
    if (!a?.available) { fill(apkBox, kvRow('Android 앱', '아직 빌드되지 않았어요')); return; }
    const size = Number.isFinite(a.size) ? ` · ${(a.size / 1048576).toFixed(1)}MB` : '';
    const code = Number(bridge('appVersionCode')) || 0;
    const newer = isApk() && Number(a.version_code) > code;
    fill(apkBox, h('div', { class: 'list-row' },
      h('span', { class: 'lr-text' },
        h('span', { class: 'lr-title', text: 'Android 앱' }),
        h('span', { class: 'lr-sub', text: newer ? `새 버전이 있어요 · v${a.version_name}${size}` : `v${a.version_name || '?'}${size}` })),
      h('a', { class: `btn ${newer ? 'btn-primary' : 'btn-secondary'} btn-sm`, href: a.url || '/app/hermes-omni.apk', download: 'hermes-omni.apk' },
        h('span', { text: newer ? '업데이트' : 'APK 다운로드' }))));
  }).catch(() => fill(apkBox, kvRow('Android 앱', '정보를 불러오지 못했어요')));
  return { destroy() {} };
}

