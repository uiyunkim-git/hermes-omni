// #/join — how to add a machine (join command with copy), Android app download, account.

import { api } from '../api.js';
import { state } from '../store.js';
import { h, clear, copyText, formatBytes, loading, absTime } from '../util.js';
import { toast } from '../components/toast.js';

function copyBlock(text, label) {
  const pre = h('pre', { class: 'code copy-src', tabindex: '0', 'aria-label': label, text });
  const btn = h('button', {
    type: 'button', class: 'btn btn-sm copy-btn', 'aria-label': `Copy ${label}`,
    onclick: async () => {
      const ok = await copyText(text, pre);
      if (ok) {
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
      } else {
        toast('Copy blocked by the browser — the text is selected, copy it manually.', 'info', 5000);
      }
    },
  }, 'Copy');
  return h('div', { class: 'copy-wrap' }, btn, pre);
}

export default function joinView(main, ctx) {
  ctx.setTitle('Join');
  let alive = true;
  const joinBox = h('section', { class: 'card', 'aria-labelledby': 'join-h' }, h('h2', { id: 'join-h', class: 'h2', text: 'Add a machine' }), loading());
  const apkBox = h('section', { class: 'card', 'aria-labelledby': 'apk-h' }, h('h2', { id: 'apk-h', class: 'h2', text: 'Android app' }), loading());
  const account = h('section', { class: 'card account', 'aria-label': 'Account' },
    h('span', { class: 'muted' }, 'Signed in as ', h('strong', { text: (typeof state.user === 'string' ? state.user : state.user?.username || state.user?.name) || 'admin' })),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => ctx.logout() }, 'Log out'));

  main.append(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', { class: 'h1', text: 'Join' })),
    joinBox, apkBox, account));

  api.join().then((j) => {
    if (!alive) return;
    const head = joinBox.firstChild;
    clear(joinBox).append(head,
      h('ol', { class: 'steps' },
        h('li', {}, 'On the new machine install Docker (and the NVIDIA container toolkit if it has GPUs) and git.'),
        h('li', {}, 'In the folder where the repository should go, run the command below. It clones hermes-omni into ', h('code', { text: 'hermes-omni/' }), ' (that folder must not exist yet), writes its ', h('code', { text: '.env' }), ', points the node at this hub and starts Hermes, the link and Tailscale.'),
        h('li', {}, 'Within a minute the machine appears under ', h('a', { href: '#/' }, 'Nodes'), '. Add project folders later with ', h('code', { text: 'PROJECT_ROOTS' }), ' in its ', h('code', { text: '.env' }), '.')),
      ...(j.warning ? [h('p', { class: 'warn-text small', role: 'note', text: `Warning: ${j.warning}. Check the hub URL under Details before using the command.` })] : []),
      copyBlock(j.command || '', 'join command'),
      h('p', { class: 'warn-text small', text: 'The command contains secrets (LLM key, dashboard password, Tailscale key). Only paste it on machines you trust.' }),
      h('details', { class: 'more-info' },
        h('summary', { class: 'small', text: 'Details' }),
        h('p', { class: 'small' }, 'Hub URL: ', h('code', { text: j.hub_url || '' })),
        Array.isArray(j.env_preview) && j.env_preview.length
          ? [h('p', { class: 'small muted', text: 'Settings copied into the new machine’s .env (only where empty):' }),
            h('ul', { class: 'env-list mono small' }, j.env_preview.map((e) => h('li', { text: e })))]
          : null,
        j.blob ? [h('p', { class: 'small muted', text: 'Join blob only (for ./setup.sh --join <blob>):' }), copyBlock(j.blob, 'join blob')] : null));
  }).catch((err) => {
    if (!alive) return;
    joinBox.lastChild.replaceWith(h('p', { class: 'warn-text', text: `Could not load join info: ${err.message}` }));
  });

  api.app().then((a) => {
    if (!alive) return;
    const head = apkBox.firstChild;
    clear(apkBox).append(head);
    if (!a.available) {
      apkBox.append(h('p', { class: 'muted', text: 'No APK has been built yet. Run scripts/build-apk.sh on the hub machine.' }));
      return;
    }
    apkBox.append(
      h('p', {}, 'A thin app around this page: keeps you signed in and opens straight to the hub.'),
      h('a', { class: 'btn btn-primary btn-block', href: a.url || '/app/hermes-omni.apk', download: 'hermes-omni.apk' },
        `Download APK${a.version_name ? ` ${a.version_name}` : ''}`),
      h('dl', { class: 'kv small' },
        a.version_code ? [h('dt', { text: 'Version' }), h('dd', { text: `${a.version_name || ''} (${a.version_code})` })] : null,
        a.size ? [h('dt', { text: 'Size' }), h('dd', { text: formatBytes(a.size) })] : null,
        a.built_at ? [h('dt', { text: 'Built' }), h('dd', { text: absTime(a.built_at) })] : null,
        a.sha256 ? [h('dt', { text: 'SHA-256' }), h('dd', { class: 'mono wrap', text: a.sha256 })] : null),
      h('p', { class: 'muted small', text: 'Android may ask you to allow installs from this browser. Updates install over the old version.' }));
  }).catch((err) => {
    if (!alive) return;
    apkBox.lastChild.replaceWith(h('p', { class: 'warn-text', text: `Could not load app info: ${err.message}` }));
  });

  return () => { alive = false; };
}
