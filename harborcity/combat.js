// combat.js — weapons, aiming, hitscan shooting (player and NPCs), melee, tracers, muzzle flashes, pickups
import * as THREE from 'three';
import { CFG, V3, clamp, lerp, rand, rr, scene, camera, cam, S, emit, on } from './core.js';
import { rayWorld, rayAABB, baseGround } from './world.js';
import { input } from './input.js';
import { player, charModel, damagePlayer } from './player.js';
import { peds } from './peds.js';
import { vehicles } from './vehicles.js';
import { sparks, emitP, smoke, fire as fireFx, splash } from './particles.js';
import * as sfx from './audio.js';

/* =====================================================================
   COMBAT: weapon data
   ===================================================================== */
export const WEAPONS = {
  fist:    { name: 'Fists',   melee: true, dmg: 16, rate: 0.42, range: 1.7 },
  pistol:  { name: 'Pistol',  dmg: 26, rate: 0.2,   mag: 12, spread: 0.01,  bloom: 0.018, pellets: 1, range: 90, recoil: 0.022, reload: 1.2, auto: false, len: 0.24, maxReserve: 240 },
  smg:     { name: 'SMG',     dmg: 13, rate: 0.075, mag: 30, spread: 0.022, bloom: 0.007, pellets: 1, range: 70, recoil: 0.01,  reload: 1.7, auto: true,  len: 0.44, maxReserve: 480 },
  shotgun: { name: 'Shotgun', dmg: 12, rate: 0.85,  mag: 6,  spread: 0.07,  bloom: 0.03,  pellets: 8, range: 32, recoil: 0.07,  reload: 2.2, auto: false, len: 0.85, maxReserve: 96 },
};
export const ORDER = ['fist', 'pistol', 'smg', 'shotgun'];
export const combat = { cd: 0, bloom: 0, reloadT: 0, aim: 0, recentFire: 0 };

// gun models held in the right hand (they extend along the arm, so they point forward when aiming)
const guns = {};
for (const k of ['pistol', 'smg', 'shotgun']) {
  const L = WEAPONS[k].len, g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, L, 0.1).translate(0, -0.62 - L / 2 + 0.06, 0.04), new THREE.MeshStandardMaterial({ color: 0x1e1f22, metalness: 0.6, roughness: 0.4 }));
  body.castShadow = true; g.add(body);
  if (k !== 'pistol') g.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08).translate(0, -0.66, 0.11), body.material));
  g.visible = false; charModel.armR.add(g); guns[k] = g;
}

/* =====================================================================
   COMBAT: ray tests against characters, vehicles and the world
   ===================================================================== */
function rayCylinder(o, d, cx, cy, cz, r, h) {
  const ox = o.x - cx, oz = o.z - cz, a = d.x * d.x + d.z * d.z;
  if (a < 1e-8) return null;
  const b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - r * r, disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) { if (t < 0) continue; const y = o.y + d.y * t; if (y >= cy && y <= cy + h) return t; }
  return null;
}
const _lo = new V3(), _ld = new V3();
function rayVehicle(o, d, v) {
  const c = Math.cos(v.heading), s = Math.sin(v.heading), px = o.x - v.pos.x, pz = o.z - v.pos.z;
  _lo.set(px * c - pz * s, o.y - v.pos.y, px * s + pz * c); _ld.set(d.x * c - d.z * s, d.y, d.x * s + d.z * c);   // into the vehicle's local frame
  const T = v.T; return rayAABB(_lo.x, _lo.y, _lo.z, _ld.x, _ld.y, _ld.z, { minX: -T.wid / 2, maxX: T.wid / 2, minY: 0.2, maxY: T.hgt, minZ: -T.len / 2, maxZ: T.len / 2 });
}
// nearest hit along a ray: { t, kind: 'world'|'ped'|'vehicle'|'player', obj }
export function raycast(o, d, maxT, { hitPlayer = false, skipPed = null, skipVehicle = null } = {}) {
  let best = { t: rayWorld(o, d.x, d.y, d.z, maxT), kind: 'world', obj: null };
  if (best.t >= maxT) best.kind = 'none';
  for (const p of peds) {
    if (p === skipPed || p.pos.distanceToSquared(o) > (maxT + 2) ** 2) continue;
    const t = p.lie > 0.5 ? rayCylinder(o, d, p.pos.x, p.pos.y, p.pos.z, 0.6, 0.45) : rayCylinder(o, d, p.pos.x, p.pos.y, p.pos.z, 0.33, 1.85 * p.scale);
    if (t !== null && t < best.t) best = { t, kind: 'ped', obj: p };
  }
  for (const v of vehicles) {
    if (v === skipVehicle || v.removed || !v.root.visible || v.pos.distanceToSquared(o) > (maxT + 6) ** 2) continue;
    const t = rayVehicle(o, d, v); if (t !== null && t < best.t) best = { t, kind: 'vehicle', obj: v };
  }
  if (hitPlayer && !player.vehicle && !player.dead) {
    const t = rayCylinder(o, d, player.pos.x, player.pos.y, player.pos.z, 0.36, 1.8);
    if (t !== null && t < best.t) best = { t, kind: 'player', obj: player };
  }
  return best;
}

/* =====================================================================
   COMBAT: tracers + muzzle flash
   ===================================================================== */
const TR = 48, trPos = new Float32Array(TR * 6), trLife = new Float32Array(TR); let trI = 0;
const trGeo = new THREE.BufferGeometry(); trGeo.setAttribute('position', new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage));
const tracers = new THREE.LineSegments(trGeo, new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.85 }));
tracers.frustumCulled = false; scene.add(tracers);
const flash = new THREE.PointLight(0xffc060, 0, 14, 1.5); scene.add(flash);
let flashT = 0;
function tracer(a, b) { const i = trI; trI = (trI + 1) % TR; trPos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6); trLife[i] = 0.06; }
function muzzle(p) {
  emitP(fireFx, p.x, p.y, p.z, 0, 0.5, 0, 0.05, 0.5, 0.15, [1, 0.85, 0.4, 1], [1, 0.5, 0.1, 0], 1, 0);
  flash.position.copy(p); flashT = 0.05;
}
function impactFx(p, kind) {
  if (kind === 'vehicle' || kind === 'world') sparks(p.x, p.y, p.z, kind === 'vehicle' ? 5 : 2);
  if (kind === 'world' || kind === 'ped' || kind === 'player') emitP(smoke, p.x, p.y, p.z, 0, 0.6, 0, 0.35, 0.15, 0.5, kind === 'world' ? [0.6, 0.58, 0.55, 0.6] : [1, 1, 1, 0.8], [0.7, 0.7, 0.7, 0], 2, 0);
  if (kind === 'ped' || kind === 'player') for (let i = 0; i < 3; i++) emitP(fireFx, p.x, p.y + 0.2, p.z, (rand() - .5) * 2, 1 + rand(), (rand() - .5) * 2, 0.35, 0.16, 0.06, [1, 1, 0.5, 1], [1, 0.9, 0.3, 0], 1, 4);   // cartoon "pow" stars
}

/* =====================================================================
   COMBAT: firing (shared by the player and police)
   ===================================================================== */
const _d = new V3(), _e = new V3();
// fire one round from o along d (already includes spread)
export function fireRound(o, d, dmg, range, shooter) {
  const hit = raycast(o, d, range, { hitPlayer: shooter !== 'player', skipPed: shooter && shooter !== 'player' ? shooter : null, skipVehicle: shooter === 'player' ? player.vehicle : null });
  let t = hit.kind === 'none' ? range : hit.t;
  if (d.y < -1e-3 && o.y > CFG.waterY) {   // the round hits the sea surface first: splash, no damage
    const tw = (CFG.waterY - o.y) / d.y;
    if (tw < t && baseGround(o.x + d.x * tw, o.z + d.z * tw) < CFG.waterY) { _e.copy(o).addScaledVector(d, tw); tracer(o, _e); splash(_e.x, CFG.waterY, _e.z, 4, 0.35); return { kind: 'water', t: tw }; }
  }
  _e.copy(o).addScaledVector(d, t);
  tracer(o, _e);
  if (hit.kind === 'none') return hit;
  impactFx(_e, hit.kind);
  const by = shooter === 'player' ? 'player' : 'npc';
  if (hit.kind === 'ped') hit.obj.damage(dmg, by, d);
  else if (hit.kind === 'vehicle') { hit.obj.damage(dmg * 0.7, by); emit('vehicleShot', hit.obj, by); }
  else if (hit.kind === 'player') damagePlayer(dmg, 'gunfire');
  return hit;
}
// NPC shot at a target point with a hit probability (misses go wide but still look like near misses)
export function npcShoot(from, target, accuracy, dmg, shooterPed) {
  _d.subVectors(target, from).normalize();
  const miss = rand() > accuracy, sp = miss ? rr(0.04, 0.09) : 0.004;
  _d.x += (rand() - .5) * sp * 2; _d.y += (rand() - .5) * sp; _d.z += (rand() - .5) * sp * 2; _d.normalize();
  muzzle(from);
  const vol = clamp(1 - from.distanceTo(camera.position) / 120, 0, 1);
  sfx.gunshot('cop', vol * 0.8);
  if (player.vehicle && !miss && from.distanceTo(player.vehicle.pos) < 60) {   // shots at a vehicle hit the vehicle, sometimes the driver
    player.vehicle.damage(dmg * 2.5, 'npc'); if (rand() < 0.25) damagePlayer(dmg * 0.5, 'gunfire');
    _e.copy(player.vehicle.pos); _e.y += 0.9; tracer(from, _e); sparks(_e.x, _e.y, _e.z, 4); return;
  }
  fireRound(from, _d, dmg, 70, shooterPed);
}

// where the crosshair points: first thing along the camera's centre ray
const _ao = new V3(), _ad = new V3();
function aimPoint() {
  camera.getWorldPosition(_ao); camera.getWorldDirection(_ad);
  const hit = raycast(_ao, _ad, 150, { skipVehicle: player.vehicle });
  return _ao.clone().addScaledVector(_ad, hit.kind === 'none' ? 150 : hit.t);
}
function muzzlePos() {
  const f = Math.sin(player.facing), g = Math.cos(player.facing);
  return new V3(player.pos.x + f * 0.55 - g * 0.3, player.pos.y + 1.45, player.pos.z + g * 0.55 + f * 0.3);
}
function shoot(w) {
  const st = S.weapons[S.weapon], target = aimPoint(), mp = muzzlePos();
  player.facing = cam.yaw + Math.PI;
  for (let i = 0; i < w.pellets; i++) {
    _d.subVectors(target, mp).normalize(); const sp = w.spread + combat.bloom;
    _d.x += (rand() - .5) * sp * 2; _d.y += (rand() - .5) * sp * 2; _d.z += (rand() - .5) * sp * 2; _d.normalize();
    fireRound(mp, _d, w.dmg, w.range, 'player');
  }
  muzzle(mp); sfx.gunshot(S.weapon, 1);
  st.mag--; combat.cd = w.rate; combat.bloom = Math.min(0.08, combat.bloom + w.bloom); combat.recentFire = 0.9;
  cam.pitch -= w.recoil; cam.yaw += (rand() - .5) * w.recoil * 0.6; cam.shake = Math.max(cam.shake, w.recoil * 2);
  emit('gunshot', mp, 'player');
}
function punch() {
  const w = WEAPONS.fist, f = Math.sin(player.facing), g = Math.cos(player.facing);
  combat.cd = w.rate; player.punchT = 0.3;
  let hit = false;
  for (const p of peds) {
    const dx = p.pos.x - player.pos.x, dz = p.pos.z - player.pos.z, d = Math.hypot(dx, dz);
    if (d > w.range || p.ko || Math.abs(p.pos.y - player.pos.y) > 1.2) continue;
    if ((dx * f + dz * g) / (d || 1) < 0.5) continue;
    p.damage(w.dmg, 'player', new V3(dx / d, 0, dz / d)); impactFx(new V3(p.pos.x, p.pos.y + 1.4, p.pos.z), 'ped'); hit = true; break;
  }
  sfx.punch(hit);
  if (hit) emit('playerPunch');
}
function startReload() {
  const w = WEAPONS[S.weapon], st = S.weapons[S.weapon];
  if (w.melee || combat.reloadT > 0 || st.mag >= w.mag || st.reserve <= 0) return;
  combat.reloadT = w.reload; sfx.reloadSfx();
}
export function reload() { if (!player.vehicle) startReload(); }
export function selectWeapon(k) {
  if (!S.weapons[k]?.owned || player.vehicle) return false;
  S.weapon = k; combat.reloadT = 0; combat.cd = 0.25; return true;
}
export function cycleWeapon(dir) {
  let i = ORDER.indexOf(S.weapon);
  for (let n = 0; n < ORDER.length; n++) { i = (i + dir + ORDER.length) % ORDER.length; if (selectWeapon(ORDER[i])) return; }
}
export function giveWeapon(k, ammo) {
  const st = S.weapons[k]; st.owned = true; st.reserve = Math.min(WEAPONS[k].maxReserve, st.reserve + ammo);
  if (st.mag === 0) { const take = Math.min(WEAPONS[k].mag, st.reserve); st.mag += take; st.reserve -= take; }
}

/* =====================================================================
   COMBAT: per-frame update
   ===================================================================== */
export function updateCombat(dt) {
  const w = WEAPONS[S.weapon], st = S.weapons[S.weapon];
  const onFoot = !player.vehicle && !player.dead && !player.climb && !player.swimming && player.knock <= 0;
  combat.cd -= dt; combat.recentFire -= dt; combat.bloom = Math.max(0, combat.bloom - dt * 0.1);
  player.aiming = onFoot && !w.melee && (input.aim || combat.recentFire > 0);
  combat.aim = lerp(combat.aim, player.aiming && input.aim ? 1 : 0, 1 - Math.exp(-12 * dt));
  if (combat.reloadT > 0 && (combat.reloadT -= dt) <= 0) {
    const take = Math.min(w.mag - st.mag, st.reserve); st.mag += take; st.reserve -= take;
  }
  for (const k in guns) guns[k].visible = k === S.weapon && !player.vehicle && !player.dead;
  if (onFoot && combat.cd <= 0) {
    if (w.melee) { if (input.firePressed) punch(); }
    else if (combat.reloadT <= 0 && (w.auto ? input.fire : input.firePressed)) {
      if (st.mag > 0) shoot(w);
      else if (st.reserve > 0) startReload();
      else { sfx.emptyClick(); combat.cd = 0.3; }
    }
  }
  // tracers + flash fade
  for (let i = 0; i < TR; i++) if (trLife[i] > 0 && (trLife[i] -= dt) <= 0) trPos.fill(0, i * 6, i * 6 + 6);
  trGeo.attributes.position.needsUpdate = true;
  flashT -= dt; flash.intensity = flashT > 0 ? 40 : 0;
  updatePickups(dt);
}

/* =====================================================================
   COMBAT: pickups (weapons, armour, health) — respawn after a minute
   ===================================================================== */
const pickups = [];
const PICK = {
  pistol:  { color: 0x9aa4b0, give: () => giveWeapon('pistol', 36), label: 'Pistol' },
  smg:     { color: 0x6fd36b, give: () => giveWeapon('smg', 90), label: 'SMG' },
  shotgun: { color: 0xffb347, give: () => giveWeapon('shotgun', 18), label: 'Shotgun' },
  armor:   { color: 0x4aa8ff, give: () => { player.armor = 100; }, label: 'Body armour' },
  health:  { color: 0x6fff8f, give: () => { player.health = 100; }, label: 'Health' },
};
export function addPickup(type, x, z) {
  const P = PICK[type], g = new THREE.Group(), y = baseGround(x, z);
  const m = new THREE.MeshStandardMaterial({ color: P.color, emissive: P.color, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 });
  if (type === 'armor') g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.18), m));
  else if (type === 'health') { g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.16), m), new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.16), m)); }
  else g.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, WEAPONS[type].len + 0.1), m), new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.1).translate(0, -0.15, -0.05), m));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: P.color, transparent: true, opacity: 0.55, depthWrite: false }));
  ring.position.y = -0.85; g.add(ring);
  g.position.set(x, y + 1, z); scene.add(g);
  pickups.push({ type, g, x, z, y, respawn: 0 });
}
function updatePickups(dt) {
  const t = performance.now() / 1000;
  for (const pk of pickups) {
    if (pk.respawn > 0) { if ((pk.respawn -= dt) <= 0) pk.g.visible = true; continue; }
    pk.g.rotation.y = t * 2; pk.g.position.y = pk.y + 1 + Math.sin(t * 3) * 0.1;
    const r = player.vehicle ? 3 : 1.4;
    if (!player.dead && Math.hypot(player.pos.x - pk.x, player.pos.z - pk.z) < r && Math.abs(player.pos.y - pk.y) < 2.5) {
      PICK[pk.type].give(); pk.g.visible = false; pk.respawn = 60; sfx.pickupSfx(); emit('toast', 'Picked up: ' + PICK[pk.type].label, 1.8);
    }
  }
}
export const pickupList = pickups;
