// menus.js — title screen, pause menu, settings, controls, full-screen map with waypoints, phone
import { S, Q, cam, renderer, sun, emit, on, clamp, fmtMoney, SAVE_KEY, canvas } from './core.js';
import { sens } from './input.js';
import * as sfx from './audio.js';
import { player } from './player.js';
import { getMapCanvas, MAPW, MPP } from './ui.js';
import { blips, objectivePoint, MS, cancelMission, GIVERS, available, ACTIVITIES, MISSIONS, beaconAt, reels } from './missions.js';
import { shopBlips, SHOPS } from './shops.js';
import { hospitals, stations, wanted } from './police.js';
import { openMenu, closeMenu } from './menu.js';
import { TYPES } from './vehicles.js';
import { spawnOnRoad } from './traffic.js';
import { ramps } from './world.js';

/* =====================================================================
   MENUS: settings (stored separately from the save game)
   ===================================================================== */
const SET_KEY = 'harborcity.settings.v1';
export const settings = { quality: 'high', sens: 1, invertY: false, volume: 0.8, music: 0.55, dynRes: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch (e) {}
const QUALITY = {
  low:    { pr: 1,    shadows: false, size: 1024, near: 220, mid: 420, far: 620, lamps: false, traffic: 16, peds: 30 },
  medium: { pr: 1.25, shadows: true,  size: 1024, near: 300, mid: 550, far: 800, lamps: true,  traffic: 22, peds: 44 },
  high:   { pr: 1.5,  shadows: true,  size: 2048, near: 340, mid: 650, far: 950, lamps: true,  traffic: 28, peds: 54 },
};
// dynamic resolution: if frames are slow, render fewer pixels; recover when there's headroom
const dyn = { pr: 1.5, max: 1.5, ms: 16, t: 0 };
export function dynamicResolution(realDt) {
  if (!settings.dynRes || realDt <= 0) return;
  dyn.ms += (realDt * 1000 - dyn.ms) * 0.05; dyn.t += realDt;
  if (dyn.t < 2) return;
  let next = dyn.pr;
  if (dyn.ms > 19 && dyn.pr > 0.6) next = Math.max(0.6, dyn.pr - 0.15);
  else if (dyn.ms < 12 && dyn.pr < dyn.max) next = Math.min(dyn.max, dyn.pr + 0.1);
  if (next !== dyn.pr) { dyn.pr = next; renderer.setPixelRatio(next); renderer.setSize(innerWidth, innerHeight); dyn.t = 0; }
}
export const currentResolution = () => dyn.pr;
export function applySettings() {
  const q = QUALITY[settings.quality] || QUALITY.high;
  dyn.max = Math.min(devicePixelRatio, q.pr); dyn.pr = dyn.max;
  renderer.setPixelRatio(dyn.pr); renderer.setSize(innerWidth, innerHeight);
  Q.shadows = q.shadows;
  if (sun.shadow.mapSize.x !== q.size) { sun.shadow.mapSize.set(q.size, q.size); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  window.__q = settings.quality;
  Object.assign(Q, { shadowSize: q.size, nearDist: q.near, midDist: q.mid, farDist: q.far, lampsOn: q.lamps, traffic: q.traffic, peds: q.peds });
  sens.mouse = 0.0022 * settings.sens; sens.invertY = settings.invertY;
  sfx.setMasterVolume(settings.volume); sfx.setMusicVolume(settings.music);
  try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {}
}

/* =====================================================================
   MENUS: overlay views (title / pause / settings / controls / map)
   ===================================================================== */
const $ = id => document.getElementById(id);
const overlay = $('overlay'), panel = $('ovPanel'), btns = $('ovButtons'), msg = $('ovmsg'), page = $('ovPage'), mapView = $('mapView');
let mode = 'title', handlers = {};
export const overlayOpen = () => overlay.style.display !== 'none';
function view(v) {
  panel.style.display = v === 'buttons' ? '' : 'none'; page.style.display = v === 'page' ? 'block' : 'none'; mapView.style.display = v === 'map' ? 'block' : 'none';
  if (v === 'map') drawMap();
}
function buttons(list) {
  btns.innerHTML = ''; list.forEach(([label, fn, alt]) => { const b = document.createElement('button'); b.textContent = label; if (alt) b.className = 'alt'; b.onclick = fn; btns.appendChild(b); });
}
export function setHandlers(h) { handlers = h; }
export function showTitle(hasSave) {
  mode = 'title'; overlay.style.display = 'flex'; view('buttons'); $('ovSub').textContent = 'An open-world sandbox';
  msg.textContent = hasSave ? 'Save found — pick up where you left off.' : 'A new life in Harbor City.';
  let confirmNew = false;
  const list = [];
  if (hasSave) list.push(['Continue', () => handlers.start()]);
  list.push([hasSave ? 'New game' : 'Play', function () {
    if (!hasSave) return handlers.start();
    if (!confirmNew) { confirmNew = true; this.textContent = 'Click again — this erases your save'; return; }
    localStorage.removeItem(SAVE_KEY); sessionStorage.setItem('harborcity.autostart', '1'); location.reload();
  }, hasSave]);
  list.push(['Settings', () => settingsPage('title'), true], ['Controls', () => controlsPage('title'), true]);
  buttons(list);
}
export function showPause() {
  mode = 'pause'; overlay.style.display = 'flex'; view('buttons'); $('ovSub').textContent = 'Paused';
  const P = S.progress, done = MISSIONS.filter(m => P.done[m.id]).length;
  msg.textContent = `${fmtMoney(S.money)}  ·  Story ${done}/${MISSIONS.length}  ·  Film reels ${Object.keys(P.reels).length}/${reels.length}  ·  Stunt jumps ${Object.keys(P.jumps).length}/${ramps.length}`;
  buttons([['Resume', () => handlers.resume()], ['Map', () => { view('map'); }, true], ['Settings', () => settingsPage('pause'), true], ['Controls', () => controlsPage('pause'), true],
    ['Save & quit to title', () => { handlers.save?.(); location.reload(); }, true]]);
}
export function hideOverlay() { overlay.style.display = 'none'; }
export function setLoading(text) { overlay.style.display = 'flex'; view('buttons'); msg.textContent = text; btns.innerHTML = ''; }
function back() { if (mode === 'title') showTitle(!!localStorage.getItem(SAVE_KEY)); else showPause(); }
addEventListener('keydown', e => { if (e.code === 'Escape' && overlayOpen() && (page.style.display === 'block' || mapView.style.display === 'block')) { e.preventDefault(); back(); } });

function settingsPage(from) {
  view('page');
  const opt = (k, vals) => `<select data-k="${k}">${vals.map(([v, l]) => `<option value="${v}" ${String(settings[k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const rng = (k, min, max, step) => `<input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${settings[k]}">`;
  page.innerHTML = `<div class="box"><h2>Settings</h2>
    <div class="row">Graphics quality ${opt('quality', [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High']])}</div>
    <div class="row">Dynamic resolution (keeps the frame rate up) ${opt('dynRes', [[true, 'On'], [false, 'Off']])}</div>
    <div class="row">Mouse sensitivity ${rng('sens', 0.3, 2.5, 0.05)}</div>
    <div class="row">Invert look Y ${opt('invertY', [[false, 'Off'], [true, 'On']])}</div>
    <div class="row">Master volume ${rng('volume', 0, 1, 0.05)}</div>
    <div class="row">Radio volume ${rng('music', 0, 1, 0.05)}</div>
    <p style="opacity:.6;font-size:13px">Low: no shadows, shorter draw distance, fewer cars and people. Settings are saved automatically.</p>
    <div class="back"><button>Back</button></div></div>`;
  page.querySelectorAll('[data-k]').forEach(el => el.oninput = el.onchange = () => {
    const k = el.dataset.k; settings[k] = k === 'quality' ? el.value : (k === 'invertY' || k === 'dynRes') ? el.value === 'true' : +el.value; applySettings();
  });
  page.querySelector('.back button').onclick = back;
}
function controlsPage() {
  view('page');
  const rows = [['WASD / left stick', 'Move · drive'], ['Mouse / right stick', 'Look'], ['Shift / B', 'Sprint'], ['Space / A', 'Jump · climb · vault · handbrake'],
    ['F / Y', 'Enter · exit · steal vehicle'], ['E / Back', 'Interact: missions, shops, safehouses · talk'], ['Right mouse / LT', 'Aim'], ['Left mouse / RT', 'Shoot · punch · accelerate'],
    ['1–4 / D-pad ↑↓', 'Weapons'], ['R / X', 'Reload (on foot) · next radio station (in car)'], ['Q / D-pad ←', 'Previous radio station'], ['E (in car) / L3', 'Horn'],
    ['Tab / R3', 'Phone: GPS, mechanic, cancel mission'], ['M', 'Full-screen map'], ['Esc / Start', 'Pause menu'], ['T · Y · F3', 'Debug: +1 hour · weather · stats']];
  page.innerHTML = `<div class="box"><h2>Controls</h2><div class="keys">${rows.map(([k, d]) => `<b>${k}</b><span>${d}</span>`).join('')}</div><div class="back"><button>Back</button></div></div>`;
  page.querySelector('.back button').onclick = back;
}
export function openMap() { if (!S.started) return; handlers.pauseForMap?.(); view('map'); }

/* =====================================================================
   MENUS: full-screen map + waypoint
   ===================================================================== */
const big = $('bigmap'), bg = big.getContext('2d');
const mv = { x: 0, z: 0, zoom: 0.5, drag: null, moved: false };   // zoom = screen px per metre
let wpBeacon = null;
export function setWaypoint(x, z) {
  S.waypoint = x === undefined ? null : { x, z };
  wpBeacon ||= beaconAt('waypoint', 0, 0);
  if (S.waypoint) { wpBeacon.position.set(x, 0, z); emit('toast', 'Waypoint set', 1.5); }
}
export function updateWaypoint() {
  wpBeacon ||= beaconAt('waypoint', 0, 0);
  wpBeacon.visible = !!S.waypoint;
  if (S.waypoint && Math.hypot(player.pos.x - S.waypoint.x, player.pos.z - S.waypoint.z) < 14) { S.waypoint = null; emit('toast', 'You have arrived', 1.5); }
}
function drawMap() {
  const W = big.width = big.clientWidth * devicePixelRatio, H = big.height = big.clientHeight * devicePixelRatio, k = devicePixelRatio;
  if (!mv.drag && !mv.moved) { mv.x = player.pos.x; mv.z = player.pos.z; }
  const z = mv.zoom * k, sx = x => W / 2 + (x - mv.x) * z, sy = y => H / 2 + (y - mv.z) * z;
  bg.fillStyle = '#20384a'; bg.fillRect(0, 0, W, H);
  bg.imageSmoothingEnabled = true; bg.drawImage(getMapCanvas(), sx(-MAPW / 2), sy(-MAPW / 2), MAPW * z, MAPW * z);
  const dot = (x, y, col, label, r = 7) => { bg.fillStyle = col; bg.strokeStyle = '#000'; bg.lineWidth = 1.5 * k; bg.beginPath(); bg.arc(sx(x), sy(y), r * k, 0, Math.PI * 2); bg.fill(); bg.stroke();
    if (label) { bg.fillStyle = '#111'; bg.font = `bold ${9 * k}px system-ui`; bg.textAlign = 'center'; bg.textBaseline = 'middle'; bg.fillText(label, sx(x), sy(y) + 0.5 * k); } };
  if (wanted.level > 0 && !wanted.seen) { bg.fillStyle = 'rgba(70,120,255,.2)'; bg.beginPath(); bg.arc(sx(wanted.lastSeen.x), sy(wanted.lastSeen.z), (60 + wanted.level * 25) * z, 0, Math.PI * 2); bg.fill(); }
  for (const h of hospitals) dot(h.x, h.z, '#1d6fd1', 'H'); for (const s of stations) dot(s.x, s.z, '#3b4f80', 'P');
  for (const b of [...blips(), ...shopBlips()]) dot(b.x, b.z, b.color, b.label);
  const op = objectivePoint(); if (op) dot(op.x, op.z, '#ffd34d', '!', 9);
  if (S.waypoint) dot(S.waypoint.x, S.waypoint.z, '#ff4fd8', '◆', 8);
  // player arrow
  bg.save(); bg.translate(sx(player.pos.x), sy(player.pos.z)); bg.rotate(Math.PI - player.facing); bg.fillStyle = '#fff'; bg.strokeStyle = '#000'; bg.lineWidth = 1.5 * k;
  bg.beginPath(); bg.moveTo(0, -10 * k); bg.lineTo(7 * k, 8 * k); bg.lineTo(0, 4 * k); bg.lineTo(-7 * k, 8 * k); bg.closePath(); bg.fill(); bg.stroke(); bg.restore();
  $('mapLegend').innerHTML = [['#ffd34d', 'Story mission'], ['#c77dff', 'Race / taxi'], ['#5fd35b', 'Shop'], ['#4aa8ff', 'Safehouse'], ['#1d6fd1', 'Hospital'], ['#3b4f80', 'Police'], ['#ff4fd8', 'Waypoint']]
    .map(([c, l]) => `<div><i style="background:${c}"></i>${l}</div>`).join('');
}
big.addEventListener('mousedown', e => { mv.drag = { x: e.clientX, y: e.clientY, mx: mv.x, mz: mv.z }; mv.dragged = false; });
addEventListener('mousemove', e => { if (!mv.drag) return; const dx = e.clientX - mv.drag.x, dy = e.clientY - mv.drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) { mv.dragged = mv.moved = true; } mv.x = mv.drag.mx - dx / mv.zoom; mv.z = mv.drag.mz - dy / mv.zoom; if (mapView.style.display === 'block') drawMap(); });
addEventListener('mouseup', e => {
  if (!mv.drag) return; const d = mv.drag; mv.drag = null;
  if (!mv.dragged && e.button === 0 && e.target === big) { const r = big.getBoundingClientRect(); setWaypoint(mv.x + (e.clientX - r.left - r.width / 2) / mv.zoom, mv.z + (e.clientY - r.top - r.height / 2) / mv.zoom); drawMap(); }
});
big.addEventListener('contextmenu', e => { e.preventDefault(); setWaypoint(); drawMap(); });
big.addEventListener('wheel', e => { e.preventDefault(); mv.zoom = clamp(mv.zoom * (e.deltaY > 0 ? 0.85 : 1.18), 0.15, 3); mv.moved = true; drawMap(); }, { passive: false });
on('mapClosed', () => { mv.moved = false; });

/* =====================================================================
   MENUS: phone (GPS shortcuts, mechanic, cancel mission)
   ===================================================================== */
export function openPhone() {
  if (!S.started || S.paused || S.menu || player.dead) return;
  const P = S.progress, items = [];
  const gps = (label, p) => items.push({ label: 'GPS · ' + label, go: () => { setWaypoint(p.x, p.z); closeMenu(); } });
  if (MS.active) items.push({ label: `Cancel: ${MS.active.title}`, right: '✕', go: () => { closeMenu(); cancelMission(); } });
  const next = available()[0]; if (next && !MS.active) gps(`Next job: ${next.title}`, GIVERS[next.giver]);
  const nearest = list => list.reduce((a, c) => Math.hypot(c.x - player.pos.x, c.z - player.pos.z) < Math.hypot(a.x - player.pos.x, a.z - player.pos.z) ? c : a);
  gps('Nearest street race', nearest(ACTIVITIES.filter(a => a.race).map(a => a.at)));
  gps('Taxi depot', ACTIVITIES.find(a => a.id === 'taxi').at);
  if (P.done.m1) gps('Calloway Garage', GIVERS.garage);
  for (const s of SHOPS) if (s.id !== 'garage') gps(s.name, s.at);
  gps('Nearest hospital', nearest(hospitals));
  if (!player.vehicle) for (const t of P.cars) if (t !== 'boat') items.push({ label: `Mechanic: deliver my ${TYPES[t].name}`, right: '$100', go: () => {
    if (S.money < 100) { emit('toast', "You can't afford the delivery."); return; }
    S.money -= 100; closeMenu();
    const d = spawnOnRoad(t, player.pos.x + 12, player.pos.z + 12); d.v.ai = null; d.v.driver = null; d.v.parked = true; d.v.vel.set(0, 0, 0);
    player.lastVehicle = d.v; emit('toast', `Your ${TYPES[t].name} is parked nearby (blue dot).`, 3);
  } });
  if (S.waypoint) items.push({ label: 'Clear GPS', go: () => { setWaypoint(); closeMenu(); } });
  openMenu('Phone', `${fmtMoney(S.money)}  ·  ${wanted.level ? '★'.repeat(wanted.level) + ' wanted' : 'all quiet'}`, items, it => it.go(), 'phone');
}
