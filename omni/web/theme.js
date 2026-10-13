// Theme (spec §4.1): html[data-theme] wins over prefers-color-scheme. Keeps <meta theme-color>
// and the Android system bars (HermesOmni.setBars) in sync with --bg.

import { bridge, ls } from './util.js';

const darkMq = window.matchMedia('(prefers-color-scheme: dark)');

function isLightColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 140;
}

export function applyTheme() {
  const t = ls.get('omni.theme', null);
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim() || '#FAF9F6';
  const light = isLightColor(bg);
  root.style.colorScheme = light ? 'light' : 'dark';
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = bg;
  bridge('setBars', bg.toUpperCase(), light);
}

darkMq.addEventListener?.('change', applyTheme);
