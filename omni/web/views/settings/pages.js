// Settings › 스킬 and 메모리 pages: the shared panels inside a settings page frame.

import { navigate } from '../../router.js';
import { skillsPanel } from './skills.js';
import { memoryPanel } from './memory.js';
import { page } from './common.js';
import { fill, add } from '../../util.js';

export function mountSkillsPage(root, { node }) {
  const p = page({ title: '스킬' });
  fill(root, p.el);
  const panel = skillsPanel({
    node,
    onNode: (n) => navigate(`#/settings/skills?node=${encodeURIComponent(n)}`, { replace: true }),
  });
  add(p.body, panel.el);
  return { destroy: panel.destroy, sameRoute: true };
}

export function mountMemoryPage(root, { node }) {
  const p = page({ title: '메모리' });
  fill(root, p.el);
  const panel = memoryPanel({ node });
  add(p.body, panel.el);
  return { destroy: panel.destroy };
}
