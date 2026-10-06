// player.js — character model, on-foot movement, collision, climbing, swimming, entering/exiting vehicles
import * as THREE from 'three';
import { CFG, V3, clamp, lerp, smooth, lerpAngle, scene, queryColliders, cam, emit, on, S } from './core.js';
import { groundAt } from './world.js';
import { input } from './input.js';
import { vehicles, pushFromVehicles } from './vehicles.js';
import * as sfx from './audio.js';

/* =====================================================================
   PLAYER: state + character model
   ===================================================================== */
export const PR = 0.35, PH = 1.8, STEP = 0.5;
export const player = { pos: new V3(9, CFG.curb, 24), vel: new V3(), facing: Math.PI, onGround: true, swimming: false, climb: null, hitWall: false,
  vehicle: null, lastVehicle: null, isPlayer: true, health: 100, armor: 0, dead: false, knock: 0, hurtT: 99, aiming: false, punchT: 0 };

/* =====================================================================
   PLAYER: health, armour, damage, death
   ===================================================================== */
export function damagePlayer(amount, src) {
  if (player.dead || amount <= 0) return;
  const absorbed = Math.min(player.armor, amount * 0.7);
  player.armor -= absorbed; player.health -= amount - absorbed; player.hurtT = 0;
  emit('playerHurt', amount, src); sfx.hurt();
  if (player.health <= 0) { player.health = 0; player.dead = true; if (player.vehicle) exitVehicle(new V3(0, 3, 0)); player.knock = 99; emit('playerDied', src); }
}
export function respawnPlayer(x, z, facing = 0) {
  Object.assign(player, { dead: false, health: 100, knock: 0, climb: null, swimming: false, onGround: true, hurtT: 99 });
  player.pos.set(x, groundAt(x, z, 50), z); player.vel.set(0, 0, 0); player.facing = facing; cam.yaw = facing + Math.PI;
}
const anim = { phase: 0, la: 0, ra: 0, ll: 0, rl: 0, tilt: 0, bob: 0, lie: 0 };

function buildCharacter(c) {
  const root = new THREE.Group(), body = new THREE.Group(); body.position.y = 0.95; root.add(body);
  const mats = {};
  const mk = (w, h, d, col, parent, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[col] ??= new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 }));
    m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
  };
  mk(0.5, 0.62, 0.28, c.shirt, body, 0, 0.33, 0);
  mk(0.52, 0.12, 0.3, c.belt, body, 0, 0.02, 0);
  mk(0.27, 0.29, 0.27, c.skin, body, 0, 0.82, 0);
  mk(0.29, 0.09, 0.29, c.hair, body, 0, 0.98, 0); mk(0.29, 0.2, 0.06, c.hair, body, 0, 0.88, -0.12);
  for (const ex of [-0.065, 0.065]) mk(0.05, 0.04, 0.02, 0x1a1a1a, body, ex, 0.85, 0.137);
  const limb = (x, y, w, h, col, endCol, endZ = 0) => { const g = new THREE.Group(); g.position.set(x, y, 0); body.add(g);
    mk(w, h, w + 0.02, col, g, 0, -h / 2, 0); mk(w * (endZ ? 1.05 : 0.85), 0.1, endZ ? 0.3 : w * 0.85, endCol, g, 0, -h - 0.04, endZ); return g; };
  const armL = limb(0.33, 0.6, 0.14, 0.6, c.shirt, c.skin), armR = limb(-0.33, 0.6, 0.14, 0.6, c.shirt, c.skin);
  const legL = limb(0.13, 0, 0.19, 0.86, c.pants, c.shoes, 0.04), legR = limb(-0.13, 0, 0.19, 0.86, c.pants, c.shoes, 0.04);
  scene.add(root);
  return { root, body, armL, armR, legL, legR, mats, roles: c };
}
export const charModel = buildCharacter({ shirt: 0x2f7f86, belt: 0x2a2a2a, pants: 0x2d3142, skin: 0xc68b59, hair: 0x2b1d14, shoes: 0xeeeeee });
// outfits are colour swaps of the shared part materials
export function setOutfit(o) {
  for (const role of ['shirt', 'pants', 'shoes', 'hair']) if (o[role] !== undefined) charModel.mats[charModel.roles[role]].color.setHex(o[role]);
}

/* =====================================================================
   PLAYER: collision, ledges, climbing
   ===================================================================== */
function resolveCollisions(p, vel) {
  let hit = false;
  const list = queryColliders(p.x - PR - 0.5, p.z - PR - 0.5, p.x + PR + 0.5, p.z + PR + 0.5);
  for (let it = 0; it < 2; it++) for (const c of list) {
    if (c.maxY <= p.y + STEP || c.minY >= p.y + PH) continue;
    const cx = clamp(p.x, c.minX, c.maxX), cz = clamp(p.z, c.minZ, c.maxZ);
    let dx = p.x - cx, dz = p.z - cz; const d2 = dx * dx + dz * dz;
    if (d2 >= PR * PR) continue;
    let nx, nz;
    if (d2 > 1e-9) { const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; p.x += nx * (PR - d); p.z += nz * (PR - d); }
    else {
      const pen = [p.x - c.minX, c.maxX - p.x, p.z - c.minZ, c.maxZ - p.z], mi = pen.indexOf(Math.min(...pen));
      [nx, nz] = [[-1, 0], [1, 0], [0, -1], [0, 1]][mi];
      if (mi === 0) p.x = c.minX - PR; else if (mi === 1) p.x = c.maxX + PR; else if (mi === 2) p.z = c.minZ - PR; else p.z = c.maxZ + PR;
    }
    const vn = vel.x * nx + vel.z * nz; if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
    hit = true;
  }
  return hit;
}
// Look for a ledge in front of the player that can be vaulted or climbed.
export function findLedge(maxRel) {
  const p = player.pos, fx = Math.sin(player.facing), fz = Math.cos(player.facing);
  for (const reach of [PR + 0.08, PR + 0.25, PR + 0.45]) {
    const px = p.x + fx * reach, pz = p.z + fz * reach;
    const list = queryColliders(px - 0.05, pz - 0.05, px + 0.05, pz + 0.05).filter(c => px >= c.minX && px <= c.maxX && pz >= c.minZ && pz <= c.maxZ);
    let best = null;
    for (const c of list) { const rel = c.maxY - p.y; if (rel > STEP - 0.05 && rel <= maxRel && c.minY < p.y + PH && (!best || c.maxY > best.maxY)) best = c; }
    if (!best) continue;
    const top = best.maxY;
    if (list.some(c => c !== best && c.minY < top + 1.7 && c.maxY > top + 0.05)) return null;   // no headroom
    const thick = Math.abs(fx) > Math.abs(fz) ? best.maxX - best.minX : best.maxZ - best.minZ;
    const rel = top - p.y;
    if (rel <= 1.35 && thick < 1.3) {   // vault over
      let tExit = Infinity;
      if (Math.abs(fx) > 1e-4) tExit = Math.min(tExit, ((fx > 0 ? best.maxX : best.minX) - px) / fx);
      if (Math.abs(fz) > 1e-4) tExit = Math.min(tExit, ((fz > 0 ? best.maxZ : best.minZ) - pz) / fz);
      const lx = px + fx * (tExit + PR + 0.25), lz = pz + fz * (tExit + PR + 0.25);
      const blocked = queryColliders(lx - PR, lz - PR, lx + PR, lz + PR).some(c => c.maxY > top + 0.3 && c.minY < top + 1.5 &&
        lx + PR > c.minX && lx - PR < c.maxX && lz + PR > c.minZ && lz - PR < c.maxZ);
      if (!blocked) return { top, vault: true, x: lx, z: lz, y: groundAt(lx, lz, top), rel };
    }
    return { top, vault: false, x: clamp(px + fx * 0.3, best.minX + 0.05, best.maxX - 0.05), z: clamp(pz + fz * 0.3, best.minZ + 0.05, best.maxZ - 0.05), y: top, rel };
  }
  return null;
}
function startClimb(l) {
  player.climb = { ...l, t: 0, dur: l.vault ? 0.42 : (l.rel > 1.6 ? 0.95 : 0.6), fx: player.pos.x, fy: player.pos.y, fz: player.pos.z };
  player.vel.set(0, 0, 0); player.swimming = false;
}
function updateClimb(dt) {
  const c = player.climb, p = player.pos; c.t += dt; const u = Math.min(1, c.t / c.dur);
  if (c.vault) {
    p.x = lerp(c.fx, c.x, u); p.z = lerp(c.fz, c.z, u);
    p.y = lerp(c.fy, c.y, u) + Math.max(0, c.top + 0.15 - lerp(c.fy, c.y, u)) * Math.sin(Math.PI * Math.min(1, u * 1.15));
  } else if (u < 0.6) { const k = smooth(0, 1, u / 0.6); p.y = lerp(c.fy, c.top + 0.05, k); }
  else { const k = smooth(0, 1, (u - 0.6) / 0.4); p.x = lerp(c.fx, c.x, k); p.z = lerp(c.fz, c.z, k); p.y = c.top; }
  if (u >= 1) { p.set(c.x, c.y, c.z); player.climb = null; player.onGround = true; }
}

/* =====================================================================
   PLAYER: on-foot update
   ===================================================================== */
export function updatePlayer(dt) {
  if (player.vehicle) { player.pos.copy(player.vehicle.pos); player.facing = player.vehicle.heading; player.vel.set(0, 0, 0); return; }
  player.hurtT += dt;
  if (!player.dead && player.hurtT > 6 && player.health < 50) player.health = Math.min(50, player.health + 3 * dt);   // slow regen to half
  if (player.climb) { updateClimb(dt); return; }
  const p = player.pos, v = player.vel;
  const ctl = !player.dead && player.knock <= 0;   // knocked over or dead: no control, just physics
  if (player.knock > 0) player.knock -= dt;
  const fX = -Math.sin(cam.yaw), fZ = -Math.cos(cam.yaw), rX = Math.cos(cam.yaw), rZ = -Math.sin(cam.yaw);
  let dx = (fX * input.y + rX * input.x) * (ctl ? 1 : 0), dz = (fZ * input.y + rZ * input.x) * (ctl ? 1 : 0);
  const mag = Math.min(1, Math.hypot(dx, dz)); if (mag > 0.01) { const l = Math.hypot(dx, dz); dx /= l; dz /= l; }
  const swim = player.swimming;
  const aiming = player.aiming && ctl;
  const maxSp = swim ? (input.sprint ? 3.6 : 2.3) : aiming ? 3.0 : (input.sprint ? 8.6 : 5.0);
  const acc = swim ? 3 : !ctl ? (player.onGround ? 4 : 0.3) : player.onGround ? 14 : 2.5, k = 1 - Math.exp(-acc * dt);
  v.x += (dx * maxSp * mag - v.x) * k; v.z += (dz * maxSp * mag - v.z) * k;
  if (aiming) player.facing = lerpAngle(player.facing, cam.yaw + Math.PI, 1 - Math.exp(-20 * dt));   // strafe, facing the crosshair
  else if (mag > 0.1) player.facing = lerpAngle(player.facing, Math.atan2(dx, dz), 1 - Math.exp(-(swim ? 5 : 12) * dt));

  if (input.jump && ctl) {
    const l = findLedge(swim ? 2.4 : 2.9);
    if (l && (player.onGround || swim)) { startClimb(l); return; }
    if (player.onGround) { v.y = 7.6; player.onGround = false; }
  }
  if (!swim) v.y = Math.max(v.y - 24 * dt, -40);

  const prevY = p.y;
  p.x += v.x * dt; p.z += v.z * dt;
  p.x = clamp(p.x, -CFG.worldLimit, CFG.worldLimit); p.z = clamp(p.z, -CFG.worldLimit, CFG.worldLimit);
  player.hitWall = resolveCollisions(p, v);
  const hit = pushFromVehicles(p, v, PR, PH, null);
  if (hit && !player.dead && player.knock <= 0) {   // run over: thrown into the air
    damagePlayer(hit.speed * 2.2, hit.v.driver?.isAI ? 'traffic' : 'vehicle');
    v.set(hit.v.vel.x * 0.8, 4 + hit.speed * 0.12, hit.v.vel.z * 0.8); player.onGround = false; player.knock = player.dead ? 99 : 1.4;
  }
  const fallV = v.y;
  p.y += v.y * dt;

  const g = groundAt(p.x, p.z, Math.max(prevY, p.y));
  const swimY = CFG.waterY - 1.3;
  if (g < swimY - 0.05 && p.y <= swimY + 0.02) {
    if (!player.swimming && v.y < -6) emit('splash', p.x, CFG.waterY, p.z, Math.min(1, -v.y / 15));
    player.swimming = true; player.onGround = false; v.y = 0; p.y = swimY;
  } else {
    player.swimming = false;
    if (player.onGround && v.y <= 0 && g >= prevY - 0.6) { p.y = g; v.y = 0; }
    else if (p.y <= g) {
      p.y = g; if (v.y < 0) v.y = 0; player.onGround = true;
      if (fallV < -13) { damagePlayer((-fallV - 13) * 7, 'fall'); player.knock = Math.max(player.knock, 0.8); }   // hard landing
    }
    else player.onGround = false;
  }
  // ledge grab while airborne
  if (ctl && !player.onGround && !player.swimming && player.hitWall && Math.hypot(input.x, input.y) > 0.3 && v.y < 4) {
    const l = findLedge(2.1); if (l) startClimb(l);
  }
}

/* =====================================================================
   PLAYER: vehicles — enter / exit / ejection
   ===================================================================== */
export function nearestEnterable() {
  if (player.vehicle || player.climb || player.dead || player.knock > 0) return null;
  const p = player.pos; let best = null, bd = 2.6;
  for (const v of vehicles) {
    if (v.removed || v.dead || (v.driver && !v.driver.isAI)) continue;
    if (v.T.kind !== 'boat' && Math.abs(v.pos.y - p.y) > 2.2) continue;
    if (v.T.kind === 'boat' && !player.swimming && Math.abs(v.pos.y - p.y) > 2.5) continue;
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    let d = Infinity;   // distance to the nearest of the vehicle's collision circles, minus its radius
    for (const o of v.offs) d = Math.min(d, Math.hypot(p.x - (v.pos.x + fx * o), p.z - (v.pos.z + fz * o)) - v.cr);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
export function enterVehicle(v) {
  if (v.driver?.isAI) emit('carjack', v);   // pull the driver out
  player.vehicle = v; v.driver = player; v.wake(); player.climb = null; player.swimming = false; player.onGround = false;
  player.pos.copy(v.pos); cam.lookTimer = 0;
  sfx.door(); emit('enterVehicle', v);
}
export function exitVehicle(launch = null) {
  const v = player.vehicle; if (!v) return;
  const T = v.T, h = v.heading, fx = Math.sin(h), fz = Math.cos(h), sx = Math.cos(h), sz = -Math.sin(h);
  let spot = null;
  for (const [lx, lz] of [[T.wid / 2 + 0.6, T.kind === 'car' ? 0.5 : 0], [-(T.wid / 2 + 0.6), 0.5], [0, -(T.len / 2 + 0.8)], [0, T.len / 2 + 0.8]]) {
    const x = v.pos.x + sx * lx + fx * lz, z = v.pos.z + sz * lx + fz * lz;
    const y = groundAt(x, z, v.pos.y + 0.6);
    if (Math.abs(y - v.pos.y) > 1.5 && T.kind !== 'boat') continue;
    const blocked = queryColliders(x - PR, z - PR, x + PR, z + PR).some(c => c.maxY > y + STEP && c.minY < y + PH &&
      x + PR > c.minX && x - PR < c.maxX && z + PR > c.minZ && z - PR < c.maxZ);
    if (!blocked) { spot = { x, y: T.kind === 'boat' ? Math.max(y, CFG.waterY - 1.3) : y, z }; break; }
  }
  if (!spot) spot = { x: v.pos.x, y: v.pos.y + T.hgt + 0.05, z: v.pos.z };   // nowhere to step out: climb onto the roof
  player.pos.set(spot.x, spot.y, spot.z); player.facing = h; player.vel.set(0, 0, 0); player.onGround = !launch;
  if (launch) player.vel.copy(launch);
  else if (v.speed > 7) { player.vel.set(v.vel.x * 0.55, 3, v.vel.z * 0.55); player.onGround = false; }   // bail out of a moving vehicle
  player.vehicle = null; v.driver = null; player.lastVehicle = v;
  cam.yaw = h + Math.PI; cam.pitch = 0.22;
  sfx.door(); emit('exitVehicle', v);
}
export function tryEnterExit() {
  if (player.vehicle) { exitVehicle(); return; }
  const v = nearestEnterable(); if (v) enterVehicle(v);
}
on('explosion', (pos, r, src) => {
  if (player.vehicle === src) { const a = Math.random() * Math.PI * 2; exitVehicle(new V3(Math.cos(a) * 6, 9, Math.sin(a) * 6)); player.knock = 1.5; damagePlayer(45, 'explosion'); return; }
  if (player.vehicle) { if (player.vehicle.pos.distanceTo(pos) < r) player.vehicle.damage((r - player.vehicle.pos.distanceTo(pos)) * 60); return; }
  const dx = player.pos.x - pos.x, dz = player.pos.z - pos.z, d = Math.hypot(dx, dz);
  if (d < r) { const f = (r - d) * 1.6; player.vel.x += dx / (d || 1) * f; player.vel.z += dz / (d || 1) * f; player.vel.y = Math.max(player.vel.y, (r - d) * 0.9); player.onGround = false; player.climb = null;
    player.knock = 1.2; damagePlayer((r - d) * 9, 'explosion'); }
});
on('vehicleImpact', (v, speed) => {   // riders get thrown off bikes in hard crashes
  if (player.vehicle === v && v.T.kind === 'bike' && speed > 11) exitVehicle(new V3(v.vel.x * 0.6 + Math.sin(v.heading) * 4, 5, v.vel.z * 0.6 + Math.cos(v.heading) * 4));
});
on('vehicleSunk', v => { if (player.vehicle === v) { exitVehicle(); emit('toast', 'Your vehicle sank — swim for it!'); } });
on('vehicleFire', v => { if (player.vehicle === v) emit('toast', 'Vehicle on fire — get out!', 3); });

/* =====================================================================
   PLAYER: animation (on foot, swimming, climbing, riding)
   ===================================================================== */
const SEATS = { moto: [0, 0.06, -0.3], boat: [0, 0.55, -0.25] };
const _seat = new V3();
export function animateCharacter(dt) {
  const ch = charModel, v = player.vehicle;
  if (v) {
    ch.root.visible = !!v.T.rider;
    if (!ch.root.visible) return;
    v.body.updateWorldMatrix(true, false);
    ch.root.position.copy(v.body.localToWorld(_seat.set(...SEATS[v.type])));
    v.body.getWorldQuaternion(ch.root.quaternion);
    const bike = v.type === 'moto';
    ch.legL.rotation.x = ch.legR.rotation.x = bike ? -1.35 : 0; ch.armL.rotation.x = ch.armR.rotation.x = bike ? -1.15 : -0.9;
    ch.body.rotation.x = bike ? 0.3 : 0.05; ch.body.position.y = 0.95;
    return;
  }
  ch.root.visible = true; ch.root.quaternion.identity();
  const sp = Math.hypot(player.vel.x, player.vel.z);
  let la = 0, ra = 0, ll = 0, rl = 0, tilt = 0, bob = 0, by = 0.95;
  const down = player.dead || player.knock > 0;
  if (down) { la = -2.8; ra = -2.6; ll = 0.15; rl = -0.1; }
  else if (player.climb) {
    const u = player.climb.t / player.climb.dur;
    la = ra = player.climb.vault ? -1.4 : lerp(-2.9, -0.6, u); ll = player.climb.vault ? -1.1 : -0.7 * Math.sin(u * 6); rl = player.climb.vault ? -0.6 : -ll;
    tilt = player.climb.vault ? 0.35 : 0.15;
  } else if (player.swimming) {
    anim.phase += dt * (3 + sp); la = Math.sin(anim.phase) * 1.6 - 1.6; ra = Math.sin(anim.phase + Math.PI) * 1.6 - 1.6;
    ll = Math.sin(anim.phase * 2) * 0.35; rl = -ll; tilt = 1.25; by = 1.15;
  } else if (!player.onGround) {
    la = ra = -0.7; ll = -0.55; rl = 0.35; tilt = 0.05;
  } else {
    anim.phase += dt * sp * 1.85;
    const amp = Math.min(1, sp / 5) * (sp > 6.5 ? 1.05 : 0.75);
    ll = Math.sin(anim.phase) * amp; rl = -ll; la = -ll * 0.9; ra = ll * 0.9;
    bob = Math.abs(Math.cos(anim.phase)) * 0.06 * Math.min(1, sp / 3); tilt = sp > 6.5 ? 0.18 : sp * 0.015;
    if (sp < 0.3) { const br = Math.sin(performance.now() * 0.002) * 0.03; la = br; ra = -br; }
  }
  if (!down && !player.swimming && !player.climb) {
    if (player.aiming && S.weapon !== 'fist') {   // arms up along the aim line; long guns use both hands
      const up = -1.55 + cam.pitch * 0.6; ra = up; if (S.weapon !== 'pistol') la = up + 0.15; tilt = 0.02;
    }
    if (player.punchT > 0) { ra = -1.6 * Math.sin(Math.min(1, (0.3 - player.punchT) / 0.15) * Math.PI / 2); player.punchT -= dt; }
  }
  const k = 1 - Math.exp(-16 * dt);
  for (const [key, val] of [['la', la], ['ra', ra], ['ll', ll], ['rl', rl], ['tilt', tilt], ['bob', bob]]) anim[key] += (val - anim[key]) * k;
  ch.armL.rotation.x = anim.la; ch.armR.rotation.x = anim.ra; ch.legL.rotation.x = anim.ll; ch.legR.rotation.x = anim.rl;
  ch.armL.rotation.z = player.swimming ? 0 : 0.06; ch.armR.rotation.z = -ch.armL.rotation.z;
  ch.body.rotation.x = anim.tilt; ch.body.position.y = lerp(ch.body.position.y, by, k);
  anim.lie += ((down ? 1 : 0) - anim.lie) * (1 - Math.exp(-8 * dt));
  ch.armL.rotation.z = player.aiming && S.weapon !== 'pistol' && S.weapon !== 'fist' && !down ? -0.35 : ch.armL.rotation.z;
  ch.root.position.set(player.pos.x, player.pos.y + anim.bob + anim.lie * 0.15, player.pos.z);
  ch.root.rotation.set(-anim.lie * Math.PI / 2, player.facing, 0, 'YXZ');
}
