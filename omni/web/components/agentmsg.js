// Agent-to-agent message bubbles: user rows carrying an ⟦omni:<delivery_id>⟧ marker (written by
// omni.proto.format_request_text / format_reply_text) are shown with sender + delivery badges.

import { h, enc, shortTime } from '../util.js';
import { markdownBlock } from './markdown.js';

// Keep in sync with omni/proto.py MARKER_RE.
export const MARKER_RE = /⟦omni:([A-Za-z0-9_-]{6,64})⟧/;
const HEADER_RE = /^\s*⟦omni:([A-Za-z0-9_-]{6,64})⟧\s*(Message|Reply) from (.+?)(?: to your message (\S+))? \(via hermes-omni\)[^\n]*(?:\n|$)/;

/** @returns {null | {deliveryId:string, kind:'message'|'reply'|'unknown', from:string|null, origId:string|null, body:string, tail:string}} */
export function parseOmni(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(MARKER_RE);
  if (!m) return null;
  const hm = content.match(HEADER_RE);
  if (!hm) {
    return { deliveryId: m[1], kind: 'unknown', from: null, origId: null, body: content.replace(MARKER_RE, '').trim(), tail: '' };
  }
  let rest = content.slice(hm[0].length).replace(/^\s+/, '');
  let tail = '';
  const tailIdx = rest.lastIndexOf('\n\n— ');
  if (tailIdx >= 0) {
    tail = rest.slice(tailIdx + 2).trim();
    rest = rest.slice(0, tailIdx);
  }
  return {
    deliveryId: hm[1],
    kind: hm[2] === 'Reply' ? 'reply' : 'message',
    from: hm[3].trim(),
    origId: hm[4] || null,
    body: rest.trim(),
    tail,
  };
}

export function agentBubble(parsed, timestamp) {
  const from = parsed.from;
  const meta = h('div', { class: 'agent-meta' },
    h('span', { class: 'badge badge-agent', title: 'Agent message' }, parsed.kind === 'reply' ? '↩ Reply' : '✉ Message'),
    from ? h('a', { class: 'badge badge-addr', href: `#/messages?address=${enc(from)}`, title: 'Show messages for this address' }, from) : null,
    h('span', { class: 'badge badge-id mono', title: 'Delivery id' }, parsed.deliveryId),
    parsed.origId ? h('span', { class: 'muted small', text: `re ${parsed.origId}` }) : null,
    timestamp ? h('time', { class: 'muted small', text: shortTime(timestamp) }) : null);
  return h('div', { class: 'row row-agent' },
    h('div', { class: 'bubble bubble-agent' },
      meta,
      markdownBlock(parsed.body || '(empty)'),
      parsed.tail ? h('p', { class: 'agent-tail muted small', text: parsed.tail }) : null));
}
