// menu.js — simple modal list menu used by shops and safehouses (keyboard, mouse and gamepad friendly)
import { S, canvas } from './core.js';

/* =====================================================================
   MENU
   ===================================================================== */
const el = document.getElementById('menu');
const M = { title: '', sub: '', items: [], sel: 0, onSelect: null };
export const menuOpen = () => S.menu;
export function openMenu(title, sub, items, onSelect, cls = '') {
  Object.assign(M, { title, sub, items, sel: Math.max(0, items.findIndex(i => !i.disabled)), onSelect });
  S.menu = true; el.className = cls; el.style.display = 'block'; document.exitPointerLock?.(); render();
}
export function refreshMenu(items, sub) { M.items = items; if (sub !== undefined) M.sub = sub; M.sel = Math.min(M.sel, items.length - 1); render(); }
export function closeMenu() {
  if (!S.menu) return; S.menu = false; el.style.display = 'none';
  try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch (e) {}
}
function render() {
  el.innerHTML = `<h2>${M.title}</h2><p>${M.sub}</p><ul>${M.items.map((it, i) =>
    `<li data-i="${i}" class="${i === M.sel ? 'sel' : ''} ${it.disabled ? 'dis' : ''}"><span>${it.label}</span><b>${it.right ?? ''}</b></li>`).join('')}</ul>
    <div class="hint">↑ ↓ select &nbsp;·&nbsp; Enter choose &nbsp;·&nbsp; Esc close</div>`;
  el.querySelectorAll('li').forEach(li => {
    li.onmouseenter = () => { M.sel = +li.dataset.i; el.querySelectorAll('li').forEach((x, i) => x.classList.toggle('sel', i === M.sel)); };
    li.onclick = () => choose(+li.dataset.i);
  });
}
function choose(i) { const it = M.items[i]; if (!it || it.disabled) return; M.onSelect?.(it, i); }
export function menuKey(code) {
  if (!S.menu) return false;
  const n = M.items.length; if (!n) { if (code === 'Escape' || code === 'KeyE') closeMenu(); return true; }
  if (code === 'ArrowUp' || code === 'KeyW') M.sel = (M.sel - 1 + n) % n;
  else if (code === 'ArrowDown' || code === 'KeyS') M.sel = (M.sel + 1) % n;
  else if (code === 'Enter' || code === 'Space') { choose(M.sel); return true; }
  else if (code === 'Escape' || code === 'Backspace' || code === 'KeyE') { closeMenu(); return true; }
  render(); return true;
}
