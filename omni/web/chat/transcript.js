// Transcript rendering (spec §3.4): turns built from persisted history rows plus the live turn.
// Everything is keyed so re-renders reuse DOM (expanded tool lines, scroll anchoring and
// streaming text stay stable): history turns are cached by a content signature; the live turn
// is updated in place every animation frame.

import {
  h, contentText, copyText, desktopKeys, parseJsonMaybe, fill, add, steerText, isSteerRow, turnNotice,
} from '../util.js';
import { icon } from '../ui/icons.js';
import { spinner } from '../ui/controls.js';
import { renderMarkdown } from './markdown.js';
import {
  createToolLine, createToolGroup, syncChildren, innerCalls, splitInnerResult, looksLikeError, blockedReason,
  HIDDEN_TOOLS, AGENT_TOOLS,
} from './toolline.js';
import { outgoingCard, incomingCard } from './agentcard.js';
import { toast } from '../ui/toast.js';

const GROUP_MIN = 4;
const MENTION_RE = /@[^@\n()]{1,80}? \(([A-Za-z0-9_.-]+#[A-Za-z0-9_.:-]+)\)/g;

// --------------------------------------------------------------------------- segments
//
// A segment is one visual item inside an assistant turn:
//   {kind:'reasoning', key, text, live, secs}
//   {kind:'text', key, text}
//   {kind:'tool', key, tool:{id,name,args,state,duration_s,preview,error,startedAt}}
//   {kind:'agent', key, args, result, running}
//   {kind:'request', key, state:'pending'|'done', record:{ok,text,via?}, afterTool?}
//   {kind:'steer', key, text}                (끼어들기: the user's words delivered mid-turn)
//   {kind:'note', key, tone, text, failed?}  (중단됨 / 취소됨 / Hermes' failed-turn boundary)
//   {kind:'error', key, text, retry}

/** Expand a (possibly Tool-Search-wrapped) call into tool/agent segments. */
export function callSegments(call, keyBase) {
  const inner = innerCalls(call.name, call.args);
  // A wrapper whose payload is not JSON and names no inner tool: still flag it as malformed.
  const broken = !inner && call.name === 'tool_call' && typeof call.args === 'string' && call.args.trim() !== ''
    && !parseJsonMaybe(call.args) && call.state !== 'generating';
  const calls = inner || [{ name: call.name, args: call.args, malformed: broken }];
  const results = inner && call.preview !== undefined ? splitInnerResult(call.preview, inner.length) : null;
  const out = [];
  calls.forEach((c, i) => {
    const key = inner ? `${keyBase}.${i}` : keyBase;
    if (HIDDEN_TOOLS.has(c.name)) return;
    const preview = results ? results[i] : call.preview;
    if (AGENT_TOOLS.has(c.name) && !c.malformed) {
      out.push({ kind: 'agent', key: `a:${key}`, args: c.args, result: preview, running: call.state === 'running' || call.state === 'generating' });
      return;
    }
    out.push({
      kind: 'tool',
      key: `t:${key}`,
      tool: {
        id: key, name: c.name, args: c.args, state: call.state, duration_s: inner ? (i === 0 ? call.duration_s : undefined) : call.duration_s,
        preview, error: call.error, startedAt: call.startedAt, malformed: !!c.malformed,
      },
    });
  });
  return out;
}

/**
 * Build segments for the non-user rows of one persisted turn.
 *
 * A call is "done" only once its tool row is attached. A call without a result is still
 * running (`open`: the turn is in flight) or was cut off (an interrupted turn); it never shows ✓.
 * `skipCall(call)` drops calls the live view already shows (a turn joined mid-way); it sees
 * `state: 'pending'` for calls with no result yet. `skipSeg(key)` drops prose/reasoning segments
 * (`x:<row id>`, `r:<row id>`) the live view repeats.
 * @param {object[]} rows
 * @param {{open?:boolean, skipCall?:(call:object)=>boolean, skipSeg?:(key:string)=>boolean}} [o]
 */
export function historySegments(rows, o = {}) {
  const segs = [];
  const callsById = new Map();
  const pendingByName = [];
  for (const r of rows) {
    if (r.role === 'user') {
      // Only steer rows sit inside a turn (buildTurns): show the user's words where they landed.
      if (!o.skipSeg?.(`s:${r.id}`)) segs.push({ kind: 'steer', key: `s:${r.id}`, text: steerText(contentText(r.content)) ?? contentText(r.content) });
    } else if (r.role === 'assistant') {
      if (typeof r.reasoning === 'string' && r.reasoning.trim() && !o.skipSeg?.(`r:${r.id}`)) segs.push({ kind: 'reasoning', key: `r:${r.id}`, text: r.reasoning, live: false });
      const text = contentText(r.content);
      const notice = turnNotice(text, r.display_kind);
      if (notice) segs.push({ kind: 'note', key: `f:${r.id}`, text: notice.text, failed: true });
      else if (text.trim() && !o.skipSeg?.(`x:${r.id}`)) segs.push({ kind: 'text', key: `x:${r.id}`, text });
      if (Array.isArray(r.tool_calls)) {
        r.tool_calls.forEach((c, i) => {
          const call = {
            id: c.id || `${r.id}.${i}`,
            name: c.function?.name || c.name || 'tool',
            args: c.function?.arguments ?? c.arguments ?? c.args ?? '',
            state: 'pending',
          };
          callsById.set(call.id, call);
          pendingByName.push(call);
          segs.push({ kind: 'call', call });
        });
      }
    } else if (r.role === 'tool') {
      let call = r.tool_call_id ? callsById.get(r.tool_call_id) : null;
      if (!call) call = pendingByName.find((c) => c.preview === undefined && (!r.tool_name || c.name === r.tool_name)) || null;
      if (call) {
        call.preview = r.content;
        call.state = looksLikeError(r.content) ? 'error' : 'done';
      }
    }
  }
  // Expand calls now that results are attached.
  const out = [];
  for (const s of segs) {
    if (s.kind !== 'call') { out.push(s); continue; }
    const c = s.call;
    if (o.skipCall?.(c)) continue;
    if (c.state === 'pending') c.state = o.open ? 'running' : 'unknown';
    out.push(...callSegments(c, c.id));
  }
  return out;
}

/** True when a finished turn's last assistant row says nothing (no text, no calls). */
export function endsEmpty(rows) {
  let at = -1;
  for (let i = 0; i < rows.length; i += 1) if (rows[i].role === 'assistant') at = i;
  if (at < 0) return false;
  const last = rows[at];
  if ((Array.isArray(last.tool_calls) && last.tool_calls.length) || contentText(last.content).trim()) return false;
  // Text earlier in the same step (before the empty closing row) still counts as an answer.
  for (let i = at - 1; i >= 0 && rows[i].role !== 'tool'; i -= 1) {
    if (rows[i].role === 'assistant' && contentText(rows[i].content).trim()) return false;
  }
  return true;
}

export const EMPTY_REPLY = '응답이 비어 있어요';

// --------------------------------------------------------------------------- segment renderer

function reasoningEl() {
  const label = h('span', { class: 'rs-label' });
  const lead = h('span', { class: 'rs-lead' });
  const head = h('button', { type: 'button', class: 'rs-head', 'aria-expanded': 'false' }, lead, label);
  const body = h('div', { class: 'rs-body', hidden: true });
  const el = h('div', { class: 'reasoning' }, head, body);
  let text = '';
  let sig = '';
  head.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.classList.toggle('open', open);
    if (open) body.textContent = text;
  });
  el.update = (s) => {
    text = s.text || '';
    const nsig = s.live ? 'live' : `done:${s.secs || ''}`;
    if (nsig !== sig) {
      sig = nsig;
      fill(lead, s.live ? spinner(10) : icon('chevron-right', 14, 'rs-chev'));
      label.textContent = s.live ? '생각 중…' : (s.secs ? `생각함 · ${Math.max(1, Math.round(s.secs))}초` : '생각함');
    }
    if (!body.hidden) {
      body.textContent = text;
      if (s.live) body.scrollTop = body.scrollHeight;
    }
  };
  return el;
}

function textEl() {
  const el = h('div', { class: 'md prose' });
  let last = null;
  el.update = (s) => {
    if (s.text === last) return;
    last = s.text;
    renderMarkdown(el, s.text);
  };
  return el;
}

function noteEl(s) {
  return h('div', { class: `t-note${s.tone ? ` ${s.tone}` : ''}` }, s.icon ? icon(s.icon, 14) : null, h('span', { text: s.text }));
}

function requestLineEl(s, record) {
  if (s.state === 'pending') return h('div', { class: 't-note warn' }, spinner(10, 'warn'), h('span', { text: waitingText(s.method) }));
  return h('div', { class: 't-note' }, icon(record?.ok === false ? 'x' : 'check', 14), h('span', { text: record?.text || '응답함' }));
}

/**
 * An approval settled elsewhere arrives without its verdict (`record.via` says where). The call
 * it guarded tells: Hermes blocks a denied call ("BLOCKED … denied"), an allowed one runs.
 */
export function settledRecord(record, tool) {
  if (!record?.via || !tool || tool.state === 'running' || tool.state === 'generating' || tool.state === 'unknown') return record;
  const b = blockedReason(tool);
  if (b === '승인 시간 초과') return { ok: false, text: '시간이 지나 취소됨' };
  if (b === '거부됨') return { ok: false, text: `${record.via} 거부함` };
  if (b) return record;
  return { ok: true, text: `${record.via} 허용함` };
}

/**
 * What a call's persisted result says about its approval: Hermes' terminal tool adds
 * `approval: "Command required approval (…) and was approved by the user."` (or "auto-approved
 * by smart approval"). Null when the result says nothing (a denial shows as the call's 거부됨).
 */
export function approvalNote(tool) {
  const p = tool?.preview;
  const o = parseJsonMaybe(p);
  // A long result may arrive trimmed (not JSON): read the field from the text then.
  const a = o ? (typeof o.approval === 'string' ? o.approval : '')
    : typeof p === 'string' ? (/"approval"\s*:\s*"([^"]{0,600})/.exec(p)?.[1] || '') : '';
  if (/approved by the user/i.test(a)) return '승인함';
  if (/auto-approved/i.test(a)) return '자동 승인됨';
  return null;
}

/**
 * History segments with a "승인함" line after each call whose result records an approval, unless
 * this device already has the request record for that call (it says more: 한 번 / 이 세션 동안).
 */
export function withApprovalNotes(segs, notes = []) {
  const anchored = notes.filter((n) => n.kind === 'request' && n.afterTool).map((n) => String(n.afterTool));
  const covered = (id) => anchored.some((a) => id === a || id.startsWith(`${a}.`));
  const out = [];
  for (const s of segs) {
    out.push(s);
    if (s.kind !== 'tool' || s.tool.state === 'running' || s.tool.state === 'generating') continue;
    const text = approvalNote(s.tool);
    if (text && !covered(String(s.tool.id))) out.push({ kind: 'note', key: `ap:${s.tool.id}`, icon: 'check', text });
  }
  return out;
}

/** Inline placeholder text for a docked request (spec §3.4.3). */
export function waitingText(method) {
  if (method === 'clarify') return '답변을 기다리는 중';
  if (method === 'sudo' || method === 'secret') return '입력을 기다리는 중';
  return '승인을 기다리는 중';
}

function errorEl(s) {
  return h('div', { class: 't-error' }, icon('alert', 16),
    h('span', { text: `오류: ${s.text}` }),
    s.retry ? h('button', { type: 'button', class: 'btn-link', text: '다시 시도', onclick: s.retry }) : null);
}

/**
 * Render segments into `container`, reusing elements from `cache` (Map key → element).
 * ctx: {expanded:Set, expandedGroups:Set, hasReplyFrom:(args,result)=>boolean, now:number}
 */
export function renderSegments(container, segs, cache, ctx) {
  const used = new Set();
  const kids = [];
  const get = (key, make) => {
    used.add(key);
    let el = cache.get(key);
    if (!el) { el = make(); cache.set(key, el); }
    return el;
  };
  let i = 0;
  while (i < segs.length) {
    const s = segs[i];
    if (s.kind === 'tool') {
      // Collect a run of consecutive tool segments.
      let j = i;
      while (j < segs.length && segs[j].kind === 'tool') j += 1;
      const run = segs.slice(i, j);
      const lines = run.map((t) => {
        const el = get(t.key, () => createToolLine(t.tool, ctx.expanded));
        el.update(t.tool, ctx.now);
        return el;
      });
      if (run.length >= GROUP_MIN) {
        const gk = `g:${run[0].key}`;
        const g = get(gk, () => createToolGroup(gk, ctx.expandedGroups));
        g.update(lines, run.map((t) => t.tool));
        kids.push(g);
      } else {
        kids.push(...lines);
      }
      i = j;
      continue;
    }
    if (s.kind === 'reasoning') {
      const el = get(s.key, reasoningEl);
      el.update(s);
      kids.push(el);
    } else if (s.kind === 'text') {
      const el = get(s.key, textEl);
      el.update(s);
      kids.push(el);
    } else if (s.kind === 'agent') {
      const hasReply = ctx.hasReplyFrom ? ctx.hasReplyFrom(s.args, s.result) : false;
      const res = parseJsonMaybe(s.result) || s.result || {};
      const sig = `${s.running}|${res?.status || ''}|${hasReply}|${res?.reason || ''}`;
      const key = `${s.key}|${sig}`;
      kids.push(get(key, () => outgoingCard(s.args, s.result, { running: s.running, hasReply })));
    } else if (s.kind === 'request') {
      const prev = segs[i - 1];
      const record = s.state === 'done' ? settledRecord(s.record, prev?.kind === 'tool' ? prev.tool : null) : null;
      const key = `${s.key}|${s.state}|${record?.text || ''}`;
      kids.push(get(key, () => requestLineEl(s, record)));
    } else if (s.kind === 'steer') {
      kids.push(get(`${s.key}|${s.text}`, () => steerBlock(s.text)));
    } else if (s.kind === 'note') {
      kids.push(get(`${s.key}|${s.text}`, () => noteEl(s)));
    } else if (s.kind === 'error') {
      kids.push(get(`${s.key}|${s.text}`, () => errorEl(s)));
    }
    i += 1;
  }
  for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
  syncChildren(container, kids);
}

// --------------------------------------------------------------------------- user block

function textWithMentions(text) {
  const frag = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text))) {
    if (m.index > last) frag.push(text.slice(last, m.index));
    frag.push(h('span', { class: 'mention', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.push(text.slice(last));
  return frag;
}

/**
 * @param {string} text
 * @param {{attachments?:Array<{name:string}>, caption?:Node|null, pending?:boolean}} [o]
 */
export function userBlock(text, o = {}) {
  const copy = desktopKeys() ? h('button', {
    type: 'button', class: 'ub-copy icon-btn', 'aria-label': '복사', title: '복사',
    onclick: async () => { toast((await copyText(text)) ? '복사했어요' : '복사하지 못했어요'); },
  }, icon('copy', 16)) : null;
  const atts = Array.isArray(o.attachments) && o.attachments.length
    ? h('div', { class: 'ub-atts' }, o.attachments.map((a) => h('span', { class: 'att-chip' }, icon('paperclip', 14), h('span', { text: a.name || a.filename || '첨부' }))))
    : null;
  return h('div', { class: `user-block${o.pending ? ' pending' : ''}` },
    h('div', { class: 'ub-text' }, textWithMentions(text)), atts, copy, o.caption || null);
}

/** A steer (끼어들기): the user's words delivered into a running turn, in the turn's flow. */
export function steerBlock(text, o = {}) {
  const el = userBlock(text, { ...o, caption: o.caption || h('div', { class: 'ub-caption', text: '끼어들기' }) });
  el.classList.add('steer');
  return el;
}

// --------------------------------------------------------------------------- history turns

/**
 * Group ascending rows into turns: each user row (or leading non-user rows) starts one. A steer
 * row is part of the turn it was delivered into, not a turn of its own.
 */
export function buildTurns(rows) {
  const turns = [];
  let cur = null;
  for (const r of rows) {
    if (r.role === 'user' && isSteerRow(r)) {
      if (!cur) { cur = { key: `h:${r.id}`, user: null, rows: [] }; turns.push(cur); }
      cur.rows.push(r);
    } else if (r.role === 'user') {
      cur = { key: `u:${r.id}`, user: r, rows: [] };
      turns.push(cur);
    } else if (r.role === 'assistant' || r.role === 'tool') {
      if (!cur) { cur = { key: `h:${r.id}`, user: null, rows: [] }; turns.push(cur); }
      cur.rows.push(r);
    }
    // system/other rows are not shown (raw system prompts, session.info dumps).
  }
  return turns;
}

export function turnSignature(t) {
  let s = t.user ? `${t.user.id}:${contentText(t.user.content).length}` : '';
  for (const r of t.rows) s += `|${r.id}:${contentText(r.content).length}:${r.tool_calls?.length || 0}:${(r.reasoning || '').length}`;
  return s;
}

/**
 * Render one persisted turn (cached by signature by the caller).
 * `o.open`: the turn is still running; `o.skipCall`: unresolved calls the live view shows.
 */
export function renderTurn(t, ctx, notes = [], o = {}) {
  const el = h('div', { class: 'turn', dataset: { key: t.key } });
  if (t.user) {
    const text = contentText(t.user.content);
    const om = t.user.omni;
    if (om && (om.kind === 'message' || om.kind === 'reply')) {
      add(el, incomingCard({
        kind: om.kind, fromAddr: om.from, fromTitle: om.from_title, body: om.body ?? '',
        expectReply: om.kind === 'message' && /delivered back to/.test(text),
      }));
    } else if (!/^⟦omni:/.test(text)) {
      add(el, userBlock(text, { attachments: t.user.attachments }));
    } else {
      // Marker row the link could not parse: never show the raw marker.
      add(el, incomingCard({ kind: 'message', fromAddr: '', fromTitle: '', body: text.replace(/^⟦omni:[^⟧]*⟧[^\n]*\n?/, '').replace(/\n\n— [\s\S]*$/, '') }));
    }
  }
  let segs = historySegments(t.rows, o);
  const ended = notes.some((n) => n.kind === 'note' || n.kind === 'error');
  // This device saw how the turn ended (중단됨 / an error): Hermes' boundary row repeats it.
  if (ended) segs = segs.filter((s) => !s.failed);
  if (!o.open && t.user && endsEmpty(t.rows) && !ended) {
    segs.push({ kind: 'note', key: `e:${t.key}`, text: EMPTY_REPLY });
  }
  segs = withApprovalNotes(segs, notes);
  for (const n of notes) {
    // A request record goes right after the call it guarded, not after the turn's answer.
    let at = -1;
    if (n.afterTool) {
      const id = String(n.afterTool);
      for (let j = segs.length - 1; j >= 0 && at < 0; j -= 1) {
        const k = segs[j].key || '';
        if (k === `t:${id}` || k === `a:${id}` || k.startsWith(`t:${id}.`) || k.startsWith(`a:${id}.`)) at = j + 1;
      }
    }
    if (at < 0) segs.push(n);
    else segs.splice(at, 0, n);
  }
  if (segs.length) {
    const asst = h('div', { class: 'asst' });
    renderSegments(asst, segs, new Map(), ctx);
    add(el, asst);
  }
  return el;
}
