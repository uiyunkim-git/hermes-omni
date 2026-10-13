// Slash palette data (spec §5b.3): native commands (always listed, Korean), Hermes catalog
// commands, skills and a collapsed "더보기" section. Terminal/messaging-only commands are hidden;
// commands that map to native UI are blocked from slash.exec.

export const NATIVE = [
  { cmd: '/model', desc: '모델 바꾸기' },
  { cmd: '/reasoning', desc: '추론 강도' },
  { cmd: '/fast', desc: '빠른 모드 전환' },
  { cmd: '/compress', desc: '컨텍스트 압축' },
  { cmd: '/title', desc: '이름 변경' },
  { cmd: '/stop', desc: '중단' },
  { cmd: '/new', desc: '새 세션' },
  { cmd: '/yolo', desc: '자동 승인 전환' },
  { cmd: '/status', desc: '세션 상태' },
  { cmd: '/usage', desc: '사용량' },
  { cmd: '/export', desc: '내보내기' },
  { cmd: '/files', desc: '파일' },
];

const NATIVE_SET = new Set(NATIVE.map((n) => n.cmd));

export const BLOCKED = new Set(['/quit', '/exit', '/clear', '/config', '/statusbar', '/approve', '/deny', '/login',
  '/logout', '/model', '/skills', '/new', '/resume', '/yolo']);

function cleanDesc(d) {
  return String(d || '').replace(/\s*\(usage:[^)]*\)\s*$/i, '').trim();
}

/** Normalize a commands.catalog result into {commands:[], skills:[], more:[]}. */
export function normalizeCatalog(cat) {
  const desc = new Map();
  for (const p of cat?.pairs || []) if (Array.isArray(p)) desc.set(p[0], cleanDesc(p[1]));
  const canon = cat?.canon || {};
  const commands = [];
  const more = [];
  for (const [cmd, meta] of Object.entries(cat?.commands || {})) {
    if (NATIVE_SET.has(cmd) || BLOCKED.has(cmd)) continue;
    if (canon[cmd] && canon[cmd] !== cmd) continue;          // alias
    const d = meta?.desktop ?? null;
    if (d === 'terminal' || d === 'messaging' || d === 'hidden' || d === 'settings') continue;
    const item = { cmd, desc: desc.get(cmd) || '', argMode: meta?.argument_mode || null, kind: 'command' };
    if (d === 'advanced') more.push(item);
    else if (d === null) commands.push(item);
  }
  const skills = Object.keys(cat?.skills || {}).sort().map((cmd) => ({
    cmd, desc: desc.get(cmd) || '스킬', argMode: 'text', kind: 'skill',
  }));
  commands.sort((a, b) => a.cmd.localeCompare(b.cmd));
  more.sort((a, b) => a.cmd.localeCompare(b.cmd));
  return { commands, skills, more };
}

function matches(item, q) {
  if (!q) return true;
  const name = item.cmd.slice(1).toLowerCase();
  return name.startsWith(q) || item.desc.toLowerCase().includes(q);
}

/**
 * Popover entries for the query typed after "/".
 * @returns {Array} entries for createListPopover.show
 */
export function paletteEntries(norm, query, { showMore = false, features = true } = {}) {
  const q = query.toLowerCase();
  const out = [];
  const natives = NATIVE.filter((n) => matches(n, q)).filter((n) => features || ['/title', '/stop', '/new', '/export'].includes(n.cmd));
  const row = (it) => ({ item: { ...it, kind: it.kind || 'native' }, title: it.cmd, sub: it.desc, mono: true });
  if (natives.length) out.push({ section: '세션' }, ...natives.map(row));
  if (!norm) return out;
  const cmds = norm.commands.filter((c) => matches(c, q));
  if (cmds.length) out.push({ section: '명령' }, ...cmds.map(row));
  const skills = norm.skills.filter((c) => matches(c, q));
  if (skills.length) out.push({ section: '스킬' }, ...skills.slice(0, q ? 50 : 30).map(row));
  const more = norm.more.filter((c) => matches(c, q));
  if (more.length) {
    if (showMore || q) out.push({ section: '더보기' }, ...more.map(row));
    else out.push({ item: { kind: 'more' }, title: `더보기 ${more.length}개`, sub: '고급 명령' });
  }
  return out;
}
