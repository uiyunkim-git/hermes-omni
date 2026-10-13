// 머신 추가 (spec §3.6): the one-line join command, with copy, and the env preview.

import { api, errorText } from '../../api.js';
import { h, copyText, fill, add } from '../../util.js';
import { icon } from '../../ui/icons.js';
import { loadingLine, errorLine, button } from '../../ui/controls.js';
import { toast } from '../../ui/toast.js';
import { page } from './common.js';

export function mountJoin(root) {
  const p = page({ title: '머신 추가' });
  fill(root, p.el);
  const body = h('div', { class: 'join' }, loadingLine());
  add(p.body, h('p', { class: 'lead', text: '다른 머신을 이 허브에 연결해요. 그 머신도 같은 tailnet에 있어야 해요.' }), body);

  async function load() {
    fill(body, loadingLine());
    try {
      const j = await api.join();
      const cmd = h('pre', { class: 'join-cmd', text: j.command });
      const copy = async () => toast((await copyText(j.command)) ? '복사했어요' : '복사하지 못했어요 · 길게 눌러 직접 복사하세요');
      // Copy lives in the block's header row and as the step's primary button below it, never
      // over the command text.
      const box = h('div', { class: 'code-block join-box' },
        h('div', { class: 'code-head' }, h('span', { class: 'code-lang', text: 'bash' }),
          h('button', { type: 'button', class: 'code-copy', onclick: copy }, icon('copy', 14), h('span', { text: '복사' }))),
        h('div', { class: 'code-body' }, cmd));
      const copyBtn = button('명령 복사', { variant: 'primary', icon: 'copy', cls: 'join-copy', onClick: copy });
      const details = h('details', { class: 'join-details' },
        h('summary', {}, icon('chevron-right', 16, 'det-chev'), h('span', { text: '직접 설정하기' })),
        h('pre', { class: 'join-env', text: (j.env_preview || []).join('\n') }),
        h('p', { class: 'caption', text: `허브 주소: ${j.hub_url}` }));
      fill(body,
        h('ol', { class: 'steps' },
          h('li', {}, h('span', { text: '새 머신에서 설치할 상위 폴더로 이동하세요 (예: ~/).' })),
          h('li', {}, h('span', { text: '아래 명령을 복사해 붙여 넣으세요.' }),
            box,
            h('p', { class: 'caption', text: '명령에 가입 토큰과 LLM 설정이 들어 있어요. 다른 사람과 공유하지 마세요.' }),
            j.warning ? h('p', { class: 'caption warn', text: '허브 공개 주소(OMNI_PUBLIC_URL)가 설정되지 않아 지금 접속한 주소를 썼어요.' }) : null,
            h('div', { class: 'join-actions' }, copyBtn)),
          h('li', {}, h('span', { text: '1–2분 뒤 설정 › 노드에 새 머신이 나타나요.' }))),
        details);
    } catch (err) {
      fill(body, errorLine(errorText(err, '가입 정보를 불러오지 못했어요'), load));
    }
  }
  load();
  return { destroy() {} };
}
