// Home (spec §3.2): one list of every session on every node. App bar with the attention pill,
// search and settings; node/status filter chips; sections (승인 필요 · 고정됨 · 최근 | 폴더별);
// dense three-line rows; pull-to-refresh; FAB "새 세션" (mobile).

import { api, errorText } from '../api.js';
import {
  bus, state, needsYou, rowTitle, folderLabel, sourceLabel, isUnread, attentionRows, patchSession,
  replaceSessions, removeSessions,
} from '../store.js';
import { socket } from '../ws.js';
import { navigate } from '../router.js';
import { h, relTime, ls, debounce, sessionHref, mq, firstLine, josaWa, stripMd, displayText, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';
import { iconButton, spinner, skeletonRows, skeletonLines, emptyState, button } from '../ui/controls.js';
import { openMenu, onLongPress } from '../ui/menu.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { attachPullToRefresh } from '../ui/ptr.js';

const GROUP_KEY = 'omni.home.group';
const NODE_KEY = 'omni.home.node';
const FLAGS_KEY = 'omni.home.flags';

// Verbs come from the link's tool_activity() ("Bash · npm test"); anything else is a raw tool
// name (e.g. Tool Search's `tool_call` wrapper) and reads as plain "도구 실행 중".
const TOOL_ACTIVITY = {
  Bash: '명령 실행 중', Run: '코드 실행 중', Read: '파일 읽는 중', Write: '파일 쓰는 중', Edit: '파일 고치는 중',
  Search: '검색 중', 'Web search': '웹 검색 중', Fetch: '웹 페이지 읽는 중', Browser: '브라우저 사용 중',
  View: '이미지 보는 중', Image: '이미지 만드는 중', Memory: '메모리 정리 중', Skill: '스킬 읽는 중',
  Delegate: '하위 작업 맡기는 중', 'Session search': '지난 대화 찾는 중', Message: '다른 세션에 메시지 보내는 중',
  Directory: '세션 찾는 중', Inbox: '받은 메시지 확인 중', Cron: '예약 작업 다루는 중',
};

const WAITING = { clarify: '답변 대기 중', sudo: '비밀번호 대기 중', secret: '입력 대기 중' };

/**
 * Fill `el` with `text`, wrapping each [start, end) range in <mark>. Ranges come from the link
 * in Python string indices (code points), so the text is split by code point, not UTF-16 unit.
 * Text nodes only: nothing in the snippet is parsed as HTML.
 */
function highlightInto(el, text, ranges) {
  const cps = Array.from(text);
  const spans = ranges
    .filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[1] > r[0])
    .map(([s, e]) => [Math.max(0, s), Math.min(cps.length, e)])
    .sort((a, b) => a[0] - b[0]);
  fill(el);
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos || s >= e) continue;      // overlapping or empty after clamping
    if (s > pos) add(el, cps.slice(pos, s).join(''));
    add(el, h('mark', { text: cps.slice(s, e).join('') }));
    pos = e;
  }
  if (pos < cps.length) add(el, cps.slice(pos).join(''));
}

// JSON escapes (tool arguments are stored JSON-encoded, sometimes twice), markdown markers (headings
// also mid-line: snippets arrive flattened to one line), Hermes' steer marker and runs of whitespace:
// dropped from search snippets.
const SNIPPET_NOISE = /\\+[nrt]|\\+"|\\{2,}|\[\/?OUT-OF-BAND USER MESSAGE[^\]\n]*\]|```[\w-]*|\*\*|__|~~|`|(?<=^|[\n\r]|\\n)#{1,6} |(?<= )#{2,6} |\s{2,}|[\n\r\t]/gu;

/**
 * Snippet text without encoding noise, with highlight ranges (code point indices) moved to match.
 * `\n`/`\t` escapes and newlines become a space, `\"` a quote, a run of backslashes one backslash;
 * the other SNIPPET_NOISE matches disappear (whitespace runs collapse to one space).
 */
function cleanSnippet(text, ranges = []) {
  const map = [];        // old code point index → new code point index
  let out = '';
  let outLen = 0;
  let last = 0;          // UTF-16 offset in `text`
  let oldCp = 0;
  const keep = (chunk) => {
    for (const ch of chunk) {
      map[oldCp] = outLen;
      oldCp += 1;
      if (ch === ' ' && out.endsWith(' ')) continue;
      out += ch;
      outLen += 1;
    }
  };
  const replace = (match, repl) => {
    const at = outLen;
    const n = Array.from(match).length;
    for (let k = 0; k < n; k += 1) map[oldCp + k] = at;
    oldCp += n;
    if (repl && !(repl === ' ' && out.endsWith(' '))) { out += repl; outLen += 1; }
  };
  for (const m of text.matchAll(SNIPPET_NOISE)) {
    keep(text.slice(last, m.index));
    const t = m[0];
    const repl = /^\\+"$/.test(t) ? '"' : /^\\{2,}$/.test(t) ? '\\' : /^(\\+[nrt]|\s+)$/.test(t) ? ' ' : '';
    replace(t, repl);
    last = m.index + t.length;
  }
  keep(text.slice(last));
  map[oldCp] = outLen;
  const moved = ranges
    .filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]))
    .map(([s, e]) => [map[Math.max(0, Math.min(s, oldCp))], map[Math.max(0, Math.min(e, oldCp))]])
    .filter(([s, e]) => e > s);
  return { text: out, ranges: moved };
}

/** Case-insensitive ranges of the query's words in `text` (code point indices). */
function termRanges(text, q) {
  const words = String(q).trim().split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
  if (!words.length) return [];
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const re = new RegExp(esc.join('|'), 'giu');
  const out = [];
  for (const m of text.matchAll(re)) {
    const s = Array.from(text.slice(0, m.index)).length;
    out.push([s, s + Array.from(m[0]).length]);
  }
  return out;
}

/** What a waiting row waits for: "승인 대기 중 · rm -rf …" (the command comes from the activity). */
function waitingText(row) {
  const item = (state.requests.items || []).find((it) => it.node === row.node && it.stored_id === row.stored_id);
  const label = WAITING[item?.method] || '승인 대기 중';
  const m = String(row.activity?.text || '').match(/^[A-Za-z][\w ]*? · (.*)$/);
  return m && label === '승인 대기 중' ? `${label} · ${m[1]}` : label;
}

/** Live activity line for a running or waiting row (replaces the preview). */
export function activityText(row) {
  if (needsYou(row)) return waitingText(row);
  if (!row.running) return null;
  if (row.collab?.direction === 'out' && row.collab.peer_title) return `답장 대기 중 · ${row.collab.peer_title}`;
  const a = row.activity;
  if (!a || !a.kind) return null;
  if (a.kind === 'thinking') return '생각 중…';
  if (a.kind === 'writing') return '답변 쓰는 중…';
  const t = String(a.text || '').trim();
  const m = t.match(/^([A-Za-z][\w ]*?) · (.*)$/);
  if (m) return TOOL_ACTIVITY[m[1]] ? `${TOOL_ACTIVITY[m[1]]} · ${m[2]}` : `도구 실행 중 · ${m[2]}`;
  return TOOL_ACTIVITY[t] || '도구 실행 중';
}

function statusEl(row) {
  if (row.node_online === false) return h('span', { class: 'rs rs-off', text: '오프라인' });
  if (needsYou(row)) return h('span', { class: 'badge-warn', text: '승인 필요' });
  if (row.running) return h('span', { class: 'rs rs-run' }, spinner(10), h('span', { text: '실행 중' }));
  if (row.last_turn_status === 'error') return h('span', { class: 'rs rs-err', text: '오류' });
  if (row.collab?.peer_title) {
    return h('span', { class: 'rs rs-collab' }, icon('link', 12), h('span', { text: `${row.collab.peer_title}${josaWa(row.collab.peer_title)} 대화 중` }));
  }
  return null;
}

function previewEl(row) {
  const act = activityText(row);
  if (act) return h('span', { class: `sr-preview ${needsYou(row) ? 'is-waiting' : 'is-activity'}`, text: act });
  const p = row.preview;
  if (p && p.text) {
    const text = stripMd(displayText(p.text));
    if (p.role === 'agent') {
      // Inline icon + text in one block line so the ellipsis applies to the whole preview.
      return h('span', { class: 'sr-preview' }, icon('link', 12, 'sr-agent'), `${p.from_title || p.from || '다른 세션'}: ${text}`);
    }
    return h('span', { class: 'sr-preview', text });
  }
  if (row.first_prompt) return h('span', { class: 'sr-preview faint', text: firstLine(displayText(row.first_prompt), 140) });
  return h('span', { class: 'sr-preview faint', text: '메시지 없음' });
}

/** One session row (anchor + hover menu button). */
function sessionRow(row, { selected, unread, onMenu }) {
  const meta = [row.node_name || row.node, folderLabel(row), sourceLabel(row.source)].filter(Boolean).join(' · ');
  const st = statusEl(row);
  const link = h('a', {
    class: 'srow', href: sessionHref(row.node, row.stored_id),
    'aria-current': selected ? 'page' : undefined,
    'aria-label': `${rowTitle(row)}${needsYou(row) ? ', 승인 필요' : row.running ? ', 실행 중' : ''}${unread ? ', 새 메시지' : ''}`,
  },
  h('span', { class: 'sr-dot', 'aria-hidden': 'true' }, unread ? h('i') : null),
  h('span', { class: 'sr-main' },
    h('span', { class: 'sr-l1' },
      h('span', { class: 'sr-title', text: rowTitle(row) }),
      h('span', { class: 'sr-time', text: relTime(row.last_active) })),
    previewEl(row),
    h('span', { class: 'sr-l3' }, h('span', { class: 'sr-meta', text: meta }), st)));
  const more = h('button', {
    type: 'button', class: 'srow-more icon-btn', 'aria-label': '세션 메뉴', tabindex: '-1',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); onMenu(more); },
  }, icon('more', 18));
  const wrap = h('div', {
    class: `srow-wrap${selected ? ' selected' : ''}${row.node_online === false ? ' offline' : ''}`,
    dataset: { key: row.key },
  }, link, more);
  onLongPress(link, (pt) => onMenu(pt));
  return wrap;
}

/**
 * @param {HTMLElement} root
 * @param {{selectedKey: () => string|null}} opts
 */
export function mountHome(root, opts) {
  let group = ls.get(GROUP_KEY, 'recent') === 'folder' ? 'folder' : 'recent';
  let nodeFilter = ls.get(NODE_KEY, '') || '';
  const flags = ls.json(FLAGS_KEY, {}) || {};
  let fRunning = !!flags.running;
  let fAttention = !!flags.attention;
  let searchMode = false;
  let query = '';
  let searchRes = null;            // {q, loading, results, error}
  const expandedFolders = new Set();
  const rowCache = new Map();      // key → {sig, el}

  // ---------------------------------------------------------------- app bar
  const pill = h('button', { type: 'button', class: 'attn-pill', hidden: true, onclick: () => jumpToAttention() });
  const searchBtn = iconButton('search', '세션 검색', () => enterSearch());
  const refreshBtn = iconButton('refresh', '새로 고침', () => refresh(true), { cls: 'desk-only' });
  const settingsBtn = h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': '설정', title: '설정' }, icon('settings', 20));
  const titleRow = h('div', { class: 'appbar-row' },
    h('h1', { class: 'home-title', text: 'Hermes' }), h('span', { class: 'appbar-spacer' }), pill, searchBtn, refreshBtn, settingsBtn);
  const searchInput = h('input', {
    class: 'search-input', type: 'search', placeholder: '세션 검색', 'aria-label': '세션 검색',
    autocomplete: 'off', enterkeyhint: 'search', spellcheck: 'false',
  });
  const searchBar = h('div', { class: 'appbar-row search-row', hidden: true },
    h('div', { class: 'search-field' }, icon('search', 18), searchInput),
    h('button', { type: 'button', class: 'btn-text', text: '취소', onclick: () => exitSearch() }));
  const bar = h('header', { class: 'appbar home-bar' }, titleRow, searchBar);

  // ---------------------------------------------------------------- filters
  const filterRow = h('div', { class: 'filter-row', role: 'toolbar', 'aria-label': '필터' });
  const sortBtn = h('button', { type: 'button', class: 'sort-btn', onclick: () => { group = group === 'recent' ? 'folder' : 'recent'; ls.set(GROUP_KEY, group); renderFilters(); renderList(); } });
  const filterWrap = h('div', { class: 'filter-wrap' }, filterRow, sortBtn);

  function chip(label, on, onClick, dot) {
    return h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: onClick },
      dot ? h('span', { class: `chip-dot ${dot}`, 'aria-hidden': 'true' }) : null, h('span', { text: label }));
  }

  function renderFilters() {
    const kids = [chip('전체', !nodeFilter, () => setNode(''))];
    for (const n of state.nodes) {
      kids.push(chip(n.display_name || n.node_id, nodeFilter === n.node_id, () => setNode(nodeFilter === n.node_id ? '' : n.node_id), n.online ? 'on' : 'off'));
    }
    kids.push(chip('실행 중', fRunning, () => { fRunning = !fRunning; saveFlags(); renderFilters(); renderList(); }));
    kids.push(chip('승인 필요', fAttention, () => { fAttention = !fAttention; saveFlags(); renderFilters(); renderList(); }));
    fill(filterRow, ...kids);
    fill(sortBtn, icon(group === 'recent' ? 'sort' : 'folder', 16), h('span', { text: group === 'recent' ? '최근순' : '폴더별' }));
    sortBtn.setAttribute('aria-label', `정렬: ${group === 'recent' ? '최근순' : '폴더별'} (바꾸기)`);
  }
  const saveFlags = () => ls.setJson(FLAGS_KEY, { running: fRunning, attention: fAttention });
  function setNode(n) {
    nodeFilter = n;
    ls.set(NODE_KEY, n || null);
    renderFilters();
    renderList();
  }

  // ---------------------------------------------------------------- list
  const newBtn = h('div', { class: 'desk-new' }, button('새 세션', { variant: 'secondary', icon: 'plus', onClick: () => navigate('#/new'), cls: 'btn-block' }));
  const listEl = h('div', { class: 'session-list' });
  const scroller = h('div', { class: 'home-scroll' }, newBtn, listEl);
  const fab = h('a', { class: 'fab', href: '#/new', 'aria-label': '새 세션' }, icon('plus', 20), h('span', { text: '새 세션' }));
  const view = h('section', { class: 'home', 'aria-label': '세션' }, bar, filterWrap, h('div', { class: 'home-body' }, scroller), fab);
  fill(root, view);

  function matchesQuery(r, q) {
    if (!q) return true;
    const hay = [rowTitle(r), r.first_prompt || '', folderLabel(r), r.node_name || '', r.node || ''].join('\n').toLowerCase();
    return hay.includes(q) || String(r.stored_id).toLowerCase().startsWith(q);
  }

  function filtered() {
    const q = query.trim().toLowerCase();
    // Hermes-internal hidden sessions (Bot Mode "Bot Chat") only show while they need the user.
    let rows = [...state.sessions.values()].filter((r) => !r.hidden || r.running || needsYou(r));
    if (nodeFilter && state.nodes.some((n) => n.node_id === nodeFilter)) rows = rows.filter((r) => r.node === nodeFilter);
    if (fRunning) rows = rows.filter((r) => r.running);
    if (fAttention) rows = rows.filter(needsYou);
    if (q) rows = rows.filter((r) => matchesQuery(r, q));
    rows.sort((a, b) => (b.last_active || 0) - (a.last_active || 0));
    return rows;
  }

  function rowEl(r, selected) {
    const unread = !selected && isUnread(r);
    const sig = JSON.stringify([r.title, r.first_prompt?.length, r.last_active, r.running, r.status, r.pending_requests, r.last_turn_status,
      r.preview, r.activity, needsYou(r) ? activityText(r) : '', folderLabel(r), r.collab, r.node_online, r.node_name, r.folder?.name, r.cwd, r.source, r.pinned, selected, unread, relTime(r.last_active)]);
    const c = rowCache.get(r.key);
    if (c && c.sig === sig) return c.el;
    const el = sessionRow(r, { selected, unread, onMenu: (anchor) => rowMenu(r, anchor) });
    rowCache.set(r.key, { sig, el });
    return el;
  }

  function sectionH(text, extra) {
    return h('div', { class: 'list-sh' }, h('h2', { text }), extra || null);
  }

  function renderList() {
    if (!state.sessionsLoaded) {
      fill(listEl, skeletonRows(6));
      return;
    }
    const sel = opts.selectedKey();
    const rows = filtered();
    const kids = [];
    const usedKeys = new Set();
    const add = (r) => { usedKeys.add(r.key); return rowEl(r, r.key === sel); };

    const attention = rows.filter(needsYou);
    const pinned = rows.filter((r) => r.pinned && !needsYou(r));
    const rest = rows.filter((r) => !r.pinned && !needsYou(r));
    if (attention.length) kids.push(h('section', { class: 'list-sec' }, sectionH('승인 필요'), attention.map(add)));
    if (pinned.length) kids.push(h('section', { class: 'list-sec' }, sectionH('고정됨'), pinned.map(add)));
    if (group === 'recent') {
      if (rest.length) kids.push(h('section', { class: 'list-sec' }, (attention.length || pinned.length) ? sectionH('최근') : sectionH('최근'), rest.map(add)));
    } else {
      const groups = new Map();
      for (const r of rest) {
        const path = r.folder?.path || null;
        const gk = `${r.node}|${path || ''}`;
        if (!groups.has(gk)) {
          groups.set(gk, {
            key: gk, rows: [],
            title: path ? `${r.folder.name} · ${r.node_name || r.node}` : `폴더 없음 · ${r.node_name || r.node}`,
          });
        }
        groups.get(gk).rows.push(r);
      }
      const gl = [...groups.values()].sort((a, b) => (b.rows[0].last_active || 0) - (a.rows[0].last_active || 0));
      for (const g of gl) {
        const open = expandedFolders.has(g.key) || query;
        const shown = open ? g.rows : g.rows.slice(0, 3);
        const more = !open && g.rows.length > 3
          ? h('button', { type: 'button', class: 'show-all', text: `${g.rows.length}개 모두 보기`, onclick: () => { expandedFolders.add(g.key); renderList(); } })
          : null;
        kids.push(h('section', { class: 'list-sec' }, sectionH(g.title), shown.map(add), more));
      }
    }

    if (!rows.length) {
      kids.length = 0;
      if (query.trim()) {
        // handled together with server results below
      } else if (!state.nodes.length) {
        kids.push(emptyState({ title: '아직 연결된 머신이 없어요', body: '설정 › 머신 추가에서 첫 머신을 연결하세요.', action: () => navigate('#/settings/join'), actionLabel: '머신 추가' }));
      } else if (!state.sessions.size) {
        kids.push(emptyState({ title: '아직 세션이 없어요', body: '새 세션을 시작해 보세요.', action: () => navigate('#/new'), actionLabel: '새 세션', actionVariant: 'primary' }));
      } else {
        kids.push(emptyState({ title: '조건에 맞는 세션이 없어요', action: () => clearFilters(), actionLabel: '필터 지우기', actionVariant: 'text' }));
      }
    }

    // Full-text results.
    const q = query.trim();
    if (searchMode && q) {
      if (searchRes && searchRes.q === q) {
        if (searchRes.loading) kids.push(h('section', { class: 'list-sec' }, sectionH('대화 내용'), skeletonLines(2)));
        else if (searchRes.results?.length) kids.push(h('section', { class: 'list-sec' }, sectionH('대화 내용'), searchRes.results.map(searchRow)));
      }
      const nothing = !rows.length && searchRes && searchRes.q === q && !searchRes.loading && !searchRes.results?.length;
      if (nothing || (!rows.length && q.length < 2)) kids.push(emptyState({ title: `'${q}'${josaWa(q)} 일치하는 세션이 없어요` }));
    }

    for (const k of [...rowCache.keys()]) if (!usedKeys.has(k) && !state.sessions.has(k)) rowCache.delete(k);
    fill(listEl, ...kids);
    renderPill();
  }

  function clearFilters() {
    nodeFilter = '';
    fRunning = false;
    fAttention = false;
    ls.set(NODE_KEY, null);
    saveFlags();
    renderFilters();
    renderList();
  }

  function searchRow(r) {
    const snippet = h('span', { class: 'sr-preview snippet' });
    if (Array.isArray(r.highlights) && r.highlights.length) {
      const c = cleanSnippet(String(r.snippet || ''), r.highlights);
      highlightInto(snippet, c.text, c.ranges);
      return searchRowEl(r, snippet);
    }
    // Older links: the snippet carries FTS markers (<mark>…</mark> or >>>…<<<) instead of ranges.
    const clean = String(r.snippet || '')
      .replace(/⟦omni:[^⟧]*⟧[^\n]*?\(via hermes-omni\)/g, '')
      .replace(/⟦omni:[^⟧]*⟧|\(?via hermes-omni\)?/g, '')
      .replace(/— (Answer in your final reply|No reply is expected|This is the reply)[\s\S]*$/, '')
      .replace(/\*\*|`/g, '');
    const parts = clean.split(/(<mark>|<\/mark>|>>>|<<<)/);
    let on = false;
    for (const part of parts) {
      if (part === '<mark>' || part === '>>>') { on = true; continue; }
      if (part === '</mark>' || part === '<<<') { on = false; continue; }
      const t = part ? cleanSnippet(part).text : '';
      if (t) add(snippet, on ? h('mark', { text: t }) : t);
    }
    if (!snippet.querySelector('mark') && query) highlightInto(snippet, snippet.textContent, termRanges(snippet.textContent, query));
    return searchRowEl(r, snippet);
  }

  function searchRowEl(r, snippet) {
    // A match inside a tool call's arguments (stored JSON): shown as code, and labelled so.
    const tool = /"[\w-]+"\s*:\s*["{[\d]/.test(snippet.textContent);
    snippet.classList.toggle('is-tool', tool);
    const meta = [r.node_name || r.node, r.folder?.name || '폴더 없음', tool ? '도구 호출' : '', relTime(r.last_active)].filter(Boolean).join(' · ');
    return h('div', { class: 'srow-wrap search' }, h('a', { class: 'srow', href: sessionHref(r.node, r.stored_id) },
      h('span', { class: 'sr-dot' }),
      h('span', { class: 'sr-main' },
        h('span', { class: 'sr-l1' }, h('span', { class: 'sr-title', text: r.title || '새 세션' })),
        snippet,
        h('span', { class: 'sr-l3' }, h('span', { class: 'sr-meta', text: meta })))));
  }

  // ---------------------------------------------------------------- attention pill
  function renderPill() {
    const n = attentionRows().length;
    pill.hidden = n === 0 || searchMode;
    pill.textContent = `승인 필요 ${n}`;
    pill.setAttribute('aria-label', `승인이 필요한 세션 ${n}개 — 가장 오래 기다린 세션 열기`);
  }

  function jumpToAttention() {
    const r = attentionRows()[0];
    if (r) navigate(sessionHref(r.node, r.stored_id));
  }

  // ---------------------------------------------------------------- search
  const runSearch = debounce(async (q) => {
    if (q.length < 2 || !searchMode) return;
    searchRes = { q, loading: true, results: [] };
    renderList();
    try {
      const res = await api.search(q);
      if (query.trim() !== q) return;
      searchRes = { q, loading: false, results: res.results || [], partial: res.partial || [] };
    } catch (err) {
      if (query.trim() !== q) return;
      searchRes = { q, loading: false, results: [], error: err };
    }
    renderList();
  }, 400);

  function enterSearch() {
    searchMode = true;
    titleRow.hidden = true;
    searchBar.hidden = false;
    view.classList.add('searching');
    searchInput.value = query;
    renderPill();
    requestAnimationFrame(() => searchInput.focus());
  }

  function exitSearch() {
    searchMode = false;
    query = '';
    searchRes = null;
    runSearch.cancel();
    searchInput.value = '';
    titleRow.hidden = false;
    searchBar.hidden = true;
    view.classList.remove('searching');
    renderList();
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    const q = query.trim();
    if (q.length >= 2) {
      searchRes = { q, loading: true, results: [] };
      runSearch(q);
    } else {
      searchRes = null;
      runSearch.cancel();
    }
    renderList();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); exitSearch(); }
  });

  // ---------------------------------------------------------------- row menu
  function rowMenu(r, anchor) {
    openMenu(anchor, [
      { label: r.pinned ? '고정 해제' : '고정', icon: 'pin', onSelect: () => pin(r) },
      { label: '이름 변경', icon: 'pencil', onSelect: () => rename(r) },
      'divider',
      { label: '삭제', icon: 'trash', danger: true, onSelect: () => del(r) },
    ], { label: `${rowTitle(r)} 메뉴` });
  }

  async function pin(r) {
    const pinned = !r.pinned;
    patchSession(r.key, { pinned });
    try {
      const res = await api.updateSession(r.node, r.stored_id, { pinned });
      if (res.row) patchSession(r.key, res.row);
    } catch (err) {
      patchSession(r.key, { pinned: !pinned });
      toastError(err, '바꾸지 못했어요');
    }
  }

  function rename(r) {
    promptDialog({
      title: '이름 변경', value: r.title || rowTitle(r), ok: '저장',
      submit: async (v) => {
        try {
          const res = await api.updateSession(r.node, r.stored_id, { title: v });
          patchSession(r.key, res.row || { title: v });
          return null;
        } catch (err) {
          return err.code === 'duplicate_title' ? '같은 이름의 세션이 있어요' : errorText(err, '이름을 바꾸지 못했어요');
        }
      },
    });
  }

  async function del(r) {
    const ok = await confirmDialog({ title: '세션을 삭제할까요?', body: '대화 기록이 노드에서 영구히 삭제돼요.', ok: '삭제', danger: true });
    if (!ok) return;
    try {
      await api.deleteSession(r.node, r.stored_id);
      removeSessions([r.key]);
      toast('삭제했어요');
    } catch (err) {
      if (err.code === 'running' || err.status === 409) toast('실행 중인 세션은 삭제할 수 없어요', { tone: 'error' });
      else toastError(err, '삭제하지 못했어요');
    }
  }

  // ---------------------------------------------------------------- refresh / scroll
  async function refresh(showToast = false) {
    try {
      const res = await api.sessions();
      replaceSessions(res.sessions || []);
      socket.resync();
      if (showToast) toast('새로 고쳤어요');
    } catch (err) {
      toastError(err, '새로 고치지 못했어요');
    }
  }

  const detachPtr = attachPullToRefresh(scroller, () => refresh(false));

  let lastY = 0;
  scroller.addEventListener('scroll', () => {
    const y = scroller.scrollTop;
    bar.classList.toggle('scrolled', y > 2);
    if (Math.abs(y - lastY) > 6) {
      fab.classList.toggle('hide', y > lastY && y > 80);
      lastY = y;
    }
  }, { passive: true });

  // Relative times tick.
  const tick = setInterval(() => renderList(), 30000);

  const offs = [
    bus.on('sessions', () => renderList()),
    bus.on('nodes', () => { renderFilters(); renderList(); }),
    bus.on('requests', () => { renderPill(); renderList(); }),
    bus.on('route', () => renderList()),
    bus.on('seen', () => renderList()),
  ];
  const onBp = () => renderList();
  mq.desktop.addEventListener?.('change', onBp);

  renderFilters();
  renderList();

  return {
    /** Back-button hook: clear an active search first (spec §2.2 step 4). */
    handleBack() {
      if (searchMode) { exitSearch(); return true; }
      return false;
    },
    focusSearch: () => enterSearch(),
    destroy() {
      clearInterval(tick);
      runSearch.cancel();
      detachPtr();
      offs.forEach((off) => off());
      mq.desktop.removeEventListener?.('change', onBp);
    },
  };
}

