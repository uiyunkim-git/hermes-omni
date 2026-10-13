// Chat screen (spec §3.4): app bar, banners, the transcript (history pages + live turn), docked
// request cards and the composer.
//
// Flow: subscribe (the hub answers with session.snapshot) and load the newest history page in
// parallel → stream session.event deltas into the live turn (rendered once per frame) → on
// turn.done merge the newest page and drop the live turn. Older pages load on scroll-up.

import { api, errorText } from '../api.js';
import {
  bus, getSession, findNode, isOnline, nodeSupportsFeatures, rowTitle, folderLabel, markSeen, moveSeen, patchSession,
  needsYou, NO_FOLDER,
} from '../store.js';
import { socket } from '../ws.js';
import { navigate, back } from '../router.js';
import {
  h, contentText, copyText, debounce, download, fmtClock, fmtDateTime, fmtInt, isDesktop, rafThrottle,
  sessionHref, ss, toMs, parseJsonMaybe, relTime, fill, add, steerText, isSteerRow, turnNotice,
} from '../util.js';
import { icon } from '../ui/icons.js';
import { banner, iconButton, spinner, errorLine, skeletonLines } from '../ui/controls.js';
import { openMenu } from '../ui/menu.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import {
  buildTurns, turnSignature, renderTurn, renderSegments, userBlock, callSegments, waitingText, EMPTY_REPLY,
} from './transcript.js';
import { incomingCard } from './agentcard.js';
import { looksLikeError } from './toolline.js';
import { requestCard, cancelRecord } from './requestcard.js';
import { saveHistory, loadHistory, forgetHistory } from './histcache.js';
import { createComposer } from './composer.js';
import { openModelSheet } from './modelsheet.js';
import { BLOCKED } from './slash.js';
import { setMeta as shareMeta, getMeta, active } from './active.js';
import { markdownBlock } from './markdown.js';

const PAGE = 100;
const NEAR_BOTTOM = 80;

/** Shared drafts across a compression tip move (old sid → new sid). */
const tipDrafts = new Map();

/**
 * @param {HTMLElement} root
 * @param {{node:string, sid:string}} params
 */
export function mountChat(root, { node, sid }) {
  const key = `${node}#${sid}`;
  let alive = true;
  let row = getSession(node, sid);

  // ---------------------------------------------------------------- state
  let rows = [];
  let hasMore = false;
  let historyLoaded = false;
  let loadingOlder = false;
  let live = null;
  let liveSeq = 0;
  let segSeq = 0;
  let lastSeq = 0;
  let running = !!row?.running;
  let turnStartedAt = null;
  let meta = getMeta(key);
  let locked = null;
  const requests = new Map();          // request_id → request (open)
  const records = new Map();           // request_id → {state, record}
  const answering = new Map();         // request_id → cancel frame seen while our answer was in flight (or null)
  let cachedAt = 0;                    // > 0 while showing the offline copy of the history
  let loadingFresh = false;            // a newest-page load is in flight (initial or after reconnect)
  const pending = [];                  // optimistic user prompts {id, text, atts, state, mode}
  const incoming = [];                 // live session.incoming deliveries not yet in history
  const localItems = [];               // system blocks / errors {id, kind, afterId, ...}
  const turnNotes = new Map();         // turn key → [segment]
  const expanded = new Set();
  const expandedGroups = new Set();
  const turnCache = new Map();         // turn key → {sig, el}
  const liveCache = new Map();
  let pendingNote = null;              // note to attach to the last turn after the next merge

  // ---------------------------------------------------------------- layout
  const titleT1 = h('span', { class: 'appbar-t1' });
  const titleT2 = h('span', { class: 'appbar-t2' });
  const titleBtn = h('button', { type: 'button', class: 'appbar-title', onclick: () => rename() }, titleT1, titleT2);
  const backBtn = iconButton('chevron-left', '뒤로', () => back(), { cls: 'back-btn' });
  const infoBtn = iconButton('info', '세션 정보', () => openInfo());
  const moreBtn = iconButton('more', '더 보기', () => openMoreMenu());
  const bar = h('header', { class: 'appbar chat-appbar' },
    h('div', { class: 'appbar-row' }, backBtn, titleBtn, h('span', { class: 'appbar-spacer' }), infoBtn, moreBtn));
  const bannerSlot = h('div', { class: 'banner-slot' });

  const startMarker = h('div', { class: 'start-marker', hidden: true });
  const loadOlderBtn = h('button', { type: 'button', class: 'btn-link load-older', hidden: true, text: '이전 메시지 불러오기', onclick: () => loadOlder() });
  const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });
  const turnsEl = h('div', { class: 'turns' });
  const pendingEl = h('div', { class: 'pending-list' });
  const liveEl = h('div', { class: 'turn live-turn', hidden: true });
  const liveAsst = h('div', { class: 'asst' });
  const activityEl = h('div', { class: 'activity', hidden: true }, spinner(12), h('span', { class: 'activity-text' }));
  add(liveEl, liveAsst, activityEl);
  const tailEl = h('div', { class: 'tail-list' });
  const transcript = h('div', { class: 'transcript', role: 'log', 'aria-live': 'off', 'aria-label': '대화' },
    sentinel, startMarker, loadOlderBtn, turnsEl, pendingEl, liveEl, tailEl);
  const scroller = h('div', { class: 'chat-scroll' }, transcript);
  const latestPill = h('button', { type: 'button', class: 'latest-pill', hidden: true, onclick: () => scrollToBottom(true) }, icon('arrow-down', 16), h('span', { text: '최신으로' }));
  const dock = h('div', { class: 'req-dock', hidden: true });

  const composer = createComposer({
    node, sid, key,
    send: (text, mode, atts) => sendPrompt(text, mode, atts),
    interrupt: () => interrupt(),
    slash: (text, item) => runSlash(text, item),
    catalog: () => catalog(),
    openModel: (anchor) => openModel(anchor),
    openContext: () => openInfo('context'),
    lastPrompt: () => lastUserPrompt(),
  });
  if (tipDrafts.has(key)) { composer.setText(tipDrafts.get(key)); tipDrafts.delete(key); }

  const bottom = h('div', { class: 'chat-bottom' }, latestPill, dock, composer.el);
  const view = h('section', { class: 'chat', 'aria-label': '채팅' }, bar, bannerSlot, scroller, bottom);
  fill(root, view);

  // ---------------------------------------------------------------- header / banners
  function refreshHeader() {
    row = getSession(node, sid) || row;
    const title = rowTitle(row);
    titleT1.textContent = row ? title : '세션';
    document.title = `${row ? title : '세션'} · Hermes`;
    const online = isOnline(node) || (!findNode(node) && row?.node_online !== false);
    const parts = [row?.node_name || findNode(node)?.display_name || node, row ? folderLabel(row) : null];
    let status = '';
    if (!online) status = '오프라인';
    else if (requests.size || needsYou(row)) status = '승인 대기';
    else if (running) status = turnStartedAt ? `실행 중 · ${fmtClock((Date.now() - turnStartedAt) / 1000)}` : '실행 중';
    fill(titleT2, h('span', { text: parts.filter(Boolean).join(' · ') }),
      status ? h('span', { class: `t2-status${running && online ? ' running' : ''}${status === '승인 대기' ? ' warn' : ''}`, text: ` · ${status}` }) : null);
    refreshBanner(online);
  }

  let bannerSig = '';
  function refreshBanner(online = isOnline(node)) {
    const features = nodeSupportsFeatures(node);
    let sig = '';
    let el = null;
    if (locked) {
      sig = `locked:${locked.surface}`;
      el = banner(`이 대화는 다른 곳(${locked.surface || '다른 창'})에서 열려 있어요. 거기서 계속하거나 새 세션을 시작하세요.`, [
        { label: '다시 시도', onClick: () => { locked = null; refreshHeader(); resubscribe(); } },
        { label: '새 세션', onClick: () => navigate('#/new') },
      ]);
    } else if (!online && findNode(node)) {
      sig = `offline:${cachedAt}:${historyLoaded}`;
      const name = findNode(node)?.display_name || node;
      el = banner(cachedAt ? `${name} 노드가 오프라인이에요. 마지막으로 불러온 기록(${relTime(cachedAt)})만 볼 수 있어요.`
        : historyLoaded ? `${name} 노드가 오프라인이에요. 기록만 볼 수 있어요.`
          : `${name} 노드가 오프라인이에요. 다시 연결되면 기록을 불러와요.`);
    } else if (!features) {
      sig = 'outdated';
      el = banner('이 노드는 업데이트가 필요해요. 일부 기능이 꺼져 있어요.');
    }
    composer.setFeatures(features);
    composer.setMeta(meta);
    if (locked) composer.setDisabled(true, '다른 곳에서 사용 중');
    else if (!online && findNode(node)) composer.setDisabled(true, '노드가 오프라인이에요');
    else composer.setDisabled(false);
    infoBtn.hidden = false;
    if (sig === bannerSig) return;
    bannerSig = sig;
    fill(bannerSlot, ...(el ? [el] : []));
  }

  // ---------------------------------------------------------------- scrolling
  const distFromBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  let stickToBottom = true;
  function scrollToBottom(smooth = false) {
    if (smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    else scroller.scrollTop = scroller.scrollHeight;
    stickToBottom = true;
    latestPill.hidden = true;
  }
  const saveScroll = debounce(() => ss.set(`omni.scroll.${key}`, Math.max(0, Math.round(distFromBottom()))), 200);
  scroller.addEventListener('scroll', () => {
    const d = distFromBottom();
    stickToBottom = d < NEAR_BOTTOM;
    latestPill.hidden = stickToBottom;
    saveScroll();
  }, { passive: true });

  /** Run a DOM mutation keeping the bottom pinned if we were there. */
  function mutate(fn) {
    const stick = stickToBottom;
    fn();
    if (stick) scroller.scrollTop = scroller.scrollHeight;
    else latestPill.hidden = distFromBottom() < NEAR_BOTTOM;
  }

  // Keyboard open on mobile: keep the transcript at the bottom when it was there.
  const onViewport = () => { if (stickToBottom) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; }); };
  window.visualViewport?.addEventListener('resize', onViewport);
  composer.textarea.addEventListener('focus', () => setTimeout(onViewport, 250));
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => onViewport()) : null;
  ro?.observe(scroller);

  // ---------------------------------------------------------------- history
  const rowNum = (r) => (Number.isFinite(Number(r.id)) ? Number(r.id) : 0);
  const maxRowId = () => (rows.length ? rowNum(rows[rows.length - 1]) : 0);

  async function loadLatest(first = false) {
    try {
      const res = await api.messages(node, sid, PAGE, 0);
      if (!alive) return;
      const page = Array.isArray(res.messages) ? res.messages : [];
      if (cachedAt) {
        // Back online: replace the offline copy wholesale.
        cachedAt = 0;
        rows = [];
        turnCache.clear();
      }
      if (!rows.length || !page.length) {
        rows = page;
        hasMore = !!res.has_more;
      } else {
        const firstId = rowNum(page[0]);
        if (firstId <= maxRowId() + 1 && rows.some((r) => rowNum(r) <= firstId)) {
          rows = rows.filter((r) => rowNum(r) < firstId).concat(page);
        } else {
          rows = page;            // gap: start over from the newest page
          hasMore = !!res.has_more;
          turnCache.clear();
        }
      }
      historyLoaded = true;
      saveHistory(key, rows);
      // Drop optimistic/live items now persisted.
      reconcilePending();
      if (live?.done) {
        // Answered request records are client-side only: keep them on the finished turn.
        const recs = live.segs.filter((s) => s.kind === 'request' && s.state === 'done');
        if (recs.length) {
          const turns = buildTurns(rows);
          const last = turns[turns.length - 1];
          if (last) turnNotes.set(last.key, [...(turnNotes.get(last.key) || []), ...recs.map((s) => ({ ...s, key: `rq:${s.request_id}` }))]);
        }
        live = null;
        liveCache.clear();
      }
      if (pendingNote) {
        const turns = buildTurns(rows);
        const last = turns[turns.length - 1];
        if (last) turnNotes.set(last.key, [...(turnNotes.get(last.key) || []), pendingNote]);
        pendingNote = null;
      }
      renderAll();
      if (first) restoreScroll();
    } catch (err) {
      if (!alive) return;
      const offline = err.code === 'node_offline' || err.status === 503 || (findNode(node) && !isOnline(node));
      if (!historyLoaded && offline && showCached()) return;
      if (!historyLoaded && offline) {
        // Nothing cached on this device; the 'nodes' handler reloads when the node is back.
        fill(turnsEl, h('div', { class: 'chat-empty' },
          h('p', { class: 'empty-title', text: '이 기기에 저장된 기록이 없어요' }),
          h('p', { class: 'empty-body', text: '노드가 다시 연결되면 자동으로 불러와요.' })));
      } else if (!historyLoaded) {
        fill(turnsEl, errorLine(`기록을 불러오지 못했어요 · ${errorText(err)}`, () => { fill(turnsEl, skeletonLines(3)); loadLatest(true); }));
      } else if (!offline) {
        // Offline with history on screen: the banner already says so; keep what we have.
        toastError(err, '기록을 새로 고치지 못했어요');
      }
    }
  }
  const reloadSoon = debounce(() => loadLatest(), 300);

  /** Offline node: show the last page this browser loaded, read-only. */
  function showCached() {
    const c = loadHistory(key);
    if (!c) return false;
    rows = c.rows;
    hasMore = false;
    cachedAt = c.at;
    historyLoaded = true;
    turnCache.clear();
    refreshHeader();
    renderAll();
    restoreScroll();
    return true;
  }

  async function loadOlder() {
    if (loadingOlder || !hasMore || !historyLoaded) return;
    loadingOlder = true;
    loadOlderBtn.hidden = true;
    const spin = h('div', { class: 'older-spin' }, spinner(16));
    transcript.insertBefore(spin, turnsEl);
    try {
      const res = await api.messages(node, sid, PAGE, rows.length);
      if (!alive) return;
      const page = Array.isArray(res.messages) ? res.messages : [];
      const known = new Set(rows.map((r) => r.id));
      const older = page.filter((r) => !known.has(r.id));
      hasMore = !!res.has_more && older.length > 0;
      const before = scroller.scrollHeight;
      const top = scroller.scrollTop;
      spin.remove();
      rows = older.concat(rows);
      renderAll(false);
      scroller.scrollTop = top + (scroller.scrollHeight - before);
    } catch (err) {
      spin.remove();
      toastError(err, '이전 메시지를 불러오지 못했어요');
    } finally {
      loadingOlder = false;
      updatePagingUi();
    }
  }

  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && historyLoaded && hasMore && scroller.scrollTop < 400) loadOlder();
    }, { root: scroller, rootMargin: '300px 0px 0px 0px' })
    : null;
  io?.observe(sentinel);

  function updatePagingUi() {
    loadOlderBtn.hidden = !hasMore || loadingOlder || !!io;
    if (cachedAt) {
      startMarker.textContent = `마지막으로 불러온 기록 · ${fmtDateTime(cachedAt)}`;
      startMarker.hidden = false;
    } else if (!hasMore && historyLoaded && rows.length) {
      const started = row?.started_at ?? rows[0]?.timestamp;
      startMarker.textContent = started ? `시작 · ${fmtDateTime(started)}` : '시작';
      startMarker.hidden = false;
    } else startMarker.hidden = true;
  }

  function restoreScroll() {
    const saved = Number(ss.get(`omni.scroll.${key}`));
    requestAnimationFrame(() => {
      if (Number.isFinite(saved) && saved > NEAR_BOTTOM) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - saved);
        stickToBottom = false;
        latestPill.hidden = false;
      } else scrollToBottom();
    });
  }

  function reconcilePending() {
    const userTexts = new Map();
    const latestUser = rows.filter((r) => r.role === 'user').slice(-20);
    for (const r of latestUser) {
      const t = userRowText(r).trim();
      userTexts.set(t, (userTexts.get(t) || 0) + 1);
    }
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i];
      if (p.state !== 'failed' && p.mode !== 'queued' && userTexts.get(p.text.trim()) && p.persistAfter <= maxRowId()) {
        pending.splice(i, 1);
      }
    }
    for (let i = incoming.length - 1; i >= 0; i -= 1) {
      const d = incoming[i];
      if (latestUser.some((r) => r.omni?.delivery_id === d.id || contentText(r.content).includes(`⟦omni:${d.id}⟧`))) incoming.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------- rendering
  function hasReplyFrom(args, result) {
    const res = parseJsonMaybe(result) || {};
    const did = res.delivery_id;
    const a = parseJsonMaybe(args) || args || {};
    const addr = res.to_address || a.to;
    for (const r of rows) {
      if (r.role !== 'user' || r.omni?.kind !== 'reply') continue;
      const text = contentText(r.content);
      if (did && text.includes(did)) return true;
      if (!did && (r.omni.from === addr || (res.to_title && r.omni.from_title === res.to_title))) return true;
    }
    return incoming.some((d) => d.kind === 'reply' && (d.from_addr === addr || (did && String(d.message || '').includes(did))));
  }

  const ctx = () => ({ expanded, expandedGroups, hasReplyFrom, now: Date.now() });

  /** Tool ids the live turn shows (a snapshot-joined turn carries the hub buffer's calls). */
  function liveToolIds() {
    const ids = new Set();
    if (live) for (const s of live.segs) if (s.kind === 'call' && s.call.tool_id) ids.add(String(s.call.tool_id));
    return ids;
  }

  /** A user row's own words (a steer row unwrapped from Hermes' out-of-band marker). */
  function userRowText(r) { return steerText(contentText(r.content)) ?? contentText(r.content); }
  /** Index of the row that starts the newest turn (steer rows are inside a turn). */
  function lastTurnStart() {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].role === 'user' && !isSteerRow(rows[i])) return i;
    return -1;
  }

  function visibleRows() {
    if (!live) return rows;
    // Our own steers are already in the live view, at the point they were sent.
    const liveSteers = new Set(live.segs.filter((x) => x.kind === 'steer').map((x) => x.text.trim()));
    const shownLive = (r) => liveSteers.size > 0 && rowNum(r) > live.baseMaxId && isSteerRow(r) && liveSteers.has(userRowText(r).trim());
    // A turn we watched from its start: rows persisted mid-turn are already in the live view
    // (also once it is done, until the merge in loadLatest drops the live view).
    if (!live.fromSnapshot) return rows.filter((r) => (r.role === 'user' && !shownLive(r)) || rowNum(r) <= live.baseMaxId);
    // Joined mid-turn via snapshot. If the hub's buffer holds every call the in-flight turn has
    // persisted, it saw the whole turn, so its persisted steps would show twice: hide them.
    // Otherwise keep them (hiding rows the live view lacks would lose them); renderTurns then
    // drops only the duplicated calls.
    const start = lastTurnStart();
    if (start < 0) return rows;
    const ids = [];
    for (const r of rows.slice(start + 1)) for (const c of (Array.isArray(r.tool_calls) ? r.tool_calls : [])) if (c?.id) ids.push(String(c.id));
    const shown = liveToolIds();
    if (ids.length && ids.every((id) => shown.has(id))) return rows.slice(0, start + 1);
    return rows.filter((r) => !shownLive(r));
  }

  /**
   * A turn joined mid-way keeps its persisted rows (see visibleRows), and the hub's buffer
   * usually repeats the newest step's prose and reasoning. Those history segments are dropped
   * (keys `x:<row id>` / `r:<row id>`) so the live view shows them once, in order. Returns a
   * comma list, used both as the skip set and as part of the cached turn's signature.
   */
  function liveDupKeys() {
    if (!live || !live.fromSnapshot) return '';
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const texts = [];
    const reasons = [];
    for (const s of live.segs) {
      if (s.kind === 'text' && norm(s.text)) texts.push(norm(s.text));
      else if (s.kind === 'reasoning' && norm(s.text)) reasons.push(norm(s.text));
    }
    if (!texts.length && !reasons.length) return '';
    const covers = (list, t) => list.some((x) => x.includes(t) || (t.length >= 24 && x.length >= 24 && t.includes(x)));
    const start = lastTurnStart();
    const out = [];
    for (const r of rows.slice(start + 1)) {
      if (r.role !== 'assistant') continue;
      const t = norm(contentText(r.content));
      if (t && covers(texts, t)) out.push(`x:${r.id}`);
      const rs = norm(r.reasoning);
      if (rs && covers(reasons, rs)) out.push(`r:${r.id}`);
    }
    return out.join(',');
  }
  let renderedDup = '';

  function renderTurns() {
    const turns = buildTurns(visibleRows());
    const c = ctx();
    const kids = [];
    const seen = new Set();
    // The newest turn is still in flight while the session runs and no live view of our own
    // covers it: its unanswered calls are running, and calls the snapshot shows are dropped.
    const inflight = running && !cachedAt && (!live || (live.fromSnapshot && !live.done));
    const shown = inflight && live ? liveToolIds() : null;
    const dup = liveDupKeys();
    renderedDup = dup;
    const dupSet = dup ? new Set(dup.split(',')) : null;
    const lastOpts = !inflight && !dupSet ? {} : {
      open: inflight,
      skipCall: shown?.size ? (call) => call.state === 'pending' || shown.has(String(call.id)) : undefined,
      skipSeg: dupSet ? (key) => dupSet.has(key) : undefined,
    };
    const lastSig = `${inflight ? `|open:${shown?.size ? [...shown].join(',') : '-'}` : ''}${dup ? `|dup:${dup}` : ''}`;
    // Local items (system blocks) are placed after the turn containing their anchor row id.
    const locals = [...localItems];
    turns.forEach((t, i) => {
      const isLast = i === turns.length - 1;
      const notes = turnNotes.get(t.key) || [];
      const replyHint = t.rows.some((r) => Array.isArray(r.tool_calls) && JSON.stringify(r.tool_calls).includes('hub_send')) ? `|${rows.filter((r) => r.omni?.kind === 'reply').length}|${incoming.length}` : '';
      const sig = `${turnSignature(t)}#${notes.map((n) => n.key).join(',')}${replyHint}${isLast ? lastSig : ''}`;
      let cached = turnCache.get(t.key);
      if (!cached || cached.sig !== sig) {
        cached = { sig, el: renderTurn(t, c, notes, isLast ? lastOpts : {}) };
        turnCache.set(t.key, cached);
      }
      seen.add(t.key);
      kids.push(cached.el);
      const lastId = Math.max(t.user ? rowNum(t.user) : 0, ...t.rows.map(rowNum));
      while (locals.length && locals[0].afterId <= lastId) kids.push(localEl(locals.shift()));
    });
    for (const k of [...turnCache.keys()]) if (!seen.has(k)) turnCache.delete(k);
    fill(turnsEl, ...kids);
    // Remaining locals render after pending/live.
    fill(tailEl, ...locals.map(localEl));
    if (historyLoaded && !turns.length && !pending.length && !live && !incoming.length && !localItems.length) {
      const folder = row ? folderLabel(row) : NO_FOLDER;
      fill(turnsEl, h('div', { class: 'chat-empty' },
        h('p', { class: 'empty-title', text: '아직 대화가 없어요' }),
        h('p', { class: 'empty-body', text: folder === NO_FOLDER ? '작업 폴더에서 시작해요.' : `${folder} 폴더에서 작업해요.` })));
    }
  }

  const localEls = new Map();
  function localEl(item) {
    let el = localEls.get(item.id);
    if (el) return el;
    if (item.kind === 'system') {
      el = h('div', { class: `sys-block${item.error ? ' error' : ''}` },
        h('div', { class: 'sys-label', text: item.label }),
        item.rows ? h('div', { class: 'sys-kv' }, item.rows.map(([k, v]) => [h('span', { class: 'sys-k', text: k }), h('span', { class: 'sys-v', text: v })]))
          : item.markdown ? markdownBlock(item.text, 'sys-md') : h('pre', { class: 'sys-pre', text: item.text }));
    } else if (item.kind === 'request') {
      const rec = records.get(item.request_id);
      el = rec?.state === 'done'
        ? h('div', { class: 't-note' }, icon(rec.record?.ok === false ? 'x' : 'check', 14), h('span', { text: rec.record?.text || '응답함' }))
        : h('div', { class: 't-note warn' }, spinner(10, 'warn'), h('span', { text: waitingText(item.method) }));
      return el;     // not cached: state changes
    } else {
      el = h('div', { class: 't-error' }, icon('alert', 16), h('span', { text: item.text }));
    }
    localEls.set(item.id, el);
    return el;
  }

  function renderPending() {
    const kids = [];
    for (const d of incoming) {
      kids.push(h('div', { class: 'turn' }, incomingCard({
        kind: d.kind, fromAddr: d.from_addr, fromTitle: d.from_title, body: d.message, expectReply: !!d.expect_reply,
      })));
    }
    for (const p of pending) {
      const caption = p.state === 'failed'
        ? h('div', { class: 'ub-caption danger' }, h('span', { text: '보내지 못했어요 · ' }),
          h('button', { type: 'button', class: 'btn-link', text: '다시 시도', onclick: () => retryPending(p) }))
        : p.mode === 'steer' ? h('div', { class: 'ub-caption', text: '끼어들기' }) : null;
      kids.push(h('div', { class: 'turn' }, userBlock(p.text, { attachments: p.atts, caption, pending: p.state === 'sending' })));
    }
    fill(pendingEl, ...kids);
  }

  function liveSegments() {
    const out = [];
    for (const s of live.segs) {
      if (s.kind === 'call') out.push(...callSegments(s.call, s.key));
      else out.push(s);
    }
    return out;
  }

  function renderLive() {
    if (!live) {
      liveEl.hidden = true;
      liveCache.clear();
      fill(liveAsst);
      return;
    }
    liveEl.hidden = false;
    // The live text grew to cover a persisted paragraph (or stopped covering it): re-render the
    // history turn so that paragraph shows exactly once.
    if (historyLoaded && liveDupKeys() !== renderedDup) renderSoon();
    renderSegments(liveAsst, liveSegments(), liveCache, ctx());
    const showActivity = !live.done && running && requests.size === 0;
    activityEl.hidden = !showActivity;
    if (showActivity) {
      const since = live.startedAt || turnStartedAt || Date.now();
      activityEl.lastChild.textContent = `작업 중 · ${fmtClock((Date.now() - since) / 1000)}`;
    }
  }

  function renderDock() {
    for (const el of [...dock.children]) if (!requests.has(el.dataset.requestId)) el.remove();
    for (const [rid, r] of requests) {
      if (dock.querySelector(`[data-request-id="${CSS.escape(rid)}"]`)) continue;
      add(dock, requestCard({ node, sid, request: r }, {
        onStart: () => answering.set(rid, null),
        onDone: (record) => { answering.delete(rid); resolveRequest(rid, record); },
        // Our answer failed, but the request was settled elsewhere meanwhile: show that instead.
        onFail: () => {
          if (!answering.has(rid)) return false;
          const cancel = answering.get(rid);
          answering.delete(rid);
          if (!cancel) return false;
          resolveRequest(rid, cancelRecord(cancel, r.method));
          return true;
        },
      }));
    }
    dock.hidden = requests.size === 0;
  }

  function renderAll(keepBottom = true) {
    if (!alive) return;
    const doIt = () => {
      if (historyLoaded) renderTurns();
      renderPending();
      renderLive();
      updatePagingUi();
    };
    if (keepBottom) mutate(doIt);
    else doIt();
  }

  const renderLiveSoon = rafThrottle(() => mutate(renderLive));
  const renderSoon = rafThrottle(() => renderAll());

  // ---------------------------------------------------------------- live turn
  function startLive(startedAt, fromSnapshot = false) {
    live = { segs: [], done: false, status: null, startedAt: startedAt || Date.now(), baseMaxId: maxRowId(), fromSnapshot, id: ++liveSeq };
    liveCache.clear();
  }

  const lastSeg = () => live.segs[live.segs.length - 1];
  function hasTextAfterLastCall() {
    for (let i = live.segs.length - 1; i >= 0; i -= 1) {
      const k = live.segs[i].kind;
      if (k === 'text') return true;
      if (k === 'call' || k === 'agent') return false;
    }
    return false;
  }
  function closeReasoning() {
    for (const s of live.segs) if (s.kind === 'reasoning' && s.live) { s.live = false; s.secs = (Date.now() - s.t0) / 1000; }
  }
  function findCall(pred) {
    for (let i = live.segs.length - 1; i >= 0; i -= 1) {
      const s = live.segs[i];
      if (s.kind === 'call' && pred(s.call)) return s.call;
    }
    return null;
  }

  function applyEvent(type, p = {}) {
    if (type === 'message.start') {
      startLive(Date.now());
      running = true;
      if (!turnStartedAt) turnStartedAt = Date.now();
      // A queued prompt of ours starts now: its user row will appear in history.
      reloadSoon();
      composer.setRunning(true);
      refreshHeader();
      renderSoon();
      return;
    }
    if (!live) startLive(turnStartedAt || Date.now(), true);
    switch (type) {
      case 'message.delta': {
        const t = String(p.text || '');
        if (!t) break;
        closeReasoning();
        const l = lastSeg();
        if (l?.kind === 'text') l.text += t;
        else live.segs.push({ kind: 'text', key: `lx${++segSeq}`, text: t });
        break;
      }
      case 'reasoning.delta': {
        const t = String(p.text || '');
        if (!t) break;
        const l = lastSeg();
        if (l?.kind === 'reasoning' && l.live) l.text = (l.text + t).slice(-20000);
        else live.segs.push({ kind: 'reasoning', key: `lr${++segSeq}`, text: t, live: true, t0: Date.now() });
        break;
      }
      case 'tool.generating': {
        closeReasoning();
        const name = String(p.name || 'tool');
        if (!findCall((c) => c.state === 'generating' && c.name === name)) {
          live.segs.push({ kind: 'call', key: `lt${++segSeq}`, call: { name, args: {}, state: 'generating', startedAt: Date.now() } });
        }
        break;
      }
      case 'tool.start': {
        closeReasoning();
        const name = String(p.name || 'tool');
        // Tool Search: the model generates `tool_call`, but tool.start names the real tool.
        const c = findCall((x) => x.state === 'generating' && !x.tool_id && (x.name === name || x.name === 'tool_call'));
        if (c) Object.assign(c, { name, tool_id: p.tool_id, state: 'running', args: p.args ?? c.args, startedAt: Date.now() });
        else live.segs.push({ kind: 'call', key: `lt${++segSeq}`, call: { tool_id: p.tool_id, name, args: p.args ?? {}, state: 'running', startedAt: Date.now() } });
        break;
      }
      case 'tool.complete': {
        let c = p.tool_id ? findCall((x) => x.tool_id === p.tool_id) : null;
        if (!c) c = findCall((x) => x.name === p.name && (x.state === 'running' || x.state === 'generating'));
        if (!c) {
          c = { name: String(p.name || 'tool'), args: {}, state: 'done' };
          live.segs.push({ kind: 'call', key: `lt${++segSeq}`, call: c });
        }
        const result = p.result_preview ?? p.result;
        const err = p.error || (result && typeof result === 'object' && result.error) || null;
        Object.assign(c, {
          state: err || looksLikeError(result) ? 'error' : 'done', duration_s: Number(p.duration_s), error: err || null,
          preview: result ?? c.preview,
        });
        break;
      }
      case 'message.complete': {
        closeReasoning();
        let text = typeof p.text === 'string' ? p.text : '';
        // Hermes' failed-turn boundary is not an answer: the 중단됨 note below says it (or the Korean copy).
        const notice = turnNotice(text);
        if (notice) {
          text = '';
          if (p.status !== 'interrupted') live.segs.push({ kind: 'note', key: `ln${++segSeq}`, text: notice.text });
        }
        if (text && !live.segs.some((s) => s.kind === 'text')) live.segs.push({ kind: 'text', key: `lx${++segSeq}`, text });
        live.done = true;
        live.status = p.status || 'complete';
        // Calls still open when the turn ends have no result: never mark them ✓.
        for (const s of live.segs) if (s.kind === 'call' && (s.call.state === 'running' || s.call.state === 'generating')) s.call.state = 'unknown';
        if (live.status === 'interrupted') live.segs.push({ kind: 'note', key: `ln${++segSeq}`, text: '중단됨' });
        else if (!text && !hasTextAfterLastCall() && !live.segs.some((s) => s.kind === 'error')) live.segs.push({ kind: 'note', key: `ln${++segSeq}`, text: EMPTY_REPLY });
        break;
      }
      case 'error':
        live.segs.push({ kind: 'error', key: `le${++segSeq}`, text: String(p.message || '알 수 없는 오류') });
        break;
      default:
        return;
    }
    renderLiveSoon();
  }

  function applySnapshot(m) {
    lastSeq = Number.isFinite(m.seq) ? m.seq : 0;
    running = !!m.running;
    if (m.meta) { meta = { ...(meta || {}), ...m.meta }; shareMeta(key, meta); }
    locked = m.locked || null;
    const before = new Map(requests);
    requests.clear();
    for (const r of m.requests || []) if (r?.request_id) {
      requests.set(r.request_id, r);
      if (!records.has(r.request_id)) records.set(r.request_id, { state: 'pending' });
    }
    // Requests that vanished while we were away (reconnect) were settled somewhere else.
    for (const [rid, r] of before) {
      if (requests.has(rid) || answering.has(rid)) continue;
      const rec = { state: 'done', record: cancelRecord({ reason: 'gone' }, r.method) };
      records.set(rid, rec);
      if (live) for (const s of live.segs) if (s.kind === 'request' && s.request_id === rid) { s.state = 'done'; s.record = rec.record; }
    }
    composer.setQueue(m.queue || []);
    if (m.running && m.turn) {
      const t = m.turn;
      startLive(toMs(t.started_at) || turnStartedAt || Date.now(), true);
      turnStartedAt = live.startedAt;
      if (t.reasoning) live.segs.push({ kind: 'reasoning', key: `lr${++segSeq}`, text: t.reasoning, live: !t.text && !(t.tools || []).length, t0: Date.now() });
      const tools = t.tools || [];
      tools.forEach((x, i) => {
        // A "generating" entry followed by later calls is stale (e.g. Tool Search's tool_call,
        // whose tool.start names the inner tool): only the newest can still be generating.
        if (x.state === 'generating' && i < tools.length - 1) return;
        live.segs.push({ kind: 'call', key: `lt${++segSeq}`, call: { tool_id: x.tool_id, name: x.name, args: x.args ?? {}, state: x.state || 'running', preview: x.preview, duration_s: x.duration_s, error: x.error || null, startedAt: toMs(x.started_at) || undefined } });
      });
      if (t.text) live.segs.push({ kind: 'text', key: `lx${++segSeq}`, text: t.text });
    } else if (m.running) {
      if (!live) startLive(turnStartedAt || Date.now(), true);
    } else {
      if (live && !live.done) live = null;
      turnStartedAt = null;
    }
    // Pending requests get an inline placeholder at the end of the live turn (or transcript).
    for (const rid of requests.keys()) addRequestPlaceholder(rid);
    composer.setRunning(running);
    composer.setMeta(meta);
    if (m.error) {
      if (/session_locked/.test(String(m.error))) locked = locked || { surface: '다른 창' };
    }
    refreshHeader();
    renderDock();
    renderAll();
    if (snapshots++ > 0 && historyLoaded) loadLatest();
  }
  let snapshots = 0;

  function addRequestPlaceholder(rid) {
    if (live && !live.done) {
      if (!live.segs.some((s) => s.kind === 'request' && s.request_id === rid)) {
        // Remember the call it guards: the record line stays next to it once the turn is history.
        let afterTool;
        for (let i = live.segs.length - 1; i >= 0 && afterTool === undefined; i -= 1) if (live.segs[i].kind === 'call') afterTool = live.segs[i].call.tool_id || null;
        live.segs.push({ kind: 'request', key: `q:${rid}`, request_id: rid, method: requests.get(rid)?.method, state: 'pending', afterTool: afterTool || undefined });
      }
    } else if (!localItems.some((x) => x.request_id === rid)) {
      localItems.push({ id: `q:${rid}`, kind: 'request', request_id: rid, method: requests.get(rid)?.method, afterId: Infinity });
    }
  }

  function resolveRequest(rid, record) {
    requests.delete(rid);
    const rec = { state: 'done', record };
    records.set(rid, rec);
    if (live) for (const s of live.segs) if (s.kind === 'request' && s.request_id === rid) { s.state = 'done'; s.record = rec.record; }
    renderDock();
    refreshHeader();
    renderAll();
  }

  // ---------------------------------------------------------------- actions
  function lastUserPrompt() {
    for (let i = pending.length - 1; i >= 0; i -= 1) return pending[i].text;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i];
      if (r.role === 'user' && !r.omni && !isSteerRow(r)) return contentText(r.content);
    }
    return null;
  }

  let pSeq = 0;
  async function sendPrompt(text, mode = 'queue', atts = []) {
    const p = { id: ++pSeq, text, atts, state: 'sending', mode, persistAfter: maxRowId() };
    pending.push(p);
    mutate(renderPending);
    scrollToBottom();
    try {
      const res = await api.prompt(node, sid, text, mode === 'steer' ? 'steer' : 'queue');
      if (!alive) return true;
      if (res.status === 'queued') {
        pending.splice(pending.indexOf(p), 1);
        if (!queueFromServer) {
          localQueue.push({ text, at: Date.now() / 1000 });
          composer.setQueue(localQueue);
        }
      } else if (res.status === 'steered' && live && !live.done) {
        // Delivered into the running turn: show it there, at this point of the turn's flow.
        pending.splice(pending.indexOf(p), 1);
        live.segs.push({ kind: 'steer', key: `ls${++segSeq}`, text });
        renderLiveSoon();
      } else {
        p.state = 'sent';
        if (res.status === 'streaming' && !running) {
          running = true;
          turnStartedAt = Date.now();
          composer.setRunning(true);
          refreshHeader();
        }
        reloadSoon();
      }
      mutate(renderPending);
      return true;
    } catch (err) {
      if (!alive) return false;
      if (err.code === 'session_locked') {
        pending.splice(pending.indexOf(p), 1);
        locked = { surface: err.data?.surface || '다른 창' };
        refreshHeader();
        mutate(renderPending);
        return false;
      }
      p.state = 'failed';
      mutate(renderPending);
      return true;
    }
  }
  let queueFromServer = false;
  const localQueue = [];

  function retryPending(p) {
    pending.splice(pending.indexOf(p), 1);
    renderPending();
    sendPrompt(p.text, p.mode === 'steer' ? 'queue' : p.mode, p.atts);
  }

  async function interrupt() {
    try {
      await api.interrupt(node, sid);
    } catch (err) {
      toastError(err, '중단하지 못했어요');
    }
  }

  async function rename(preset) {
    const current = rowTitle(row);
    const apply = async (v) => {
      try {
        const res = await api.updateSession(node, sid, { title: v });
        patchSession(key, res.row || { title: v });
        refreshHeader();
        return null;
      } catch (err) {
        if (err.code === 'duplicate_title') return '같은 이름의 세션이 있어요';
        return errorText(err, '이름을 바꾸지 못했어요');
      }
    };
    if (preset) {
      const msg = await apply(preset);
      toast(msg || '이름을 바꿨어요', { tone: msg ? 'error' : 'info' });
      return;
    }
    await promptDialog({ title: '이름 변경', value: row?.title || current, ok: '저장', submit: apply });
  }

  async function togglePin() {
    const pinned = !row?.pinned;
    try {
      const res = await api.updateSession(node, sid, { pinned });
      patchSession(key, res.row || { pinned });
      toast(pinned ? '고정했어요' : '고정을 해제했어요');
    } catch (err) {
      toastError(err, '바꾸지 못했어요');
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: '세션을 삭제할까요?', body: '대화 기록이 노드에서 영구히 삭제돼요.', ok: '삭제', danger: true });
    if (!ok) return;
    try {
      await api.deleteSession(node, sid);
      forgetHistory(key);
      toast('삭제했어요');
      navigate('#/', { replace: true });
    } catch (err) {
      if (err.code === 'running' || err.status === 409) toast('실행 중인 세션은 삭제할 수 없어요', { tone: 'error' });
      else toastError(err, '삭제하지 못했어요');
    }
  }

  function exportJson() {
    download(api.exportUrl(node, sid), `${rowTitle(row)}.json`);
  }

  function openInfo(tab = '') {
    const t = tab === 'context' ? '?section=context' : tab ? `/${tab}` : '';
    navigate(`${sessionHref(node, sid)}/info${t.startsWith('?') ? t : t}`);
  }

  function openMoreMenu() {
    const n = findNode(node);
    openMenu(moreBtn, [
      { label: '세션 정보', icon: 'info', onSelect: () => openInfo() },
      { label: '이름 변경', icon: 'pencil', onSelect: () => rename() },
      { label: row?.pinned ? '고정 해제' : '고정', icon: 'pin', onSelect: () => togglePin() },
      { label: '내보내기 (JSON)', icon: 'download', onSelect: () => exportJson() },
      {
        label: '주소 복사', icon: 'copy',
        onSelect: async () => toast((await copyText(key)) ? '복사했어요' : `주소: ${key}`),
      },
      n?.dashboard_url ? { label: 'Hermes 대시보드 열기', icon: 'external', onSelect: () => window.open(n.dashboard_url, '_blank', 'noopener') } : null,
      'divider',
      { label: '삭제', icon: 'trash', danger: true, onSelect: () => remove() },
    ], { label: '세션 메뉴' });
  }

  function openModel(anchor, focus) {
    if (!nodeSupportsFeatures(node)) return;
    openModelSheet({
      node, sid, meta, anchor: anchor || null, running, focus,
      onMeta: (patch) => { meta = { ...(meta || {}), ...patch }; shareMeta(key, meta); composer.setMeta(meta); },
    });
  }

  let catalogCache = null;
  async function catalog() {
    if (catalogCache && Date.now() - catalogCache.at < 600000) return catalogCache.data;
    const data = await api.rpc(node, 'commands.catalog', {}, sid);
    catalogCache = { at: Date.now(), data };
    return data;
  }

  let localSeq = 0;
  function systemBlock(label, text, { error = false, markdown = false, rows: kv = null } = {}) {
    localItems.push({ id: `s${++localSeq}`, kind: 'system', label, text: String(text ?? ''), error, markdown, rows: kv, afterId: Infinity });
    // Pin the block after the last persisted row (it keeps its place when new turns arrive).
    localItems[localItems.length - 1].afterId = live && !live.done ? Infinity : maxRowId();
    mutate(renderTurns);
    scrollToBottom();
  }

  /** session.usage → label/value rows (rendered as a small table, not mono-aligned text). */
  function usageRows(u) {
    if (!u || typeof u !== 'object') return null;
    const rows = [];
    if (Number.isFinite(u.input) || Number.isFinite(u.output)) rows.push(['입력 / 출력 토큰', `${fmtInt(u.input || 0)} / ${fmtInt(u.output || 0)}`]);
    if (Number.isFinite(u.total)) rows.push(['합계', fmtInt(u.total)]);
    if (Number.isFinite(u.calls)) rows.push(['모델 호출', `${fmtInt(u.calls)}회`]);
    if (Number.isFinite(u.cache_hit_pct)) rows.push(['캐시 적중', `${Math.round(u.cache_hit_pct)}%`]);
    if (Number.isFinite(u.cost_usd) && u.cost_usd > 0) rows.push(['예상 비용', `${u.cost_usd.toFixed(2)}`]);
    return rows.length ? rows : null;
  }

  function usageText(u) {
    if (!u || typeof u !== 'object') return String(u ?? '');
    if (typeof u.output === 'string' && !Number.isFinite(u.input)) return u.output;
    const lines = [];
    if (Number.isFinite(u.input) || Number.isFinite(u.output)) lines.push(`입력 / 출력 토큰  ${fmtInt(u.input || 0)} / ${fmtInt(u.output || 0)}`);
    if (Number.isFinite(u.total)) lines.push(`합계            ${fmtInt(u.total)}`);
    if (Number.isFinite(u.calls)) lines.push(`모델 호출        ${fmtInt(u.calls)}회`);
    if (Number.isFinite(u.cache_hit_pct)) lines.push(`캐시 적중        ${Math.round(u.cache_hit_pct)}%`);
    if (Number.isFinite(u.cost_usd) && u.cost_usd > 0) lines.push(`예상 비용        $${u.cost_usd.toFixed(2)}`);
    return lines.join('\n') || JSON.stringify(u, null, 2);
  }

  async function compress() {
    try {
      const res = await api.rpc(node, 'session.compress', {}, sid, { timeout: 70000 });
      const b = res?.before_tokens ?? res?.before ?? res?.tokens_before;
      const a = res?.after_tokens ?? res?.after ?? res?.tokens_after;
      toast(Number.isFinite(b) && Number.isFinite(a) ? `압축했어요 · ${fmtTok(b)} → ${fmtTok(a)} 토큰` : '압축했어요');
    } catch (err) {
      toastError(err, '압축하지 못했어요');
    }
  }
  const fmtTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

  async function setYolo(on) {
    if (on) {
      const ok = await confirmDialog({ title: '자동 승인을 켤까요?', body: '이 세션의 모든 명령을 묻지 않고 실행해요. 계속할까요?', ok: '켜기' });
      if (!ok) return false;
    }
    try {
      await api.rpc(node, 'config.set', { key: 'yolo', value: on ? 'on' : 'off' }, sid);
      meta = { ...(meta || {}), yolo: on };
      shareMeta(key, meta);
      toast(on ? '자동 승인을 켰어요' : '자동 승인을 껐어요');
      return true;
    } catch (err) {
      toastError(err, '바꾸지 못했어요');
      return false;
    }
  }

  async function runSlash(text, item) {
    const m = text.trim().match(/^(\/[\w-]+)\s*([\s\S]*)$/);
    if (!m) return;
    const cmd = m[1];
    const arg = m[2].trim();
    switch (cmd) {
      case '/model': openModel(composer.el.querySelector('.model-chip')); return;
      case '/reasoning': openModel(composer.el.querySelector('.model-chip'), 'reasoning'); return;
      case '/fast':
        try {
          const on = !meta?.fast;
          await api.rpc(node, 'config.set', { key: 'fast', value: on ? 'on' : 'off' }, sid);
          meta = { ...(meta || {}), fast: on };
          shareMeta(key, meta);
          toast(on ? '빠른 모드를 켰어요' : '빠른 모드를 껐어요');
        } catch (err) { toastError(err, '바꾸지 못했어요'); }
        return;
      case '/compress': compress(); return;
      case '/title': rename(arg || undefined); return;
      case '/stop': interrupt(); return;
      case '/new': navigate('#/new'); return;
      case '/yolo': setYolo(!meta?.yolo); return;
      case '/export': exportJson(); return;
      case '/files': openInfo('files'); return;
      case '/status':
        try {
          const res = await api.rpc(node, 'session.status', {}, sid);
          systemBlock('/status', res?.output ?? usageText(res));
        } catch (err) { systemBlock('/status', `실행하지 못했어요: ${errorText(err)}`, { error: true }); }
        return;
      case '/usage':
        try {
          const res = await api.rpc(node, 'session.usage', {}, sid);
          const rowsU = usageRows(res);
          const counted = res && typeof res === 'object' && (res.input > 0 || res.output > 0 || res.calls > 0);
          if (rowsU && !counted) {
            // Counters restart with the node's agent; zeros here do not mean "nothing used".
            systemBlock('/usage', rows.length ? '노드가 다시 시작된 뒤로 집계된 사용량이 없어요' : '아직 사용량이 없어요');
          } else if (rowsU) systemBlock('/usage', '', { rows: rowsU });
          else systemBlock('/usage', usageText(res));
        } catch (err) { systemBlock('/usage', `실행하지 못했어요: ${errorText(err)}`, { error: true }); }
        return;
      default:
        break;
    }
    if (BLOCKED.has(cmd)) {
      systemBlock(cmd, '이 명령은 여기서 쓸 수 없어요', { error: true });
      return;
    }
    if (item?.kind === 'skill') {
      // Skills run as a normal prompt so the agent loads the skill.
      sendPrompt(text, 'queue');
      return;
    }
    try {
      const res = await api.rpc(node, 'slash.exec', { command: text.trim() }, sid);
      systemBlock(cmd, res?.output ?? JSON.stringify(res ?? {}, null, 2));
    } catch (err) {
      if (err.code === 'forbidden') { systemBlock(cmd, '이 명령은 여기서 쓸 수 없어요', { error: true }); return; }
      await dispatchCommand(cmd.slice(1), arg, 0);
    }
  }

  async function dispatchCommand(name, arg, depth) {
    try {
      const res = await api.rpc(node, 'command.dispatch', { name, arg: arg || undefined }, sid);
      const t = res?.type;
      if (t === 'send' || t === 'skill') sendPrompt(String(res.message || ''), 'queue');
      else if (t === 'prefill') { composer.setText(String(res.message || '')); composer.focus(); }
      else if (t === 'alias' && res.target && depth < 2) await runSlash(`/${String(res.target).replace(/^\//, '')} ${arg}`.trim());
      else systemBlock(`/${name}`, res?.output ?? res?.message ?? '');
    } catch (err) {
      systemBlock(`/${name}`, `실행하지 못했어요: ${errorText(err)}`, { error: true });
    }
  }

  // ---------------------------------------------------------------- live wiring
  const mine = (m) => m && m.node === node && m.stored_id === sid;
  const seenNow = () => {
    if (document.visibilityState !== 'visible') return;
    const r = getSession(node, sid);
    if (r) markSeen(key, r.last_active);
  };

  let unsub = null;
  function resubscribe() {
    unsub?.();
    unsub = socket.subscribe(node, sid);
  }

  const clock = setInterval(() => {
    if (running) {
      refreshHeader();
      if (live && !live.done) renderLiveSoon();
    }
  }, 1000);

  const offs = [
    bus.on('ws:session.snapshot', (m) => { if (mine(m)) applySnapshot(m); }),
    bus.on('ws:session.event', (m) => {
      if (!mine(m)) return;
      const seq = Number(m.seq);
      if (Number.isFinite(seq) && m.event_type !== 'message.start' && seq <= lastSeq && lastSeq - seq < 100000) return;
      if (Number.isFinite(seq)) lastSeq = seq;
      applyEvent(m.event_type, m.payload || {});
    }),
    bus.on('ws:session.state', (m) => {
      if (!mine(m)) return;
      if (typeof m.running === 'boolean' && m.running !== running) {
        running = m.running;
        composer.setRunning(running);
        if (running && !turnStartedAt) turnStartedAt = Date.now();
        if (!running) {
          turnStartedAt = null;
          if (live && !live.done) { live.done = true; reloadSoon(); }
        }
      }
      if (m.title) patchSession(key, { title: m.title });
      refreshHeader();
      renderLiveSoon();
    }),
    bus.on('ws:turn.done', (m) => {
      if (!mine(m)) return;
      running = false;
      turnStartedAt = null;
      composer.setRunning(false);
      if (live && !live.done) { live.done = true; live.status = m.status; }
      if (m.status === 'interrupted') pendingNote = { kind: 'note', key: `n${++segSeq}`, text: '중단됨' };
      else if (m.status === 'error') {
        const msg = m.error || m.message || '작업이 실패했어요';
        pendingNote = { kind: 'error', key: `n${++segSeq}`, text: msg, retry: () => { const t = lastUserPrompt(); if (t) sendPrompt(t, 'queue'); } };
      }
      localQueue.length = 0;
      if (!queueFromServer) composer.setQueue([]);
      for (const p of pending) if (p.mode === 'steer') p.state = 'sent';
      refreshHeader();
      reloadSoon.cancel();
      loadLatest();
      seenNow();
    }),
    bus.on('ws:session.meta', (m) => {
      if (!mine(m) || !m.meta) return;
      meta = { ...(meta || {}), ...m.meta };
      shareMeta(key, meta);
      composer.setMeta(meta);
    }),
    bus.on('ws:session.queue', (m) => {
      if (!mine(m)) return;
      queueFromServer = true;
      composer.setQueue(m.items || []);
    }),
    bus.on('ws:session.incoming', (m) => {
      if (!mine(m) || !m.delivery) return;
      if (!incoming.some((d) => d.id === m.delivery.id)) incoming.push(m.delivery);
      mutate(renderPending);
      seenNow();
    }),
    bus.on('ws:session.error', (m) => {
      if (!mine(m)) return;
      if (m.code === 'session_locked') { locked = { surface: m.surface || '다른 창' }; refreshHeader(); }
      else if (m.code === 'attach_failed') toast('세션에 연결하지 못했어요', { tone: 'error' });
    }),
    bus.on('ws:session.request', (m) => {
      if (!mine(m) || !m.request?.request_id) return;
      requests.set(m.request.request_id, m.request);
      records.set(m.request.request_id, { state: 'pending' });
      addRequestPlaceholder(m.request.request_id);
      renderDock();
      refreshHeader();
      renderAll();
      if (stickToBottom) scrollToBottom();
    }),
    bus.on('ws:session.request_cancel', (m) => {
      if (!mine(m) || !requests.has(m.request_id)) return;
      // Our own answer is in flight: its result (or failure) decides the record line.
      if (answering.has(m.request_id)) { answering.set(m.request_id, m); return; }
      resolveRequest(m.request_id, cancelRecord(m, requests.get(m.request_id)?.method));
    }),
    bus.on('ws:session.tip', (m) => {
      if (!alive || !m || m.node !== node || m.old !== sid || !m.new || m.new === sid) return;
      const newKey = `${node}#${m.new}`;
      if (composer.value) tipDrafts.set(newKey, composer.value);
      moveSeen(key, newKey);
      toast('컨텍스트를 압축해 이어지는 세션으로 옮겼어요');
      navigate(sessionHref(node, m.new), { replace: true });
    }),
    bus.on('ws:open', () => { /* ws.js re-sends our sub; the snapshot reconciles */ }),
    bus.on('sessions', () => {
      const r = getSession(node, sid);
      if (r !== row || (r && (r.title !== row?.title || r.pinned !== row?.pinned))) row = r || row;
      if (r && !live && typeof r.running === 'boolean' && r.running !== running && snapshots === 0) {
        running = r.running;
        composer.setRunning(running);
      }
      refreshHeader();
      seenNow();
    }),
    bus.on('nodes', () => {
      refreshHeader();
      // Node back: swap the offline copy (or the error line) for fresh history.
      if (isOnline(node) && (cachedAt || !historyLoaded) && !loadingFresh) {
        loadingFresh = true;
        loadLatest(!historyLoaded).finally(() => { loadingFresh = false; });
      }
    }),
  ];

  // ---------------------------------------------------------------- start
  fill(turnsEl, skeletonLines(3));
  refreshHeader();
  composer.setRunning(running);
  resubscribe();
  loadingFresh = true;
  loadLatest(true).finally(() => { loadingFresh = false; });
  seenNow();
  if (!coarse()) setTimeout(() => { if (alive && !locked) composer.focus(); }, 50);

  active.chat = {
    key, node, sid,
    insertText: (t) => composer.insertText(t),
    compress,
    setYolo,
    openModel: () => openModel(composer.el.querySelector('.model-chip')),
    get running() { return running; },
    get row() { return row; },
    exportJson,
    remove,
    rename: () => rename(),
  };

  return {
    key,
    destroy() {
      alive = false;
      clearInterval(clock);
      offs.forEach((off) => off());
      unsub?.();
      io?.disconnect();
      ro?.disconnect();
      window.visualViewport?.removeEventListener('resize', onViewport);
      reloadSoon.cancel();
      renderLiveSoon.cancel();
      renderSoon.cancel();
      saveScroll.flush();
      composer.destroy();
      if (active.chat?.key === key) active.chat = null;
    },
  };
}

function coarse() {
  return matchMedia('(pointer: coarse)').matches || !isDesktop();
}

