// police.js — wanted level & crimes, police cars (road-graph pursuit → direct pursuit), officers on foot, roadblocks,
// hospitals / police stations (respawn points)
import * as THREE from 'three';
import { CFG, V3, clamp, rand, rr, pick, scene, inst, addCollider, canvasTex, on, emit } from './core.js';
import { rayWorld, blocks, baseGround } from './world.js';
import { nodes, edges, lanePath, pointAt, pnodes } from './nav.js';
import { vehicles, spawnVehicle, removeVehicle } from './vehicles.js';
import { player } from './player.js';
import { peds, spawnCop, inView } from './peds.js';
import { npcShoot, addPickup } from './combat.js';
import * as sfx from './audio.js';

/* =====================================================================
   POLICE: wanted level
   ===================================================================== */
export const wanted = { level: 0, points: 0, seen: false, unseenT: 0, lastSeen: new V3(), search: new V3(), searchT: 0 };
// where the police think the player is: exact while seen, otherwise a point they are searching near the last sighting
const knownPos = () => wanted.seen ? (player.vehicle ? player.vehicle.pos : player.pos) : wanted.search;
const TH = [0, 1, 5, 12, 22, 35];                 // crime points needed for each star
const CARS = [0, 2, 3, 4, 6, 8], FOOT = [0, 2, 3, 4, 5, 6];
export function addCrime(pts) {
  if (player.dead || pts <= 0) return;
  wanted.points = Math.min(60, wanted.points + pts);
  let l = wanted.level; for (let i = 5; i >= 1; i--) if (wanted.points >= TH[i]) { l = Math.max(l, i); break; }
  if (l > wanted.level) { wanted.level = l; emit('wantedChanged', l); }
  wanted.lastSeen.copy(player.pos); wanted.search.copy(player.pos); wanted.searchT = 4; wanted.unseenT = 0;
}
export function clearWanted(silent = false) {
  const had = wanted.level > 0; Object.assign(wanted, { level: 0, points: 0, unseenT: 0, seen: false });
  if (had && !silent) emit('toast', 'You lost the police');
  emit('wantedChanged', 0);
}
const copNear = (p, r) => peds.some(c => c.cop && !c.ko && c.pos.distanceTo(p) < r) || units.some(u => u.v.pos.distanceTo(p) < r);

// crimes
on('gunshot', (pos, who) => {
  if (who !== 'player') return;
  const witnessed = copNear(pos, 60) || peds.some(p => !p.ko && p.pos.distanceTo(pos) < 45);
  if (witnessed) addCrime(wanted.level === 0 ? 1 : 0.25);
  if (copNear(pos, 35)) addCrime(1.5);
});
on('pedDamaged', (p, by) => { if (by === 'player') addCrime(p.cop ? 5 : 1); });
on('pedKO', (p, by) => { if (by === 'player') addCrime(p.cop ? 9 : 3); });
on('carjack', v => { if (v.police) addCrime(6); else if (copNear(player.pos, 50)) addCrime(2); });
on('enterVehicle', v => { if (v.police && !v.dead) addCrime(5); });
on('vehicleShot', (v, by) => { if (by === 'player') addCrime(v.police ? 4 : v.driver ? 0.6 : 0.2); });
on('explosion', (pos, r, src) => { if (src?.lastAttacker === 'player') addCrime(src.police ? 8 : 3); });
on('vehicleImpact', (v, speed) => {   // only counts when the player is the one doing the ramming
  const pv = player.vehicle; if (v.police && speed > 4 && pv && pv !== v && v.pos.distanceTo(pv.pos) < 8 && pv.speed > v.speed + 2) addCrime(2);
});

/* =====================================================================
   POLICE: road-graph distance field toward the player (for route-finding)
   ===================================================================== */
let field = null, fieldT = 0;
const nearestNode = p => { let b = nodes[0], bd = Infinity; for (const n of nodes) { const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2; if (d < bd) { bd = d; b = n; } } return b; };
function buildField(target) {
  const t = nearestNode(target), dist = new Float32Array(nodes.length).fill(Infinity), done = new Uint8Array(nodes.length);
  dist[t.id] = 0;
  for (let k = 0; k < nodes.length; k++) {   // Dijkstra on ~250 nodes: tiny, O(n²) is fine
    let u = -1, ud = Infinity; for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
    if (u < 0) break; done[u] = 1;
    for (const e of nodes[u].in) { const len = e.len ??= lanePath(e, 0).len + 20, w = e.from.id; if (ud + len < dist[w]) dist[w] = ud + len; }
  }
  return dist;
}

/* =====================================================================
   POLICE: units (cars)
   ===================================================================== */
export const units = [];
const _o = new V3();
const los = (a, ay, b, by) => {   // clear line of sight between two points (static world only)
  _o.set(a.x, ay, a.z); const dx = b.x - a.x, dy = by - ay, dz = b.z - a.z, d = Math.hypot(dx, dy, dz) || 1;
  return rayWorld(_o, dx / d, dy / d, dz / d, d) >= d - 0.6;
};
class Unit {
  constructor(v) {
    this.v = v; v.ai = this; v.driver = this; v.siren = true; v.parked = false; v.wake();
    Object.assign(this, { isAI: true, ctl: { throttle: 0, steer: 0, handbrake: false }, mode: 'route', wp: null, prev: null, fireT: rr(1, 2),
      stuckT: 0, revT: 0, wait: 0, panic: 0, honkT: 0, los: false, deployed: false });
  }
  honk() {}
  bail(from, keepVehicle) { this.deploy(keepVehicle); }
  deploy(keepVehicle = false) {   // officers get out and continue on foot
    if (this.deployed) return; this.deployed = true;
    const v = this.v; v.ai = null; if (!keepVehicle) v.driver = null; v.parked = true; v.siren = wanted.level > 0;
    const sx = Math.cos(v.heading), sz = -Math.sin(v.heading);
    if (!v.dead) for (const s of [1, -1]) spawnCop(v.pos.x + sx * s * (v.T.wid / 2 + 0.8), v.pos.z + sz * s * (v.T.wid / 2 + 0.8));
    units.splice(units.indexOf(this), 1);
  }
  waypoint(target) {
    if (!field) return target;
    const v = this.v;
    if (this.wp && Math.hypot(this.wp.x - v.pos.x, this.wp.z - v.pos.z) < 14) {   // reached: step to the neighbour closest to the player
      const here = this.wp; let best = null;
      for (const e of here.out) if (e.to !== this.prev && (!best || field[e.to.id] < field[best.id])) best = e.to;
      this.prev = here; this.wp = best;
    }
    if (!this.wp) {   // first pick: a nearby node that is both close and on a short route
      let best = null, bs = Infinity;
      const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
      for (const n of nodes) { const d = Math.hypot(n.x - v.pos.x, n.z - v.pos.z); if (d > 160) continue;
        const behind = ((n.x - v.pos.x) * fx + (n.z - v.pos.z) * fz) < 0 && d > 15; const s = d * 1.5 + field[n.id] + (behind ? 250 : 0); if (s < bs) { bs = s; best = n; } }
      this.wp = best;
    }
    if (!this.wp || field[this.wp.id] === 0) return target;
    return this.wp;
  }
  update(dt) {
    const v = this.v, c = this.ctl;
    if (v.removed) { units.splice(units.indexOf(this), 1); return; }
    if (v.dead || v.state === 'burning') { this.deploy(); return; }
    const target = knownPos();
    const dx = target.x - v.pos.x, dz = target.z - v.pos.z, d = Math.hypot(dx, dz);
    if (wanted.level === 0 || player.dead) this.mode = 'leave';
    else if (this.los && d < 55) this.mode = 'direct';
    else if (d > 75 || (!this.los && this.mode === 'direct' && d > 25)) { if (this.mode === 'direct') this.wp = null; this.mode = 'route'; }
    if (this.mode !== 'leave' && !player.dead && wanted.seen) {
      if (!player.vehicle && d < 18 && (v.speed < 3 || d < 9)) { this.deploy(); return; }
      if (player.vehicle && d < 11 && player.vehicle.speed < 1.5 && v.speed < 3) { this.deploy(); return; }
    }
    let gx, gz, want;
    if (this.mode === 'leave') { gx = v.pos.x - dx; gz = v.pos.z - dz; want = 14; v.siren = false; }
    else if (this.mode === 'direct') {
      const pv = player.vehicle, lead = Math.min(1.2, d / 25);
      gx = target.x + (pv ? pv.vel.x * lead : 0); gz = target.z + (pv ? pv.vel.z * lead : 0);
      want = pv ? (wanted.level >= 3 ? 38 : Math.min(34, d * 0.9 + pv.speed)) : Math.min(24, d * 1.1);
      if (pv && pv.speed < 8) want = Math.min(want, 3 + d * 0.6);   // box in a stopped car rather than ploughing into it
    } else { const w = this.waypoint(target); gx = w.x; gz = w.z; want = 34; }
    // steering toward the goal, with feeler rays to avoid walls
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading), lx = gx - v.pos.x, lz = gz - v.pos.z;
    let steer = clamp(Math.atan2(lx * -fz + lz * fx, lx * fx + lz * fz) * 2, -1, 1);
    const L = 7 + v.speed * 0.6; _o.set(v.pos.x + fx * 2, v.pos.y + 0.8, v.pos.z + fz * 2);
    for (const side of [1, -1]) { const a = v.heading + side * 0.45, t = rayWorld(_o, Math.sin(a), 0, Math.cos(a), L); if (t < L) steer += side * (1 - t / L) * 1.6; }
    const ahead = rayWorld(_o, fx, 0, fz, L); if (ahead < L * 0.5 && v.speed > 6) want = Math.min(want, 6);
    // stuck against something: reverse out
    if (want > 3 && v.speed < 1 && this.revT <= 0) { if ((this.stuckT += dt) > 1.4) { this.revT = 1.1; this.stuckT = 0; } } else this.stuckT = 0;
    if (this.revT > 0) { this.revT -= dt; c.throttle = -1; c.steer = clamp(-steer, -1, 1); c.handbrake = false; }
    else { c.steer = clamp(steer, -1, 1); const diff = want - v.vF; c.throttle = diff > 0 ? clamp(diff * 0.4, 0.2, 1) : clamp(diff * 0.4, -1, 0); c.handbrake = false; }
    // shooting from the car at 3+ stars
    if (this.mode === 'direct' && wanted.level >= 3 && this.los && d < 35 && (this.fireT -= dt) <= 0) {
      this.fireT = rr(0.7, 1.4);
      npcShoot(new V3(v.pos.x + Math.cos(v.heading) * 1.1, v.pos.y + 1.3, v.pos.z - Math.sin(v.heading) * 1.1), new V3(target.x, target.y + (player.vehicle ? 0.9 : 1.2), target.z), clamp(0.45 - d / 100, 0.1, 0.45), 7, null);
    }
  }
}

/* =====================================================================
   POLICE: spawning, officers, roadblocks, sight checks
   ===================================================================== */
function spawnUnit() {
  const p = knownPos(), pv = wanted.seen && player.vehicle, moving = pv && pv.speed > 8;
  const near = edges.filter(e => { const a = e.pts[0]; return Math.hypot(a[0] - p.x, a[1] - p.z) < 260; });
  const wantAhead = moving && rand() < 0.7;   // fleeing drivers mostly meet police coming the other way
  for (let tries = 0; tries < 30 && near.length; tries++) {
    const e = pick(near), path = lanePath(e, e.ring ? 2 : 1.75); if (path.len < 20) continue;
    const s = rr(5, path.len - 5), [x, z] = pointAt(path, s), d = Math.hypot(x - p.x, z - p.z);
    if (d < (wanted.seen ? 110 : 60) || d > 210 || inView(x, 1, z, 4) || Math.hypot(x - player.pos.x, z - player.pos.z) < 80) continue;
    if (wantAhead && ((x - p.x) * pv.vel.x + (z - p.z) * pv.vel.z) / (d * pv.speed) < 0.3) continue;
    if (vehicles.some(o => Math.abs(o.pos.x - x) < 10 && Math.abs(o.pos.z - z) < 10)) continue;
    const [bx, bz] = pointAt(path, s + 2), v = spawnVehicle('police', x, z, Math.atan2(bx - x, bz - z));
    units.push(new Unit(v)); return;
  }
}
function spawnFootCop() {
  const c = knownPos(), lo = wanted.seen ? 55 : 20, hi = wanted.seen ? 95 : 70;
  const near = pnodes.filter(n => { const d = Math.hypot(n.x - c.x, n.z - c.z); return d > lo && d < hi && Math.hypot(n.x - player.pos.x, n.z - player.pos.z) > 50; });
  for (let t = 0; t < 8 && near.length; t++) { const n = pick(near); if (!inView(n.x, 1, n.z)) { spawnCop(n.x, n.z); return; } }
}
const roadblocks = [];
function spawnRoadblock() {
  const pv = player.vehicle; if (!pv || pv.speed < 8) return;
  const hx = pv.vel.x / pv.speed, hz = pv.vel.z / pv.speed;
  let best = null, bd = Infinity;
  for (const n of nodes) {
    const dx = n.x - pv.pos.x, dz = n.z - pv.pos.z, d = Math.hypot(dx, dz);
    if (d < 90 || d > 170 || (dx * hx + dz * hz) / d < 0.85) continue;
    if (d < bd) { bd = d; best = n; }
  }
  if (!best) return;
  const tx = pv.pos.x - best.x, tz = pv.pos.z - best.z, tl = Math.hypot(tx, tz), ux = tx / tl, uz = tz / tl;
  const cx = best.x + ux * 18, cz = best.z + uz * 18, px = uz, pz = -ux;   // across the road, 18 m before the junction
  const rb = { t: 60, cars: [] };
  for (const s of [-1, 1]) { const v = spawnVehicle('police', cx + px * s * 2.6, cz + pz * s * 2.6, Math.atan2(px, pz)); v.siren = true; v.parked = true; rb.cars.push(v); }
  for (const s of [-1, 1]) spawnCop(cx - ux * 4 + px * s * 2, cz - uz * 4 + pz * s * 2);
  roadblocks.push(rb); emit('toast', 'Roadblock ahead!', 1.6);
}

let spawnT = 0, footT = 0, blockT = 12, seeT = 0, arrestT = 0, sirenNear = 0;
export function updatePolice(dt) {
  const L = wanted.level, p = player.pos;
  if (L > 0 && !player.dead) {
    if ((fieldT -= dt) <= 0) {   // route toward where the player will be in ~2 s
      fieldT = 1; const pv = player.vehicle; field = buildField(pv ? new V3(p.x + pv.vel.x * 2, 0, p.z + pv.vel.z * 2) : p);
    }
    if ((spawnT -= dt) <= 0) { spawnT = 3.5 / L; if (units.length < CARS[L]) spawnUnit(); }
    if (!player.vehicle && (footT -= dt) <= 0) { footT = 3; if (peds.filter(c => c.cop && !c.ko && c.pos.distanceTo(knownPos()) < 110).length < FOOT[L]) spawnFootCop(); }
    if (!wanted.seen && ((wanted.searchT -= dt) <= 0 || units.some(u => u.v.pos.distanceTo(wanted.search) < 20))) {   // pick a new spot to search
      wanted.searchT = 8; const a = rand() * Math.PI * 2, r = rand() * (60 + L * 25);
      wanted.search.set(wanted.lastSeen.x + Math.cos(a) * r, 0, wanted.lastSeen.z + Math.sin(a) * r);
    }
    if (L >= 3 && (blockT -= dt) <= 0) { blockT = 22; if (roadblocks.length < 2) spawnRoadblock(); }
  }
  for (const u of units.slice()) u.update(dt);
  // officers on foot
  const pspd = Math.hypot(player.vel.x, player.vel.z), real = player.vehicle ? player.vehicle.pos : p, tgt = knownPos();
  let arresting = false;
  for (const c of peds) {
    if (!c.cop || c.ko || c.state === 'down' || c.state === 'getup') continue;
    if (L === 0 || player.dead) { if (c.state === 'chase' || c.state === 'aim') { c.state = 'return'; c.target = pnodes.reduce((a, n) => (n.x - c.pos.x) ** 2 + (n.z - c.pos.z) ** 2 < (a.x - c.pos.x) ** 2 + (a.z - c.pos.z) ** 2 ? n : a); } continue; }
    if (c.state !== 'chase' && c.state !== 'aim') c.state = 'chase';
    c.goal.copy(tgt);
    const d = c.pos.distanceTo(real);
    if ((c.losT = (c.losT || 0) - dt) <= 0) { c.losT = 0.3; c.los = c.pos.distanceTo(real) < 60 && los(c.pos, c.pos.y + 1.5, real, real.y + 1.2); }
    if (c.los) c.goal.copy(real);
    if (L >= 2 && c.los && d < 40 && d > 2.5) {
      c.state = 'aim';
      if ((c.fireT -= dt) <= 0) {
        c.fireT = rr(0.8, 1.5);
        const f = Math.sin(c.facing), g = Math.cos(c.facing), acc = clamp(0.62 - d / 90 - (pspd > 5 ? 0.2 : 0), 0.08, 0.62);
        npcShoot(new V3(c.pos.x + f * 0.55, c.pos.y + 1.45, c.pos.z + g * 0.55), new V3(real.x, real.y + 1.2, real.z), acc, 8, c);
      }
    } else c.state = 'chase';
    if (L <= 2 && !player.vehicle && !player.dead && d < 1.8 && pspd < 2.5) arresting = true;
  }
  arrestT = arresting ? arrestT + dt : 0;
  if (arrestT > 1.3) { arrestT = 0; emit('playerBusted'); }
  // roadblock cleanup
  for (const rb of roadblocks.slice()) if ((rb.t -= dt) <= 0 && rb.cars.every(v => v.removed || !inView(v.pos.x, 1, v.pos.z, 4))) {
    for (const v of rb.cars) { const i = vehicles.indexOf(v); if (i >= 0 && !v.driver) removeVehicle(i); } roadblocks.splice(roadblocks.indexOf(rb), 1);
  }
  // despawn far or departing units
  for (const u of units.slice()) { const d = u.v.pos.distanceTo(p); if ((d > 280 || (u.mode === 'leave' && d > 120)) && !inView(u.v.pos.x, 1, u.v.pos.z, 4)) { units.splice(units.indexOf(u), 1); const i = vehicles.indexOf(u.v); if (i >= 0) removeVehicle(i); } }
  // line of sight → stars fade when hidden long enough
  if ((seeT -= dt) <= 0) {
    seeT = 0.25;
    const range = 50 + L * 15, eyeY = real.y + 1.2;
    let seen = false;
    for (const u of units) { u.los = u.v.pos.distanceTo(real) < range && los(u.v.pos, u.v.pos.y + 1.6, real, eyeY); seen ||= u.los; }
    wanted.seen = L > 0 && (seen || peds.some(c => c.cop && !c.ko && c.los && c.pos.distanceTo(real) < range));
  }
  if (L > 0 && !player.dead) {
    if (wanted.seen) { wanted.unseenT = 0; wanted.lastSeen.copy(p); wanted.search.copy(p); wanted.searchT = 3; }
    else if ((wanted.unseenT += dt) > 7 + L * 3) {
      wanted.level--; wanted.points = TH[wanted.level]; wanted.unseenT = 0;
      if (wanted.level === 0) clearWanted(); else emit('wantedChanged', wanted.level);
    }
  }
  // siren audio from the nearest unit with lights on
  let sn = 0; for (const v of vehicles) if (v.siren && !v.dead) sn = Math.max(sn, clamp(1 - v.pos.distanceTo(p) / 140, 0, 1));
  sirenNear += (sn - sirenNear) * Math.min(1, dt * 3); sfx.setSiren(sirenNear);
}
export function despawnAllPolice() {
  for (const u of units.slice()) { units.splice(units.indexOf(u), 1); const i = vehicles.indexOf(u.v); if (i >= 0) removeVehicle(i); }
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].cop) peds.splice(i, 1);
  for (const rb of roadblocks) for (const v of rb.cars) { const i = vehicles.indexOf(v); if (i >= 0 && !v.driver) removeVehicle(i); }
  roadblocks.length = 0;
  for (const v of vehicles) if (v.police) v.siren = false;
}

/* =====================================================================
   POLICE: hospitals + police stations (respawn points, signs, pickups)
   ===================================================================== */
export const hospitals = [], stations = [];
const signTex = (txt, bg) => canvasTex(128, (g, s) => { g.fillStyle = bg; g.fillRect(0, 0, s, s); g.fillStyle = '#fff'; g.font = `bold ${txt.length > 1 ? 30 : 92}px system-ui`;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, s / 2, s / 2 + 4); g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(6, 6, s - 12, s - 12); });
function place(list, tx, tz, txt, bg, kind) {
  const b = blocks.filter(b => b.district !== 'park' && b.district !== 'plaza').reduce((a, c) => Math.hypot(c.cx - tx, c.cz - tz) < Math.hypot(a.cx - tx, a.cz - tz) ? c : a);
  const x = b.x0 + 2.2, z = b.cz + 4, y = CFG.curb;
  inst('small', b.x0 + 1.0, y, b.cz, 0.14, 3.2, 0.14, 0, 0x2c2f33);
  addCollider(b.x0 + 0.9, y, b.cz - 0.1, b.x0 + 1.1, y + 3.2, b.cz + 0.1, false);
  const tex = signTex(txt, bg), panel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 1.1), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 }));
  panel.position.set(b.x0 + 1.0, y + 3.5, b.cz); scene.add(panel);
  list.push({ x, z, facing: -Math.PI / 2, kind });
}
export function buildStations() {
  place(hospitals, 160, 330, 'H', '#1d6fd1', 'hospital'); place(hospitals, -420, -330, 'H', '#1d6fd1', 'hospital'); place(hospitals, 520, -280, 'H', '#1d6fd1', 'hospital');
  place(stations, -260, 140, 'POLICE', '#14213d', 'police'); place(stations, 380, 360, 'POLICE', '#14213d', 'police');
}
export function placePickups() {
  for (const h of hospitals) addPickup('health', h.x, h.z - 8);
  for (const s of stations) addPickup('armor', s.x, s.z - 8);
  addPickup('pistol', -40, -76);                       // Founders Plaza
  const ind = blocks.filter(b => b.district === 'industrial'); addPickup('smg', ind[3].x0 + 2.2, ind[3].cz);
  addPickup('shotgun', -832, 95);                      // Port Calloway quay
  addPickup('smg', 709.2, -95); addPickup('armor', -590.8, 205);
}
export const nearest = (list, p) => list.reduce((a, c) => Math.hypot(c.x - p.x, c.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? c : a);
