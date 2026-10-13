// Inter-agent turns (spec §3.4.2): outgoing (a hub_send call), incoming request and reply cards.
// One bordered card per message: header with a link glyph (tap → peer session), status on the
// right, markdown body clamped to 8 lines, and the peer's node · folder as footer.

import { h, parseJsonMaybe, sessionHref, josaWa } from '../util.js';
import { icon } from '../ui/icons.js';
import { spinner } from '../ui/controls.js';
import { getSession, folderLabel, nodeName } from '../store.js';
import { markdownBlock } from './markdown.js';

const REASON_KO = {
  ambiguous_target: '같은 이름의 세션이 여러 개예요',
  unknown_target: '대상 세션을 찾지 못했어요',
  self: '자기 자신에게는 보낼 수 없어요',
  hop_limit: '연쇄 한도를 넘었어요',
  collab_limit: '대화 한도에 도달했어요',
  offline_queued: '노드가 오프라인이라 연결되면 전달돼요',
};

export const reasonText = (r) => REASON_KO[r] || r || '';

const ADDR_RE = /^([A-Za-z0-9_.-]+)(?:\/[^#\s]+)?#([A-Za-z0-9_.:-]+)$/;

/** "node#sid" (optionally "@", "omni:" or a trailing " (node#sid)") → {node, sid} | null */
export function parseAddress(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim().replace(/^@/, '').replace(/^omni:/, '');
  const paren = t.match(/\(([^()\s]+#[^()\s]+)\)\s*$/);
  if (paren) t = paren[1];
  const m = t.match(ADDR_RE);
  return m ? { node: m[1], sid: m[2] } : null;
}

function peerFooter(addr) {
  if (!addr) return null;
  const row = getSession(addr.node, addr.sid);
  const parts = [row?.node_name || nodeName(addr.node), row ? folderLabel(row) : null].filter(Boolean);
  return parts.join(' · ');
}

/**
 * @param {{kind:'out'|'in'|'reply', header:string, status?:string, busy?:boolean,
 *          body:string, peer?:{node:string,sid:string}|null, tone?:string}} o
 */
export function agentCard(o) {
  const href = o.peer ? sessionHref(o.peer.node, o.peer.sid) : null;
  const headInner = [
    icon('link', 16, 'ac-icon'),
    h('span', { class: 'ac-title', text: o.header }),
    h('span', { class: `ac-status${o.tone ? ` ${o.tone}` : ''}` }, o.busy ? spinner(10) : null, o.status ? h('span', { text: o.status }) : null),
  ];
  const head = href
    ? h('a', { class: 'ac-head', href, title: '상대 세션 열기' }, headInner)
    : h('div', { class: 'ac-head' }, headInner);
  const body = markdownBlock(o.body || '', 'ac-body clamp');
  const more = h('button', { type: 'button', class: 'btn-link ac-more', hidden: true, text: '더 보기' });
  more.addEventListener('click', () => {
    const open = body.classList.toggle('clamp');
    more.textContent = open ? '더 보기' : '접기';
  });
  const foot = o.peer ? peerFooter(o.peer) : null;
  const card = h('div', { class: `agent-card ac-${o.kind}` }, head, body, more,
    foot ? h('div', { class: 'ac-foot', text: foot }) : null);
  // Show "더 보기" only when the clamp actually cuts text: the body must have reached its
  // max-height (glyph and inline-code overflow make scrollHeight exceed a short body by a few px).
  requestAnimationFrame(() => {
    const limit = parseFloat(getComputedStyle(body).maxHeight);
    if (Number.isFinite(limit) && body.clientHeight >= limit - 1 && body.scrollHeight > body.clientHeight + 4) more.hidden = false;
  });
  return card;
}

/** Outgoing card from a hub_send call (live or history). `hasReplyFrom(addr,title)` checks later cards. */
export function outgoingCard(args, result, { running = false, hasReply = false } = {}) {
  const a = typeof args === 'object' && args ? args : parseJsonMaybe(args) || {};
  const r = parseJsonMaybe(result) || (result && typeof result === 'object' ? result : null) || {};
  const to = typeof a.to === 'string' ? a.to : '';
  const addr = parseAddress(r.to_address || '') || parseAddress(to);
  const row = addr ? getSession(addr.node, addr.sid) : null;
  const toTitle = r.to_title || row?.title || (addr ? to : to) || '다른 세션';
  let status = '';
  let busy = false;
  let tone = '';
  const st = r.status;
  if (running && !st) { status = '보내는 중'; busy = true; }
  else if (st === 'queued' || st === 'dispatched') {
    if (r.reason === 'offline_queued') { status = reasonText('offline_queued'); }
    else if (hasReply || r.reply) status = '답장 받음';
    else { status = (a.expect_reply === false || a.wait === false) ? '전달됨' : '전달됨 · 답장 대기 중'; busy = !(a.expect_reply === false || a.wait === false); }
  } else if (st === 'done' || st === 'delivered' || st === 'replied') status = r.reply || hasReply ? '답장 받음' : '전달됨';
  else if (st === 'rejected') { status = `보내지 못함: ${reasonText(r.reason)}`; tone = 'danger'; }
  else if (st === 'timeout') { status = '응답 시간 초과'; tone = 'danger'; }
  else if (st === 'error' || r.error) { status = '오류'; tone = 'danger'; }
  else if (!running) status = '전달됨';
  const message = typeof a.message === 'string' ? a.message : '';
  return agentCard({ kind: 'out', header: `${toTitle}에게 보냄`, status, busy, tone, body: message, peer: addr });
}

/** Incoming request / reply card from a history row's `omni` or a live session.incoming delivery. */
export function incomingCard({ kind, fromAddr, fromTitle, body, expectReply }) {
  const addr = parseAddress(fromAddr || '');
  const row = addr ? getSession(addr.node, addr.sid) : null;
  const title = fromTitle || row?.title || fromAddr || '다른 세션';
  if (kind === 'reply') {
    return agentCard({ kind: 'reply', header: `${title}의 답장`, body, peer: addr });
  }
  return agentCard({ kind: 'in', header: `${title} 세션에서 온 요청`, status: expectReply ? '답장 자동 전달' : '', body, peer: addr });
}

/** "<peer>와 대화 중" with the right particle. */
export function collabText(peerTitle) {
  return `${peerTitle}${josaWa(peerTitle)} 대화 중`;
}
