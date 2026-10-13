// Tool-call chips: one collapsible chip per tool call with a status (generating / running /
// done / error), used both for the live turn and for persisted history rows.

import { h, truncate } from '../util.js';

const STATE_LABEL = {
  generating: 'preparing',
  running: 'running',
  done: 'done',
  error: 'error',
};

function prettyJson(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return v; }
    }
    return v;
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * @param {{name?:string,state?:string,args?:any,preview?:any,duration_s?:number,error?:any}} t
 */
export function toolChip(t) {
  const state = STATE_LABEL[t.state] ? t.state : 'done';
  const busy = state === 'generating' || state === 'running';
  const dur = Number.isFinite(t.duration_s) ? `${t.duration_s < 10 ? t.duration_s.toFixed(1) : Math.round(t.duration_s)}s` : '';
  const args = prettyJson(t.args);
  const preview = prettyJson(t.preview);
  const err = t.error ? prettyJson(t.error) : '';
  const hasBody = !!(args || preview || err);
  const summary = h('summary', { class: 'chip-head' },
    h('span', { class: `chip-icon ${busy ? 'spin' : ''}`, 'aria-hidden': 'true' }, busy ? '' : state === 'error' ? '✕' : '✓'),
    h('span', { class: 'chip-name', text: t.name || 'tool' }),
    h('span', { class: 'chip-state', text: dur && !busy ? `${STATE_LABEL[state]} · ${dur}` : STATE_LABEL[state] }));
  const el = h(hasBody ? 'details' : 'div', { class: `chip chip-${state}`, dataset: { toolId: t.tool_id || '' } }, summary);
  if (hasBody) {
    if (args) el.append(h('div', { class: 'chip-sec' }, h('div', { class: 'chip-label', text: 'Arguments' }), h('pre', { class: 'code', text: truncate(args, 4000) })));
    if (err) el.append(h('div', { class: 'chip-sec' }, h('div', { class: 'chip-label', text: 'Error' }), h('pre', { class: 'code err', text: truncate(err, 4000) })));
    if (preview) el.append(h('div', { class: 'chip-sec' }, h('div', { class: 'chip-label', text: 'Result' }), h('pre', { class: 'code', text: truncate(preview, 6000) })));
  } else {
    summary.setAttribute('role', 'group');
  }
  return el;
}

function looksLikeError(content) {
  if (typeof content !== 'string') return false;
  const s = content.trim();
  if (!s.startsWith('{')) return /^(error|traceback)\b/i.test(s);
  try {
    const o = JSON.parse(s);
    return !!(o && (o.error || (Number.isInteger(o.exit_code) && o.exit_code !== 0) || o.success === false));
  } catch {
    return false;
  }
}

// Hermes Tool Search wraps deferred tools (plugin/MCP tools such as hub_send) in a meta call
// `tool_call {"calls":[{"name":...,"arguments":...}]}`; show the real tool names instead.
function innerCalls(c) {
  const name = c?.function?.name || c?.name;
  if (name !== 'tool_call') return null;
  let a = c?.function?.arguments ?? c?.arguments ?? c?.args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return null; } }
  const calls = Array.isArray(a?.calls) ? a.calls : null;
  return calls && calls.length ? calls : null;
}

function callName(c) {
  const inner = innerCalls(c);
  if (inner) return inner.map((x) => x?.name || 'tool').join(' + ');
  return c?.function?.name || c?.name || 'tool';
}

function callArgs(c) {
  return c?.function?.arguments ?? c?.arguments ?? c?.args ?? '';
}

/**
 * Collapse a run of history rows (assistant rows with tool_calls + role:"tool" rows) into one
 * <details> block of done/error chips. Result rows are paired to calls in order (by name if possible).
 */
export function toolGroup(rows) {
  const chips = [];
  const pending = [];
  for (const r of rows) {
    if (r.role === 'assistant' && Array.isArray(r.tool_calls)) {
      for (const c of r.tool_calls) {
        const chip = { name: callName(c), args: callArgs(c), state: 'done' };
        chips.push(chip);
        pending.push(chip);
      }
    } else if (r.role === 'tool') {
      let idx = pending.findIndex((c) => c.name === r.tool_name);
      if (idx < 0) idx = pending.length ? 0 : -1;
      const chip = idx >= 0 ? pending.splice(idx, 1)[0] : (chips[chips.push({ name: r.tool_name || 'tool', state: 'done' }) - 1]);
      chip.preview = r.content;
      if (looksLikeError(r.content)) chip.state = 'error';
    }
  }
  const errors = chips.filter((c) => c.state === 'error').length;
  const names = [...new Set(chips.map((c) => c.name))];
  const label = `${chips.length} tool call${chips.length === 1 ? '' : 's'}`;
  return h('details', { class: 'tool-group' },
    h('summary', {},
      h('span', { class: 'tg-icon', 'aria-hidden': 'true' }, '⚙'),
      h('span', { class: 'tg-label', text: label }),
      h('span', { class: 'tg-names muted', text: truncate(names.join(', '), 60) }),
      errors ? h('span', { class: 'status-chip st-error', text: `${errors} failed` }) : null),
    h('div', { class: 'chips' }, chips.map(toolChip)));
}
