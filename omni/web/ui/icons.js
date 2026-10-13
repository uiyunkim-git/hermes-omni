// Inline stroke icons (spec §4.6): viewBox 0 0 24 24, stroke currentColor 1.75, round caps.
// Every icon is a list of SVG child specs; `icon(name, size)` returns a fresh <svg>.

const NS = 'http://www.w3.org/2000/svg';

const P = (d) => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];
const R = (x, y, w, hh, rx) => ['rect', { x, y, width: w, height: hh, rx }];

const ICONS = {
  'chevron-left': [P('M14.5 5.5 8 12l6.5 6.5')],
  'chevron-right': [P('M9.5 5.5 16 12l-6.5 6.5')],
  'chevron-down': [P('M5.5 9.5 12 16l6.5-6.5')],
  'chevron-up': [P('M5.5 14.5 12 8l6.5 6.5')],
  x: [P('M6 6l12 12M18 6 6 18')],
  plus: [P('M12 5v14M5 12h14')],
  search: [C(11, 11, 6.5), P('m16 16 4 4')],
  settings: [
    C(12, 12, 3),
    P('M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2.6-1.5L14.2 2.6h-4l-.4 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3 1 2-3.4z'),
  ],
  more: [['circle', { cx: 5.5, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 18.5, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }]],
  info: [C(12, 12, 9), P('M12 11v5.5'), ['circle', { cx: 12, cy: 7.8, r: 1.1, fill: 'currentColor', stroke: 'none' }]],
  refresh: [P('M19.5 12a7.5 7.5 0 1 1-2.2-5.3'), P('M19.5 4.5v4h-4')],
  sort: [P('M7 5v14M7 19l-3-3M7 19l3-3'), P('M13 7h7M13 12h5M13 17h3')],
  folder: [P('M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z')],
  file: [P('M6.5 3.5h7l4 4v13h-11z'), P('M13.5 3.5v4h4')],
  server: [R(4, 4.5, 16, 6.5, 1.5), R(4, 13, 16, 6.5, 1.5), P('M7.5 7.75h.01M7.5 16.25h.01')],
  link: [P('M10 13.5a4 4 0 0 0 5.7.3l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.3 1.3'), P('M14 10.5a4 4 0 0 0-5.7-.3l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3')],
  paperclip: [P('M19 11.5 12.2 18.3a4.5 4.5 0 0 1-6.4-6.4l7.1-7.1a3 3 0 0 1 4.2 4.2l-7 7.1a1.5 1.5 0 0 1-2.2-2.2l6.4-6.4')],
  slash: [R(3.5, 3.5, 17, 17, 4), P('M14.5 7.5 9.5 16.5')],
  'arrow-up': [P('M12 19V5M5.5 11.5 12 5l6.5 6.5')],
  'arrow-down': [P('M12 5v14M5.5 12.5 12 19l6.5-6.5')],
  stop: [['rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2, fill: 'currentColor', stroke: 'none' }]],
  check: [P('M5 12.5 10 17.5 19 7')],
  alert: [P('M10.3 4.2 2.9 17.2A2 2 0 0 0 4.6 20.2h14.8a2 2 0 0 0 1.7-3l-7.4-13a2 2 0 0 0-3.4 0z'), P('M12 9.5v4'),
    ['circle', { cx: 12, cy: 16.8, r: 1, fill: 'currentColor', stroke: 'none' }]],
  clock: [C(12, 12, 8.5), P('M12 7.5V12l3 2')],
  copy: [R(8.5, 8.5, 11, 11, 2), P('M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5')],
  download: [P('M12 4v11M7 10.5l5 5 5-5'), P('M5 19.5h14')],
  upload: [P('M12 15.5v-11M7 9l5-5 5 5'), P('M5 19.5h14')],
  trash: [P('M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5'), P('M10.25 11v5M13.75 11v5')],
  pencil: [P('M15.5 5.5l3 3L8.5 18.5 4.5 19.5l1-4z'), P('M13.5 7.5l3 3')],
  eye: [P('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'), C(12, 12, 3)],
  'eye-off': [P('M3.5 3.5l17 17'), P('M10 6a9 9 0 0 1 2-.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.6 6.7C4 8.4 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1'), P('M9.9 9.9a3 3 0 0 0 4.2 4.2')],
  external: [P('M13.5 4.5h6v6M19.5 4.5l-8 8'), P('M18 13.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5A1.5 1.5 0 0 1 6 6h4.5')],
  terminal: [R(3.5, 4.5, 17, 15, 2), P('M7.5 9.5l3 2.5-3 2.5M12.5 15h4')],
  logout: [P('M14.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-3.5'), P('M10 16.5 14.5 12 10 7.5M14.5 12H4.5')],
  calendar: [R(4, 5.5, 16, 14, 2), P('M4 10h16M8.5 3.5v4M15.5 3.5v4')],
  book: [P('M5 4.5h10.5a2 2 0 0 1 2 2V19.5H7a2 2 0 0 1-2-2z'), P('M5 17.5a2 2 0 0 1 2-2h10.5')],
  brain: [P('M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.3A3 3 0 0 0 7 17.5a2.5 2.5 0 0 0 5 .5V6a1.5 1.5 0 0 0-3-1.5z'), P('M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.3 3 3 0 0 1-2.5 4.7 2.5 2.5 0 0 1-5 .5')],
  phone: [R(7, 3, 10, 18, 2), P('M11 17.5h2')],
  plug: [P('M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4')],
  sun: [C(12, 12, 4), P('M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4')],
  pin: [P('M9.5 4.5h5l-.8 5.2 3.3 3.3v1.5H7v-1.5l3.3-3.3z'), P('M12 14.5v5')],
  image: [R(3.5, 4.5, 17, 15, 2), C(9, 10, 1.75), P('M20.5 16l-5-5-9 8.5')],
};

/**
 * @param {string} name   icon id from ICONS
 * @param {number} [size] px (20 for UI, 16 inline)
 * @param {string} [cls]  extra class
 */
export function icon(name, size = 20, cls = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon icon-${name}${cls ? ` ${cls}` : ''}`);
  for (const [tag, attrs] of ICONS[name] || ICONS.info) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

export const hasIcon = (name) => Object.prototype.hasOwnProperty.call(ICONS, name);
