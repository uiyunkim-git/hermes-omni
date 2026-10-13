// #/s/<node>/<stored_id> — live chat with one Hermes session.
// Flow: load history (REST) → WS "sub" → apply session.snapshot → stream session.event deltas into
// the live turn (DOM updates batched per animation frame) → on turn.done reload history and drop
// the live bubble. Request cards (approval/clarify/sudo/secret) answer via /respond.

import { api } from '../api.js';
import { bus, findNode } from '../store.js';
import { socket } from '../ws.js';
import { h, clear, autosize, copyText, enc, shortTime, absTime, truncate, debounce, sessionHref } from '../util.js';
import { markdownBlock, renderMarkdown } from '../components/markdown.js';
import { toolChip, toolGroup } from '../components/tools.js';
import { requestCard } from '../components/requests.js';
import { agentBubble, parseOmni } from '../components/agentmsg.js';
import { toast, toastError } from '../components/toast.js';
import { confirmDialog, promptDialog } from '../components/dialog.js';

const HISTORY_LIMIT = 200;
const HISTORY_MAX = 1000;
const REASONING_TAIL = 6000;
const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;

// Unsent composer text carried across the remount that follows a session.tip (context
// compression gave the session a new stored id). Keyed "node\u0000new_sid"; consumed on mount.
const tipDrafts = new Map();

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  if (c === null || c === undefined) return '';
  try { return JSON.stringify(c); } catch { return String(c); }
}

export default function chatView(main, ctx) {
  const node = ctx.params.node;
  const sid = ctx.params.sid;
  let alive = true;
  let limit = HISTORY_LIMIT;
  let running = false;
  let title = '';
  let snapshots = 0;
  let lastSeq = 0;
  let turnSeq = 0;
  /** @type {null | {id:number, text:string, reasoning:string, tools:Array<object>, done:boolean, status:string|null, error:string|null}} */
  let live = null;
  const requests = new Map();        // request_id → request
  const pending = [];                // optimistic local prompts: {text, mode:'queue'|'redirect'}
  let historyLoaded = false;
  let historyError = null;

  // ---------------------------------------------------------------- layout
  const titleEl = h('h1', { class: 'chat-title', text: sid });
  const statusEl = h('span', { class: 'status-chip st-idle', role: 'status', 'aria-live': 'polite', text: 'idle' });
  const menu = buildMenu();
  const head = h('div', { class: 'chat-head' },
    h('a', { class: 'back icon-btn', href: `#/n/${enc(node)}`, 'aria-label': `Back to ${node}` }, '←'),
    h('div', { class: 'chat-head-text' }, titleEl, h('div', { class: 'chat-sub muted small' }, h('span', { class: 'mono', text: node }), ' ', statusEl)),
    menu);

  const moreBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', hidden: true, onclick: () => { limit = Math.min(HISTORY_MAX, limit * 3); loadHistory(true); } }, 'Load older messages');
  const historyEl = h('div', { class: 'history' });
  const liveEl = h('div', { class: 'live' });
  const pendingEl = h('div', { class: 'pending' });
  const reqEl = h('div', { class: 'live-requests', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'chat-scroll', role: 'log', 'aria-live': 'off', 'aria-label': 'Conversation' },
    h('div', { class: 'more' }, moreBtn), historyEl, liveEl, pendingEl, reqEl);

  const ta = h('textarea', {
    class: 'composer-input', rows: 1, placeholder: 'Message…', 'aria-label': 'Message',
    title: coarsePointer ? '' : 'Enter: send (queued) · Shift+Enter: newline · Ctrl+Enter: steer running turn',
    enterkeyhint: coarsePointer ? 'enter' : 'send', autocapitalize: 'sentences',
  });
  const sendBtn = h('button', { type: 'submit', class: 'btn btn-primary composer-send', 'aria-label': 'Send (queued)' }, 'Send');
  const steerBtn = h('button', { type: 'button', class: 'btn composer-steer', hidden: true, title: 'Redirect the running turn with this message', onclick: () => submit('redirect') }, 'Steer');
  const stopBtn = h('button', { type: 'button', class: 'btn btn-danger composer-stop', hidden: true, title: 'Interrupt the running turn', onclick: () => stop() }, 'Stop');
  const form = h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit('queue'); } },
    ta, h('div', { class: 'composer-btns' }, stopBtn, steerBtn, sendBtn));

  const root = h('div', { class: 'chat' }, head, scroller, form);
  main.append(root);

  ta.addEventListener('input', () => autosize(ta));
  const draftKey = `${node}\u0000${sid}`;
  if (tipDrafts.has(draftKey)) {
    ta.value = tipDrafts.get(draftKey);
    tipDrafts.delete(draftKey);
    requestAnimationFrame(() => autosize(ta));
  }
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || coarsePointer) return;
    e.preventDefault();
    submit(e.ctrlKey || e.metaKey ? 'redirect' : 'queue');
  });

  // ---------------------------------------------------------------- scrolling
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  function withScroll(mutate, forceBottom = false) {
    const stick = forceBottom || nearBottom();
    mutate();
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  // ---------------------------------------------------------------- title / menu
  function setTitle(t) {
    if (!t || t === title) return;
    title = t;
    titleEl.textContent = t;
    titleEl.title = t;
    ctx.setTitle(t);
  }

  async function resolveTitle() {
    const n = findNode(node);
    const p = n?.projects?.find((x) => x.canonical?.stored_id === sid);
    if (p?.canonical?.title) { setTitle(p.canonical.title); return; }
    try {
      const res = await api.sessions(node);
      const s = (res.sessions || []).find((x) => x.stored_id === sid);
      if (s?.title) setTitle(s.title);
    } catch { /* title is cosmetic */ }
  }

  function buildMenu() {
    const close = () => { det.open = false; };
    const item = (label, fn, cls = '') => h('button', { type: 'button', role: 'menuitem', class: `menu-item ${cls}`, onclick: () => { close(); fn(); } }, label);
    const det = h('details', { class: 'menu' },
      h('summary', { class: 'icon-btn', 'aria-label': 'Session actions' }, '⋯'),
      h('div', { class: 'menu-pop', role: 'menu' },
        item('Rename…', rename),
        item('Copy address', async () => {
          const ok = await copyText(`${node}#${sid}`);
          toast(ok ? 'Address copied' : `Address: ${node}#${sid}`, ok ? 'ok' : 'info');
        }),
        item('Messages for this session', () => ctx.navigate(`#/messages?address=${enc(`${node}#${sid}`)}`)),
        item('Reload history', () => loadHistory()),
        item('Delete session…', remove, 'danger')));
    document.addEventListener('click', onDocClick);
    function onDocClick(e) { if (det.open && !det.contains(e.target)) close(); }
    det.cleanup = () => document.removeEventListener('click', onDocClick);
    return det;
  }

  async function rename() {
    const t = await promptDialog({ title: 'Rename session', value: title || '', okLabel: 'Rename' });
    if (t === null || !t.trim()) return;
    try {
      await api.rename(node, sid, t.trim());
      setTitle(t.trim());
      toast('Renamed', 'ok', 2000);
    } catch (err) { toastError(err, 'Rename failed'); }
  }

  async function remove() {
    const ok = await confirmDialog({ title: 'Delete session?', message: `“${title || sid}” and its history will be deleted on ${node}.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteSession(node, sid);
      toast('Session deleted', 'ok');
      ctx.navigate(`#/n/${enc(node)}`);
    } catch (err) { toastError(err, 'Delete failed'); }
  }

  // ---------------------------------------------------------------- history
  let historySeq = 0;
  async function loadHistory(older = false) {
    const mySeq = ++historySeq;
    const finishedTurn = live?.done ? live.id : null;
    try {
      const res = await api.messages(node, sid, limit);
      if (!alive || mySeq !== historySeq) return;
      const rows = Array.isArray(res.messages) ? res.messages : [];
      historyError = null;
      const first = !historyLoaded;
      historyLoaded = true;
      const prevHeight = scroller.scrollHeight;
      const prevTop = scroller.scrollTop;
      withScroll(() => {
        renderHistory(rows);
        moreBtn.hidden = rows.length < limit || limit >= HISTORY_MAX;
        // The completed live turn is now part of history.
        if (finishedTurn !== null && live?.id === finishedTurn) { live = null; renderLiveNow(); }
      }, first);
      // Older rows were prepended: keep the same message under the user's eyes.
      if (older && !first) scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
    } catch (err) {
      if (!alive || mySeq !== historySeq) return;
      historyError = err.message;
      if (!historyLoaded) {
        clear(historyEl).append(h('div', { class: 'empty' },
          h('p', { class: 'warn-text', text: `Could not load history: ${err.message}` }),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => loadHistory() }, 'Retry')));
      } else {
        toastError(err, 'History refresh failed');
      }
    }
  }
  const reloadSoon = debounce(() => loadHistory(), 250);
  const reloadLater = debounce(() => loadHistory(), 1500);

  function renderHistory(rows) {
    // Re-renders happen after every turn; keep tool groups the user expanded open (matched by position).
    const openGroups = [...historyEl.querySelectorAll('.tool-group')].map((d) => d.open);
    renderHistoryRows(rows);
    historyEl.querySelectorAll('.tool-group').forEach((d, i) => { if (openGroups[i]) d.open = true; });
  }

  function renderHistoryRows(rows) {
    clear(historyEl);
    if (!rows.length) {
      historyEl.append(h('div', { class: 'empty chat-empty' },
        h('p', { class: 'empty-title', text: 'No messages yet' }),
        h('p', { class: 'muted', text: 'Say hello — the agent works in this session’s folder.' })));
      return;
    }
    let toolRun = [];
    const flushTools = () => {
      if (toolRun.length) historyEl.append(h('div', { class: 'row row-tools' }, toolGroup(toolRun)));
      toolRun = [];
    };
    for (const r of rows) {
      const text = contentText(r.content);
      const hasCalls = r.role === 'assistant' && Array.isArray(r.tool_calls) && r.tool_calls.length;
      if (r.role === 'tool') { toolRun.push(r); continue; }
      if (hasCalls && !text.trim()) { toolRun.push(r); continue; }
      flushTools();
      if (r.role === 'user') {
        const omni = parseOmni(text);
        historyEl.append(omni ? agentBubble(omni, r.timestamp) : userBubble(text, r.timestamp));
      } else if (r.role === 'assistant') {
        historyEl.append(assistantBubble(text, r.timestamp));
        if (hasCalls) toolRun.push({ ...r, content: '' });
      } else if (text.trim()) {
        historyEl.append(h('details', { class: 'row row-system' },
          h('summary', { class: 'muted small', text: `${r.role || 'system'} message` }),
          h('pre', { class: 'code', text: truncate(text, 8000) })));
      }
    }
    flushTools();
  }

  function userBubble(text, ts) {
    return h('div', { class: 'row row-user' },
      h('div', { class: 'bubble bubble-user' },
        h('div', { class: 'user-text', text }),
        ts ? h('time', { class: 'bubble-time', title: absTime(ts), text: shortTime(ts) }) : null));
  }

  function assistantBubble(text, ts) {
    return h('div', { class: 'row row-assistant' },
      h('div', { class: 'bubble bubble-assistant' },
        markdownBlock(text),
        ts ? h('time', { class: 'bubble-time', title: absTime(ts), text: shortTime(ts) }) : null));
  }

  // ---------------------------------------------------------------- live turn
  const liveDom = { wrap: null, reasoning: null, reasoningPre: null, tools: null, md: null, foot: null };
  let rafId = 0;
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; renderLiveNow(); });
  }

  function newLive() {
    return { id: ++turnSeq, text: '', reasoning: '', tools: [], done: false, status: null, error: null };
  }

  function renderLiveNow() {
    if (!alive) return;
    withScroll(() => {
      if (!live) {
        clear(liveEl);
        liveDom.wrap = null;
        return;
      }
      if (!liveDom.wrap) {
        liveDom.reasoningPre = h('div', { class: 'reasoning-text' });
        liveDom.reasoning = h('details', { class: 'reasoning', hidden: true }, h('summary', { class: 'muted small' }, 'Reasoning'), liveDom.reasoningPre);
        liveDom.tools = h('div', { class: 'chips' });
        liveDom.md = h('div', { class: 'md' });
        liveDom.foot = h('div', { class: 'live-foot muted small' });
        liveDom.wrap = h('div', { class: 'row row-assistant' },
          h('div', { class: 'bubble bubble-assistant live-bubble' }, liveDom.reasoning, liveDom.tools, liveDom.md, liveDom.foot));
        clear(liveEl).append(liveDom.wrap);
      }
      liveDom.reasoning.hidden = !live.reasoning;
      if (live.reasoning) {
        const r = live.reasoning;
        liveDom.reasoningPre.textContent = r.length > REASONING_TAIL ? `…${r.slice(-REASONING_TAIL)}` : r;
      }
      clear(liveDom.tools);
      for (const t of live.tools) liveDom.tools.append(toolChip(t));
      renderMarkdown(liveDom.md, live.text);
      liveDom.md.classList.toggle('streaming', !live.done);
      clear(liveDom.foot);
      if (live.error) liveDom.foot.append(h('span', { class: 'warn-text', text: `Error: ${live.error}` }));
      if (!live.done) {
        liveDom.foot.append(h('span', { class: 'typing', 'aria-label': 'Agent is working' }, h('i'), h('i'), h('i')));
      } else if (live.status && live.status !== 'complete') {
        liveDom.foot.append(h('span', { class: 'status-chip st-error', text: live.status }));
      }
    });
  }

  function findTool(pred) {
    for (let i = live.tools.length - 1; i >= 0; i -= 1) if (pred(live.tools[i])) return live.tools[i];
    return null;
  }

  function applyEvent(type, p) {
    p = p || {};
    if (type === 'message.start') {
      live = newLive();
      setRunning(true);
      const idx = pending.findIndex((x) => x.mode === 'queue');
      if (idx >= 0) pending.splice(idx, 1);
      renderPending();
      reloadSoon();                        // shows the user row that started this turn
      scheduleRender();
      return;
    }
    if (!live) live = newLive();           // joined mid-turn without snapshot
    switch (type) {
      case 'message.delta':
        live.text += p.text || '';
        break;
      case 'reasoning.delta':
        live.reasoning += p.text || '';
        if (live.reasoning.length > REASONING_TAIL * 4) live.reasoning = live.reasoning.slice(-REASONING_TAIL * 2);
        break;
      case 'tool.generating':
        live.tools.push({ name: p.name, state: 'generating' });
        break;
      case 'tool.start': {
        const t = findTool((x) => x.state === 'generating' && x.name === p.name && !x.tool_id);
        if (t) Object.assign(t, { tool_id: p.tool_id, state: 'running', args: p.args });
        else live.tools.push({ tool_id: p.tool_id, name: p.name, state: 'running', args: p.args });
        break;
      }
      case 'tool.complete': {
        let t = p.tool_id ? findTool((x) => x.tool_id === p.tool_id) : null;
        if (!t) t = findTool((x) => x.name === p.name && (x.state === 'running' || x.state === 'generating'));
        if (!t) { t = { name: p.name }; live.tools.push(t); }
        Object.assign(t, {
          state: p.error ? 'error' : 'done', duration_s: p.duration_s, error: p.error || null,
          preview: p.result_preview ?? t.preview,
        });
        break;
      }
      case 'message.complete':
        if (typeof p.text === 'string' && p.text) live.text = p.text;
        live.done = true;
        live.status = p.status || 'complete';
        for (const t of live.tools) if (t.state === 'generating' || t.state === 'running') t.state = 'done';
        clearPending('redirect');
        reloadLater();                     // turn.done normally triggers this sooner
        break;
      case 'error':
        live.error = p.message || 'error';
        break;
      default:
        return;
    }
    scheduleRender();
  }

  function applySnapshot(msg) {
    snapshots += 1;
    lastSeq = Number.isFinite(msg.seq) ? msg.seq : 0;
    setRunning(!!msg.running);
    requests.clear();
    for (const r of msg.requests || []) if (r?.request_id) requests.set(r.request_id, r);
    renderRequests();
    if (msg.running && msg.turn) {
      const t = msg.turn;
      live = newLive();
      live.text = t.text || '';
      live.reasoning = t.reasoning || '';
      live.tools = (t.tools || []).map((x) => ({ tool_id: x.tool_id, name: x.name, state: x.state || 'running', preview: x.preview }));
    } else if (!msg.running) {
      if (live && !live.done) live = null;
      pending.length = 0;
      renderPending();
    }
    scheduleRender();
    // After a reconnect we may have missed whole turns.
    if (snapshots > 1 || historyError) loadHistory();
  }

  function setRunning(r) {
    running = r;
    statusEl.textContent = r ? 'running' : 'idle';
    statusEl.className = `status-chip ${r ? 'st-running' : 'st-idle'}`;
    stopBtn.hidden = !r;
    steerBtn.hidden = !r;
    sendBtn.textContent = r ? 'Queue' : 'Send';
    sendBtn.setAttribute('aria-label', r ? 'Queue message after the running turn' : 'Send message');
  }

  // ---------------------------------------------------------------- pending + requests
  function renderPending() {
    withScroll(() => {
      clear(pendingEl);
      for (const p of pending) {
        pendingEl.append(h('div', { class: 'row row-user pending-row' },
          h('div', { class: 'bubble bubble-user is-pending' },
            h('div', { class: 'user-text', text: p.text }),
            h('span', { class: 'bubble-time', text: p.mode === 'redirect' ? 'steering…' : 'queued' }))));
      }
    });
  }

  function clearPending(mode) {
    for (let i = pending.length - 1; i >= 0; i -= 1) if (pending[i].mode === mode) pending.splice(i, 1);
    renderPending();
  }

  // Cards are added/removed individually so text typed into one card survives updates to another.
  const cardEls = new Map();         // request_id → element
  function renderRequests() {
    withScroll(() => {
      for (const [id, el] of cardEls) {
        if (!requests.has(id)) { el.remove(); cardEls.delete(id); }
      }
      for (const [id, r] of requests) {
        if (cardEls.has(id)) continue;
        const el = requestCard({ node, stored_id: sid, request: r }, {
          onAnswered: (rid) => setTimeout(() => { requests.delete(rid); renderRequests(); }, 1200),
        });
        cardEls.set(id, el);
        reqEl.append(el);
      }
    }, requests.size > 0);
  }

  // ---------------------------------------------------------------- composer
  let sending = false;
  async function submit(mode) {
    const text = ta.value.trim();
    if (!text || sending) return;
    if (mode === 'redirect' && !running) mode = 'queue';
    sending = true;
    sendBtn.disabled = steerBtn.disabled = true;
    try {
      const res = await api.prompt(node, sid, text, mode);
      ta.value = '';
      autosize(ta);
      if (res.status === 'queued') {
        pending.push({ text, mode: 'queue' });
        renderPending();
      } else if (res.status === 'redirected') {
        pending.push({ text, mode: 'redirect' });
        renderPending();
        toast('Steering the running turn', 'info', 2000);
      } else {
        setRunning(true);
        reloadSoon();
      }
      scroller.scrollTop = scroller.scrollHeight;
    } catch (err) {
      toastError(err, 'Send failed');
    } finally {
      sending = false;
      sendBtn.disabled = steerBtn.disabled = false;
      if (!coarsePointer) ta.focus();
    }
  }

  async function stop() {
    stopBtn.disabled = true;
    try {
      await api.interrupt(node, sid);
      toast('Interrupt sent', 'info', 1500);
    } catch (err) {
      toastError(err, 'Stop failed');
    } finally {
      stopBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- wiring
  const mine = (m) => m && m.node === node && m.stored_id === sid;
  const offs = [
    bus.on('ws:session.snapshot', (m) => { if (mine(m)) applySnapshot(m); }),
    bus.on('ws:session.event', (m) => {
      if (!mine(m)) return;
      const seq = Number(m.seq);
      if (Number.isFinite(seq) && m.event_type !== 'message.start' && seq <= lastSeq && lastSeq - seq < 100000) return; // replayed
      if (Number.isFinite(seq)) lastSeq = seq;
      applyEvent(m.event_type, m.payload);
    }),
    bus.on('ws:session.state', (m) => {
      if (!mine(m)) return;
      if (typeof m.running === 'boolean') {
        setRunning(m.running);
        if (!m.running && live && !live.done) { live.done = true; scheduleRender(); reloadLater(); }
      }
      if (m.title) setTitle(m.title);
    }),
    bus.on('ws:turn.done', (m) => {
      if (!mine(m)) return;
      if (live && !live.done) {
        live.done = true;
        live.status = m.status;
        if (m.text && !live.text) live.text = m.text;
        scheduleRender();
      }
      clearPending('redirect');
      reloadLater.cancel();
      reloadSoon();
    }),
    bus.on('ws:session.request', (m) => {
      if (!mine(m) || !m.request?.request_id) return;
      requests.set(m.request.request_id, m.request);
      renderRequests();
    }),
    bus.on('ws:session.request_cancel', (m) => {
      if (!mine(m)) return;
      if (requests.delete(m.request_id)) renderRequests();
    }),
    // Context compression moved the session tip; from now on the hub tags every frame with the
    // new stored id. Remount on it (replacing the URL so reload/back use it): cleanup unsubs the
    // old id and the new mount subscribes the new one.
    bus.on('ws:session.tip', (m) => {
      if (!alive || !m || m.node !== node || m.old !== sid || !m.new || m.new === sid) return;
      if (ta.value) tipDrafts.set(`${node}\u0000${m.new}`, ta.value);
      toast('Context compressed — now following the continued session', 'info', 2500);
      ctx.navigate(sessionHref(node, m.new), { replace: true });
    }),
  ];

  setRunning(false);
  resolveTitle();
  let unsub = null;
  historyEl.append(h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Loading history…'));
  loadHistory().finally(() => {
    if (alive) unsub = socket.subscribe(node, sid);
  });
  if (!coarsePointer) setTimeout(() => ta.focus(), 0);

  return () => {
    alive = false;
    if (rafId) cancelAnimationFrame(rafId);
    reloadSoon.cancel();
    reloadLater.cancel();
    offs.forEach((off) => off());
    menu.cleanup?.();
    unsub?.();
  };
}
