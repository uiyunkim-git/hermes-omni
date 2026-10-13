// Model sheet (spec §5b.2): per-session model/provider switch, reasoning effort and fast mode.
// Bottom sheet on mobile, a 360px popover above the chip on desktop. All calls go through the
// hub RPC passthrough with the session's stored_id.

import { api } from '../api.js';
import { h, fill, add } from '../util.js';
import { icon } from '../ui/icons.js';
import { createSheet } from '../ui/sheet.js';
import { loadingLine, errorLine, segmented, toggle } from '../ui/controls.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';

/** Provider heading: Hermes names the direct-URL provider "Custom endpoint" (hermes_cli/providers.py). */
function providerTitle(p) {
  if (p.slug === 'custom' || /^custom endpoint\b/i.test(p.name || '')) return '사용자 지정 엔드포인트';
  return p.name || p.slug;
}

export const EFFORTS = [
  { value: 'none', label: '끔' }, { value: 'minimal', label: '최소' }, { value: 'low', label: '낮음' },
  { value: 'medium', label: '중간' }, { value: 'high', label: '높음' }, { value: 'xhigh', label: '매우 높음' },
  { value: 'max', label: '최대' },
];

function priceText(p) {
  if (!p || typeof p !== 'object') return '';
  const i = p.input ?? p.prompt ?? p.input_per_mtok;
  const o = p.output ?? p.completion ?? p.output_per_mtok;
  if (!Number.isFinite(Number(i)) || !Number.isFinite(Number(o))) return '';
  return `입력 $${Number(i)} / 출력 $${Number(o)} (1M)`;
}

/**
 * @param {{node:string, sid:string, meta:object|null, anchor?:Element, running?:boolean,
 *          focus?:'reasoning', onMeta?:(patch:object)=>void}} o
 */
export function openModelSheet(o) {
  const sheet = createSheet({ title: '모델', desktop: 'popover', anchor: o.anchor, width: 360, cls: 'model-sheet' });
  let data = null;
  let current = { model: o.meta?.model || '', provider: o.meta?.provider || '' };
  let busy = false;

  async function load() {
    fill(sheet.body, loadingLine());
    try {
      data = await api.rpc(o.node, 'model.options', {}, o.sid);
      if (data?.model) current = { model: o.meta?.model || data.model, provider: o.meta?.provider || data.provider };
      render();
    } catch {
      fill(sheet.body, errorLine('모델 목록을 불러오지 못했어요', load));
    }
  }

  function capsFor(model) {
    for (const p of data?.providers || []) {
      const c = p.capabilities?.[model];
      if (c && (p.slug === current.provider || p.is_current || (p.models || []).includes(model))) return c;
    }
    return null;
  }

  async function setConfig(key, value, extra = {}) {
    return api.rpc(o.node, 'config.set', { key, value, ...extra }, o.sid);
  }

  async function pickModel(provider, model) {
    if (busy) return;
    busy = true;
    const value = `${model} --provider ${provider.slug} --session`;
    try {
      let res = await setConfig('model', value);
      if (res?.confirm_required) {
        const ok = await confirmDialog({ title: '모델을 바꿀까요?', body: res.confirm_message || res.warning || '', ok: '계속' });
        if (!ok) { busy = false; return; }
        res = await setConfig('model', value, { confirm_expensive_model: true });
      }
      current = { model: res?.value || model, provider: provider.slug };
      o.onMeta?.({ model: current.model, provider: current.provider });
      if (res?.deferred || o.running) toast('다음 턴부터 적용돼요');
      render();
    } catch (err) {
      toastError(err, '모델을 바꾸지 못했어요');
    } finally {
      busy = false;
    }
  }

  function render() {
    const body = sheet.body;
    fill(body);
    const caps = capsFor(current.model) || {};
    // Reasoning first when asked for (/reasoning), else after models.
    const reasoning = caps.reasoning === false ? null : h('section', { class: 'ms-section', id: 'ms-reasoning' },
      h('h3', { class: 'ms-h', text: '추론 강도' }),
      segmented({
        label: '추론 강도', scroll: true, cls: 'fit', options: EFFORTS, value: o.meta?.reasoning_effort || 'medium',
        onChange: async (v) => {
          try {
            await setConfig('reasoning', v);
            o.onMeta?.({ reasoning_effort: v });
            return true;
          } catch (err) {
            toastError(err, '바꾸지 못했어요');
            return false;
          }
        },
      }));
    const fast = caps.fast ? h('section', { class: 'ms-section' },
      h('div', { class: 'ms-toggle-row' },
        h('div', { class: 'lr-text' }, h('span', { class: 'lr-title', text: '빠른 모드' }), h('span', { class: 'lr-sub', text: '더 빠르지만 비쌀 수 있어요' })),
        toggle({
          checked: !!o.meta?.fast, label: '빠른 모드',
          onChange: async (on, input) => {
            try {
              await setConfig('fast', on ? 'on' : 'off');
              o.onMeta?.({ fast: on });
            } catch (err) {
              input.checked = !on;
              toastError(err, '바꾸지 못했어요');
            }
          },
        }))) : null;

    const models = h('section', { class: 'ms-section' });
    // Only providers that can actually serve a model. Meta providers (one placeholder model such
    // as Mixture of Agents' "default", or a provider-level caveat) go under "다른 제공자".
    const providers = (data?.providers || []).filter((p) => p.authenticated !== false && Array.isArray(p.models) && p.models.length);
    const isCurrentProvider = (p) => p.slug === current.provider || (!!p.is_current && !providers.some((x) => x.slug === current.provider));
    const special = (p) => !isCurrentProvider(p) && (!!p.warning || p.models.every((m) => m === 'default'));
    const main = providers.filter((p) => !special(p)).sort((a, b) => Number(isCurrentProvider(b)) - Number(isCurrentProvider(a)));
    const extra = providers.filter(special);
    if (!providers.length) add(models, h('p', { class: 'muted pad', text: '사용할 수 있는 모델이 없어요' }));
    const providerBlock = (p) => {
      const out = [h('h3', { class: 'ms-h', text: providerTitle(p) })];
      if (p.warning) out.push(h('p', { class: 'ms-note', text: p.warning }));
      for (const m of p.models.slice(0, 60)) {
        const isCur = m === current.model && (isCurrentProvider(p) || current.provider === 'auto' || !current.provider);
        const price = priceText(p.pricing?.[m]);
        out.push(h('button', {
          type: 'button', class: `ms-row${isCur ? ' current' : ''}`, 'aria-pressed': isCur ? 'true' : 'false',
          onclick: () => { if (!isCur) pickModel(p, m); },
        },
        h('span', { class: 'lr-text' }, h('span', { class: 'ms-name', text: m === 'default' ? '기본 구성' : m }), price ? h('span', { class: 'lr-sub', text: price }) : null),
        isCur ? icon('check', 18, 'ms-check') : null));
      }
      return out;
    };
    for (const p of main) add(models, ...providerBlock(p));
    if (extra.length) {
      add(models, h('details', { class: 'ms-more' },
        h('summary', {}, icon('chevron-right', 16, 'det-chev'), h('span', { text: `다른 제공자 ${extra.length}개` })),
        h('div', { class: 'ms-more-body' }, extra.map(providerBlock))));
    }
    if (o.focus === 'reasoning' && reasoning) add(body, reasoning, fast, models);
    else add(body, models, reasoning, fast);
    if (o.focus === 'reasoning' && reasoning) requestAnimationFrame(() => reasoning.scrollIntoView({ block: 'start' }));
  }

  load();
  return sheet;
}
