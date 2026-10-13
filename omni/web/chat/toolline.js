// Claude-Code-style tool activity (spec §3.4.1): one mono line per call — glyph, verb, target,
// duration — expandable to show arguments and result. ≥ 4 consecutive lines collapse into a
// "도구 N개 사용" group. Tool Search meta calls are unwrapped into their inner calls.

import { h, truncate, prettyJson, parseJsonMaybe, shortPath, fmtDuration, firstLine, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';
import { spinner } from '../ui/controls.js';

// clarify shows as a request card; Tool Search's discovery calls are plumbing, not work.
export const HIDDEN_TOOLS = new Set(['clarify', 'tool_search', 'tool_describe']);
export const AGENT_TOOLS = new Set(['hub_send']);

function argsObj(a) {
  if (a && typeof a === 'object') return a;
  return parseJsonMaybe(a) || {};
}

function pick(o, ...keys) {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function urlLabel(u) {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname === '/' ? '' : x.pathname}`;
  } catch { return u; }
}

/** Humanized verb + target (spec table §3.4.1). */
export function describeTool(name, rawArgs) {
  const a = argsObj(rawArgs);
  const n = String(name || 'tool');
  const path = (p) => shortPath(p, 40);
  switch (n) {
    case 'read_file': return { verb: 'Read', target: path(pick(a, 'path', 'file_path')) };
    case 'write_file': return { verb: 'Write', target: path(pick(a, 'path', 'file_path')) };
    case 'patch': {
      let p = pick(a, 'path', 'file_path');
      if (!p && typeof a.patch === 'string') {
        const m = a.patch.match(/^\+\+\+ (?:b\/)?(\S+)/m);
        if (m) p = m[1];
      }
      return { verb: 'Edit', target: path(p) };
    }
    case 'search_files': {
      const q = pick(a, 'pattern', 'query');
      const p = pick(a, 'path');
      return { verb: 'Search', target: p ? `${q} in ${path(p)}` : q };
    }
    case 'terminal': return { verb: 'Bash', target: firstLine(pick(a, 'command'), 200) };
    case 'read_terminal':
    case 'close_terminal': return { verb: 'Terminal', target: '' };
    case 'process_manage': return { verb: 'Process', target: [pick(a, 'action'), pick(a, 'id', 'process_id')].filter(Boolean).join(' ') };
    case 'execute_code': return { verb: 'Run', target: firstLine(pick(a, 'code'), 200) || pick(a, 'language') };
    case 'web_search':
    case 'x_search': return { verb: 'Web search', target: pick(a, 'query') };
    case 'web_extract': {
      const u = Array.isArray(a.urls) && a.urls.length ? String(a.urls[0]) : pick(a, 'url');
      return { verb: 'Fetch', target: u ? urlLabel(u) : '' };
    }
    case 'vision_analyze':
    case 'video_analyze': return { verb: 'View', target: path(pick(a, 'image_url', 'path')) };
    case 'image_generate': return { verb: 'Image', target: truncate(pick(a, 'prompt'), 40) };
    case 'todo_list': return { verb: 'Todo', target: Array.isArray(a.todos) ? `${a.todos.length}개` : Array.isArray(a.items) ? `${a.items.length}개` : '' };
    case 'memory': return { verb: 'Memory', target: pick(a, 'action') };
    case 'skill_view':
    case 'skills_list':
    case 'skill_manage': return { verb: 'Skill', target: pick(a, 'name') };
    case 'delegate_task': return { verb: 'Delegate', target: truncate(pick(a, 'goal', 'task'), 60) };
    case 'cronjob_manage': return { verb: 'Cron', target: pick(a, 'action') };
    case 'session_search': return { verb: 'Session search', target: pick(a, 'query') };
    case 'hub_directory': return { verb: 'Directory', target: pick(a, 'query') };
    case 'hub_inbox': return { verb: 'Inbox', target: '' };
    default: {
      if (n.startsWith('browser_')) {
        return { verb: 'Browser', target: [pick(a, 'action') || n.slice(8), pick(a, 'url') ? urlLabel(pick(a, 'url')) : ''].filter(Boolean).join(' ') };
      }
      // A Tool Search wrapper whose inner calls are not known yet (still generating).
      if (n === 'tool_call') return { verb: 'Tool call', target: '' };
      const first = Object.values(a).find((v) => typeof v === 'string' && v.trim());
      return { verb: n, target: first ? truncate(firstLine(first, 200), 60) : '' };
    }
  }
}

/**
 * Hermes Tool Search wraps deferred tools (plugin/MCP tools such as hub_send) in a meta call
 * `tool_call {"calls":[{"name":...,"arguments":...}]}`. Returns the inner calls or null.
 * When the model sent a payload Hermes cannot read (not JSON, or `calls` as a string of broken
 * JSON — the call then fails), the inner names are recovered by pattern and the calls are flagged
 * `malformed` (args stay the raw text).
 */
export function innerCalls(name, rawArgs) {
  if (name !== 'tool_call') return null;
  const a = argsObj(rawArgs);
  let calls = a?.calls;
  if (typeof calls === 'string') {
    const parsed = parseJsonMaybe(calls);
    if (Array.isArray(parsed) && parsed.length) calls = parsed;
    else return namesByPattern(calls);
  }
  if (Array.isArray(calls) && calls.length) return calls.map((c) => ({ name: c?.name || 'tool', args: c?.arguments ?? c?.args ?? {} }));
  if (typeof rawArgs !== 'string' || !rawArgs.trim() || parseJsonMaybe(rawArgs)) return null;
  return namesByPattern(rawArgs);
}

/** `"name": "x"` pairs in unparseable call JSON (quotes possibly escaped, key order free). */
function namesByPattern(text) {
  const names = [...String(text).matchAll(/\\*"name\\*"\s*:\s*\\*"([\w.:-]{1,64})\\*"/g)].map((m) => m[1]).filter((n) => n !== 'tool_call');
  return names.length ? names.map((n) => ({ name: n, args: text, malformed: true })) : null;
}

/** Results of a wrapped call come back as one payload; split per inner call when possible. */
export function splitInnerResult(result, count) {
  const o = parseJsonMaybe(result);
  const arr = Array.isArray(o) ? o : Array.isArray(o?.results) ? o.results : null;
  if (arr && arr.length === count) return arr.map((x) => (x && typeof x === 'object' && 'result' in x ? x.result : x));
  return null;
}

export function looksLikeError(content) {
  if (content && typeof content === 'object') {
    return !!(content.error || (Number.isInteger(content.exit_code) && content.exit_code !== 0) || content.success === false);
  }
  if (typeof content !== 'string') return false;
  const s = content.trim();
  if (!s.startsWith('{')) return /^(error|traceback)\b|^blocked:/i.test(s);
  const o = parseJsonMaybe(s);
  if (o) return !!(o.error || (Number.isInteger(o.exit_code) && o.exit_code !== 0) || o.success === false);
  // An error object followed by more text (Hermes appends "[Tool loop warning…]") is not JSON.
  return /^\{\s*"error"\s*:\s*(?!null\b|false\b|""|\{\s*\})/.test(s);
}

/** Why a call was refused, when Hermes blocked it (approval denied or timed out). */
export function blockedReason(t) {
  const texts = [];
  for (const v of [t.error, t.preview]) {
    if (typeof v === 'string') texts.push(v);
    else if (v && typeof v === 'object') texts.push(String(v.error || ''), String(v.output || ''));
  }
  const s = texts.join('\n');
  if (!/BLOCKED/.test(s)) return '';
  if (/timed out|timeout/i.test(s)) return '승인 시간 초과';
  if (/denied|rejected/i.test(s)) return '거부됨';
  return '차단됨';
}

/** Short reason shown after the target: blocked calls and calls the model sent malformed. */
function noteText(t) {
  if (isBusy(t)) return '';
  const b = blockedReason(t);
  if (b) return b;
  if (t.malformed) return '호출 형식 오류';
  return '';
}

const isBusy = (t) => t.state === 'generating' || t.state === 'running';

function glyph(t) {
  if (isBusy(t)) return spinner(12, 'tl-spin');
  if (t.state === 'error') return icon('x', 12, 'tl-x');
  // No result was recorded (the turn was cut off): neither ✓ nor ✗.
  if (t.state === 'unknown') return h('span', { class: 'tl-dot', title: '결과 없음' });
  return icon('check', 12, 'tl-ok');
}

function durationText(t, now) {
  if (isBusy(t)) {
    if (t.startedAt) {
      const s = (now - t.startedAt) / 1000;
      return s > 5 ? `${Math.floor(s)}s` : '';
    }
    return '';
  }
  return Number.isFinite(t.duration_s) ? fmtDuration(t.duration_s) : '';
}

/**
 * A tool line with in-place update(t). `expanded` is a Set of tool ids the user opened, so
 * re-renders keep expansion.
 */
export function createToolLine(t, expanded) {
  const g = h('span', { class: 'tl-glyph' });
  const verb = h('span', { class: 'tl-verb' });
  const target = h('span', { class: 'tl-target' });
  const note = h('span', { class: 'tl-note' });
  const dur = h('span', { class: 'tl-dur' });
  const head = h('button', { type: 'button', class: 'tl-head', 'aria-expanded': 'false' }, g, verb, target, note, dur);
  const detail = h('div', { class: 'tl-detail', hidden: true });
  const el = h('div', { class: 'tl' }, head, detail);
  let cur = t;
  let sig = '';

  const renderDetail = () => {
    fill(detail);
    const err = cur.error ? prettyJson(cur.error) : '';
    const args = prettyJson(cur.args);
    const res = prettyJson(cur.preview);
    if (err) add(detail, h('pre', { class: 'tl-pre err', text: truncate(err, 4000) }));
    if (args) add(detail, h('div', { class: 'tl-label', text: '입력' }), h('pre', { class: 'tl-pre', text: truncate(args, 4000) }));
    if (res) add(detail, h('div', { class: 'tl-label', text: '결과' }), h('pre', { class: 'tl-pre', text: truncate(res, 6000) }));
    if (cur.state === 'unknown' && !res) add(detail, h('div', { class: 'tl-label', text: '결과가 기록되지 않았어요' }));
    else if (!err && !args && !res) add(detail, h('div', { class: 'tl-label', text: isBusy(cur) ? '실행 중…' : '출력 없음' }));
  };

  head.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.classList.toggle('open', open);
    if (cur.id) {
      if (open) expanded?.add(cur.id);
      else expanded?.delete(cur.id);
    }
    if (open) renderDetail();
  });

  el.update = (nt, now = Date.now()) => {
    cur = nt;
    const d = describeTool(nt.name, nt.args);
    const n = noteText(nt);
    const nsig = `${nt.state}|${d.verb}|${d.target}|${n}`;
    if (nsig !== sig) {
      sig = nsig;
      fill(g, glyph(nt));
      verb.textContent = d.verb;
      target.textContent = d.target;
      target.title = d.target;
      target.hidden = !d.target;
      note.textContent = n;
      note.hidden = !n;
      el.dataset.state = nt.state;
    }
    dur.textContent = durationText(nt, now);
    if (!detail.hidden) renderDetail();
  };
  el.update(t);
  if (t.id && expanded?.has(t.id)) head.click();
  return el;
}

/**
 * Collapsed group for ≥ 4 consecutive tool lines. `lines` are tool line elements already built.
 * While live, the running line(s) are shown below the collapsed header.
 */
export function createToolGroup(groupId, expandedGroups) {
  const label = h('span', { class: 'tg-label' });
  const head = h('button', { type: 'button', class: 'tg-head', 'aria-expanded': 'false' }, icon('chevron-right', 14, 'tg-chev'), label);
  const body = h('div', { class: 'tg-body', hidden: true });
  const live = h('div', { class: 'tg-live' });
  const el = h('div', { class: 'tg' }, head, body, live);
  const setOpen = (open) => {
    body.hidden = !open;
    live.hidden = open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.classList.toggle('open', open);
  };
  let last = null;
  head.addEventListener('click', () => {
    const open = body.hidden;
    setOpen(open);
    if (open) expandedGroups?.add(groupId);
    else expandedGroups?.delete(groupId);
    if (last) el.update(...last);
  });
  setOpen(!!expandedGroups?.has(groupId));
  /** @param {HTMLElement[]} lineEls @param {object[]} tools */
  el.update = (lineEls, tools) => {
    last = [lineEls, tools];
    const total = tools.reduce((s, t) => s + (Number.isFinite(t.duration_s) ? t.duration_s : 0), 0);
    const errs = tools.filter((t) => t.state === 'error').length;
    label.textContent = `도구 ${tools.length}개 사용${total >= 1 ? ` · ${fmtDuration(total)}` : ''}${errs ? ` · 실패 ${errs}` : ''}`;
    const busyIdx = tools.map((t, i) => (isBusy(t) ? i : -1)).filter((i) => i >= 0);
    // Lines live in body; busy ones are mirrored into the live strip while collapsed.
    const bodyKids = lineEls.filter((_, i) => body.hidden ? !busyIdx.includes(i) : true);
    const liveKids = body.hidden ? busyIdx.map((i) => lineEls[i]) : [];
    syncChildren(body, bodyKids);
    syncChildren(live, liveKids);
  };
  return el;
}

/** Replace children only when the list actually changed (keeps focus/expansion stable). */
export function syncChildren(parent, kids) {
  const cur = parent.children;
  let same = cur.length === kids.length;
  if (same) for (let i = 0; i < kids.length; i += 1) if (cur[i] !== kids[i]) { same = false; break; }
  if (!same) fill(parent, ...kids);
}
