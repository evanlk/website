// ui.js — HUD: money/clock, minimap, zone label, speedometer, prompts, toasts, title/pause overlay, debug
import { CFG, S, cam, clamp, fmtMoney, renderer, colliderCount, footprints, on } from './core.js';
import { sampleH, terrainColor, blocks, zoneName, chunkCount } from './world.js';
import { env } from './env.js';
import { player, nearestEnterable } from './player.js';
import { vehicles } from './vehicles.js';
import { STATIONS } from './audio.js';
import { peds } from './peds.js';
import { wanted, units, hospitals, stations } from './police.js';
import { WEAPONS, combat } from './combat.js';
import { MS, blips, objectivePoint, interactable } from './missions.js';
import { shopInteractable, shopBlips } from './shops.js';

/* =====================================================================
   UI: elements, toasts, overlay
   ===================================================================== */
const $ = id => document.getElementById(id);
const moneyEl = $('money'), clockEl = $('clock'), zoneEl = $('zone'), debugEl = $('debug'), toastEl = $('toast');
const promptEl = $('prompt'), speedoEl = $('speedo');
const hudEl = $('hud'), objEl = $('objective'), timerEl = $('mtimer'), dlgEl = $('dialog'), lbEl = $('letterbox');
const starsEl = $('stars'), weaponEl = $('weapon'), hpBar = $('hpBar'), arBar = $('arBar'), hurtEl = $('hurt'), bigEl = $('bigtext'), crossEl = $('crosshair');
on('playerHurt', amt => { hurtEl.style.transition = 'none'; hurtEl.style.opacity = Math.min(1, 0.35 + amt / 40); requestAnimationFrame(() => { hurtEl.style.transition = 'opacity .5s'; hurtEl.style.opacity = 0; }); });
export function bigText(title, sub = '') { bigEl.innerHTML = title ? `${title}<small>${sub}</small>` : ''; bigEl.style.opacity = title ? 1 : 0; }
export const helpEl = $('help');
let toastTimer = 0;
// notifications stack in a small feed on the left; each fades out on its own
const feedEl = $('feed');
export function toast(msg, secs = 2.5) {
  const d = document.createElement('div'); d.textContent = msg; feedEl.appendChild(d);
  while (feedEl.children.length > 4) feedEl.firstChild.remove();
  setTimeout(() => { d.style.opacity = 0; setTimeout(() => d.remove(), 500); }, secs * 1000);
}
on('toast', toast);
export const clockStr = () => { const h = Math.floor(env.time), m = Math.floor((env.time - h) * 60); return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };
export const toggleDebug = () => debugEl.style.display = debugEl.style.display === 'block' ? 'none' : 'block';
export const toggleHelp = () => helpEl.style.opacity = helpEl.style.opacity === '0' ? '1' : '0';
export const radioName = i => i < 0 ? 'Radio off' : `${STATIONS[i].name} — ${STATIONS[i].genre}`;

/* =====================================================================
   UI: minimap (pre-rendered map image, rotated with the camera)
   ===================================================================== */
export const MAPW = 2400, MAPS = 800, MPP = MAPW / MAPS;
let mapCanvas;
export const getMapCanvas = () => mapCanvas;
export function buildMapCanvas() {
  const cv = document.createElement('canvas'); cv.width = cv.height = MAPS; const g = cv.getContext('2d');
  const img = g.createImageData(MAPS, MAPS);
  for (let py = 0; py < MAPS; py++) for (let px = 0; px < MAPS; px++) {
    const x = -MAPW / 2 + (px + .5) * MPP, z = -MAPW / 2 + (py + .5) * MPP, h = sampleH(x, z), i = (py * MAPS + px) * 4;
    let c;
    if (h < CFG.waterY) { const k = clamp(1 + h / 18, 0.6, 1); c = [0.2 * k, 0.42 * k, 0.56 * k]; }
    else c = terrainColor(x, z, h).map(v => v * (0.85 + clamp(h / 120, 0, 0.3)));
    img.data[i] = c[0] * 255; img.data[i + 1] = c[1] * 255; img.data[i + 2] = c[2] * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const W = x => (x + MAPW / 2) / MPP;
  const R = CFG.ring;
  g.fillStyle = '#3d4046';
  g.beginPath(); g.roundRect(W(R.cx - R.hx - 12), W(R.cz - R.hz - 12), (2 * R.hx + 24) / MPP, (2 * R.hz + 24) / MPP, (R.r + 12) / MPP); g.fill();
  g.strokeStyle = '#d9b44a'; g.lineWidth = 2.2;
  g.beginPath(); g.roundRect(W(R.cx - R.hx), W(R.cz - R.hz), 2 * R.hx / MPP, 2 * R.hz / MPP, R.r / MPP); g.stroke();
  const lotCol = { downtown: '#8a8984', plaza: '#b3aa98', midtown: '#87847d', industrial: '#6e6b66', suburb: '#5f8a42', park: '#4c8a34' };
  for (const b of blocks) { g.fillStyle = lotCol[b.district]; g.fillRect(W(b.x0), W(b.z0), (b.x1 - b.x0) / MPP, (b.z1 - b.z0) / MPP); }
  for (const [x, z, w, d, k] of footprints) { g.fillStyle = k === 'house' ? '#c9b9a0' : k === 'big' ? '#9a958c' : '#b9bcc2'; g.fillRect(W(x), W(z), Math.max(1, w / MPP), Math.max(1, d / MPP)); }
  mapCanvas = cv;
}
const mm = $('minimap').getContext('2d');
function drawMinimap() {
  const Sz = mm.canvas.width, r = Sz / 2, v = player.vehicle;
  const scale = v ? clamp(2.2 - v.speed * 0.025, 1.2, 2.2) : 2.2;   // zoom out at speed
  mm.save(); mm.fillStyle = '#20384a'; mm.fillRect(0, 0, Sz, Sz);
  mm.translate(r, r); mm.rotate(cam.yaw); mm.scale(scale, scale);
  const px = (player.pos.x + MAPW / 2) / MPP, pz = (player.pos.z + MAPW / 2) / MPP;
  mm.drawImage(mapCanvas, -px, -pz);
  const rel = (x, z) => [(x - player.pos.x) / MPP, (z - player.pos.z) / MPP];
  if (wanted.level > 0 && !wanted.seen) {   // police search area around where you were last seen
    const [sx, sz] = rel(wanted.lastSeen.x, wanted.lastSeen.z);
    mm.fillStyle = 'rgba(70,120,255,.18)'; mm.strokeStyle = 'rgba(120,160,255,.6)'; mm.lineWidth = 1;
    mm.beginPath(); mm.arc(sx, sz, (60 + wanted.level * 25) / MPP, 0, Math.PI * 2); mm.fill(); mm.stroke();
  }
  for (const [list, col, ch] of [[hospitals, '#1d6fd1', 'H'], [stations, '#14213d', 'P']]) for (const s of list) {
    const [x, z] = rel(s.x, s.z); mm.fillStyle = col; mm.fillRect(x - 4, z - 4, 8, 8);
    mm.save(); mm.translate(x, z); mm.rotate(-cam.yaw); mm.fillStyle = '#fff'; mm.font = 'bold 7px system-ui'; mm.textAlign = 'center'; mm.textBaseline = 'middle'; mm.fillText(ch, 0, 0.5); mm.restore();
  }
  const blink = Math.floor(performance.now() / 250) % 2;
  for (const u of units) { const [x, z] = rel(u.v.pos.x, u.v.pos.z); mm.fillStyle = blink ? '#ff3b3b' : '#3b6bff'; mm.beginPath(); mm.arc(x, z, 3, 0, Math.PI * 2); mm.fill(); }
  for (const c of peds) if (c.cop && !c.ko) { const [x, z] = rel(c.pos.x, c.pos.z); mm.fillStyle = blink ? '#3b6bff' : '#ff3b3b'; mm.fillRect(x - 1.6, z - 1.6, 3.2, 3.2); }
  const maxR = (r - 16) / scale;
  const blip = (x, z, col, label, size = 6) => {
    let [bx, bz] = rel(x, z); const L = Math.hypot(bx, bz), edge = L > maxR;
    if (edge) { bx *= maxR / L; bz *= maxR / L; }
    mm.fillStyle = col; mm.strokeStyle = '#000'; mm.lineWidth = 0.7;
    if (edge && label === '▼') { mm.save(); mm.translate(bx, bz); mm.rotate(Math.atan2(bz, bx) + Math.PI / 2); mm.beginPath(); mm.moveTo(0, -6); mm.lineTo(4.5, 3); mm.lineTo(-4.5, 3); mm.closePath(); mm.fill(); mm.stroke(); mm.restore(); return; }
    if (edge && label !== '▼') return;   // other blips only when on the map
    mm.beginPath(); mm.arc(bx, bz, size / 2 + 1, 0, Math.PI * 2); mm.fill(); mm.stroke();
    if (label && label !== '▼') { mm.save(); mm.translate(bx, bz); mm.rotate(-cam.yaw); mm.fillStyle = '#111'; mm.font = 'bold 6px system-ui'; mm.textAlign = 'center'; mm.textBaseline = 'middle'; mm.fillText(label, 0, 0.5); mm.restore(); }
  };
  for (const b of [...blips(), ...shopBlips()]) blip(b.x, b.z, b.color, b.label, 7);
  const op = objectivePoint(); if (op) blip(op.x, op.z, '#ffd34d', '▼', 7);
  if (S.waypoint) { blip(S.waypoint.x, S.waypoint.z, '#ff4fd8', null, 6); const [wx, wz] = rel(S.waypoint.x, S.waypoint.z); if (Math.hypot(wx, wz) > maxR) blip(S.waypoint.x, S.waypoint.z, '#ff4fd8', '▼'); }
  const lv = player.lastVehicle;   // marker for the vehicle you last left
  if (lv && !lv.removed && !player.vehicle) {
    mm.fillStyle = '#4aa8ff'; mm.strokeStyle = '#002'; mm.lineWidth = 0.6;
    const lx = (lv.pos.x - player.pos.x) / MPP, lz = (lv.pos.z - player.pos.z) / MPP;
    mm.beginPath(); mm.arc(lx, lz, 3.2, 0, Math.PI * 2); mm.fill(); mm.stroke();
  }
  mm.rotate(Math.PI - player.facing);
  mm.fillStyle = '#fff'; mm.strokeStyle = '#000'; mm.lineWidth = 0.5;
  mm.beginPath(); mm.moveTo(0, -6); mm.lineTo(4.2, 5); mm.lineTo(0, 2.8); mm.lineTo(-4.2, 5); mm.closePath(); mm.fill(); mm.stroke();
  mm.restore();
  const nx = r + Math.sin(cam.yaw) * (r - 22), ny = r - Math.cos(cam.yaw) * (r - 22);
  mm.fillStyle = 'rgba(0,0,0,.6)'; mm.beginPath(); mm.arc(nx, ny, 17, 0, Math.PI * 2); mm.fill();
  mm.fillStyle = '#fff'; mm.font = 'bold 22px system-ui'; mm.textAlign = 'center'; mm.textBaseline = 'middle'; mm.fillText('N', nx, ny + 1);
}

/* =====================================================================
   UI: speedometer (canvas gauge)
   ===================================================================== */
const sp = speedoEl.getContext('2d');
function drawSpeedo(v) {
  const W = sp.canvas.width, H = sp.canvas.height, cx = W / 2, cy = H * 0.62, R = H * 0.5;
  const kmh = v.speed * 3.6, maxK = Math.ceil(v.T.maxSpeed * 3.6 / 20) * 20 + 20;
  sp.clearRect(0, 0, W, H);
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2, aV = a0 + (a1 - a0) * Math.min(1, kmh / maxK);
  sp.lineCap = 'round';
  sp.lineWidth = 14; sp.strokeStyle = 'rgba(0,0,0,.45)'; sp.beginPath(); sp.arc(cx, cy, R, a0, a1); sp.stroke();
  sp.lineWidth = 9; sp.strokeStyle = kmh > maxK * 0.8 ? '#ff7a45' : '#ffd36b'; sp.beginPath(); sp.arc(cx, cy, R, a0, aV); sp.stroke();
  sp.fillStyle = 'rgba(255,255,255,.7)'; sp.font = '600 15px system-ui'; sp.textAlign = 'center'; sp.textBaseline = 'middle';
  for (let k = 0; k <= maxK; k += 40) { const a = a0 + (a1 - a0) * k / maxK; sp.fillText(k, cx + Math.cos(a) * (R - 26), cy + Math.sin(a) * (R - 26)); }
  sp.fillStyle = '#fff'; sp.font = '800 46px "Arial Black", Impact, sans-serif'; sp.fillText(Math.round(kmh), cx, cy - 4);
  sp.font = '700 15px system-ui'; sp.fillStyle = 'rgba(255,255,255,.8)'; sp.fillText(v.vF < -0.5 ? 'km/h  R' : 'km/h', cx, cy + 30);
  const hp = v.health / v.T.health, bw = W * 0.6;   // health bar
  sp.fillStyle = 'rgba(0,0,0,.5)'; sp.fillRect(cx - bw / 2, H - 22, bw, 9);
  sp.fillStyle = hp > 0.4 ? '#6fd36b' : hp > 0.12 ? '#ffb347' : '#ff4b3a'; sp.fillRect(cx - bw / 2, H - 22, bw * hp, 9);
}
function setSpeedoInfo(v) {
  $('speedoName').textContent = v.T.name;
  $('speedoRadio').textContent = '♪ ' + radioName(S.radio);
}

/* =====================================================================
   UI: per-frame HUD update
   ===================================================================== */
let fpsAcc = 0, fpsFrames = 0, hudTimer = 0, lastZone = '', zoneTimer = 0, inVeh = null;
export let fps = 0;
export function updateHUD(dt) {
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
  drawMinimap();
  const v = player.vehicle;
  if (v !== inVeh) { inVeh = v; $('speedoWrap').style.display = v ? 'block' : 'none'; zoneEl.classList.toggle('raised', !!v); if (v) setSpeedoInfo(v); }
  if (v) drawSpeedo(v);
  // mission HUD
  const dlg = MS.dlg;
  lbEl.className = dlg ? 'on' : ''; hudEl.classList.toggle('cine', !!dlg); dlgEl.style.display = dlg && dlg.lines[dlg.i] ? 'block' : 'none';
  if (dlg && dlg.lines[dlg.i]) { $('dlgWho').textContent = dlg.lines[dlg.i][0]; $('dlgText').textContent = dlg.lines[dlg.i][1]; }
  objEl.style.display = MS.active && MS.text && !dlg ? 'block' : 'none'; if (MS.active) objEl.textContent = MS.text;
  const tm = MS.race && MS.race.countdown <= 0 ? MS.race.t : MS.timer;
  timerEl.style.display = MS.active && tm !== null && tm !== undefined && !dlg ? 'block' : 'none';
  if (MS.active && tm != null) { const t = Math.max(0, tm); timerEl.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; timerEl.style.color = MS.timer !== null && t < 15 && !MS.race ? '#ff6b5a' : '#fff'; }
  crossEl.style.display = player.aiming ? 'block' : 'none';
  hpBar.style.width = player.health + '%'; arBar.style.width = player.armor + '%';
  starsEl.className = wanted.level > 0 && !wanted.seen ? 'flash' : '';
  hudTimer -= dt; if (hudTimer > 0) return; hudTimer = 0.2;
  if (v) setSpeedoInfo(v);
  moneyEl.textContent = fmtMoney(S.money);
  starsEl.innerHTML = wanted.level ? '<b>' + '★'.repeat(wanted.level) + '</b>' + '★'.repeat(5 - wanted.level) : '';
  const w = WEAPONS[S.weapon], st = S.weapons[S.weapon];
  weaponEl.innerHTML = w.melee ? w.name : `${w.name}<span>${combat.reloadT > 0 ? 'reloading…' : st.mag + ' / ' + st.reserve}</span>`;
  clockEl.textContent = clockStr() + '  ·  ' + { clear: 'Clear', rain: 'Rain', fog: 'Fog' }[env.weather];
  const act = S.paused || S.menu ? null : (interactable() || shopInteractable());
  const near = S.paused || S.menu || act ? null : nearestEnterable();
  promptEl.style.opacity = act || near ? 1 : 0;
  if (act) promptEl.innerHTML = `<b>E</b> ${act.label}`;
  else if (near) promptEl.innerHTML = `<b>F</b> ${near.driver?.isAI ? 'Steal' : 'Enter'} ${near.T.name}`;
  const [zn, zs] = zoneName(player.pos.x, player.pos.z);
  if (zn !== lastZone) { lastZone = zn; zoneEl.innerHTML = zn + '<small>' + zs + '</small>'; zoneEl.style.opacity = 1; zoneTimer = 4; }
  if (zoneTimer > 0 && (zoneTimer -= 0.2) <= 0) zoneEl.style.opacity = 0;
  if (debugEl.style.display === 'block') {
    const i = renderer.info.render, p = player.pos;
    debugEl.textContent = `${fps.toFixed(0)} fps  res ×${renderer.getPixelRatio().toFixed(2)}  calls ${i.calls}  tris ${(i.triangles / 1000).toFixed(0)}k\n` +
      `pos ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}  ${v ? v.type + ' ' + v.state + ' hp ' + v.health.toFixed(0) : player.swimming ? 'swim' : player.onGround ? 'ground' : 'air'}\n` +
      `colliders ${colliderCount()}  chunks ${chunkCount()}  vehicles ${vehicles.length}  peds ${peds.length}\n` +
      Object.entries(window.__prof || {}).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ');
  }
}
