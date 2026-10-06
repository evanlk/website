// peds.js — pedestrians: sidewalk wandering, crossings, fleeing, reactions, knock-downs; instanced rendering
import * as THREE from 'three';
import { V3, Q, clamp, lerp, lerpAngle, rand, rr, pick, scene, camera, queryColliders, on, emit } from './core.js';
import { baseGround } from './world.js';
import { pnodes, walkAllowed } from './nav.js';
import { vehicles } from './vehicles.js';
import { emitP, fire as fireFx } from './particles.js';
import { player } from './player.js';

/* =====================================================================
   PEDS: instanced body parts (7 draw calls for every pedestrian)
   ===================================================================== */
const MAXP = 56;
const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
const part = (geo, n) => { const m = new THREE.InstancedMesh(geo, mat, n); m.castShadow = true; m.frustumCulled = false;
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); scene.add(m); return m; };
const IM = {
  torso: part(new THREE.BoxGeometry(0.48, 0.6, 0.27).translate(0, 0.33, 0), MAXP),
  head: part(new THREE.BoxGeometry(0.26, 0.28, 0.26).translate(0, 0.81, 0), MAXP),
  hair: part(new THREE.BoxGeometry(0.28, 0.12, 0.28).translate(0, 0.97, -0.01), MAXP),
  arm: part(new THREE.BoxGeometry(0.13, 0.62, 0.14).translate(0, -0.31, 0), MAXP * 2),
  leg: part(new THREE.BoxGeometry(0.18, 0.9, 0.2).translate(0, -0.45, 0), MAXP * 2),
};
const SHIRTS = [0xc0392b, 0x2e86c1, 0xf1c40f, 0x27ae60, 0x8e44ad, 0xe67e22, 0xecf0f1, 0x34495e, 0xd35400, 0x16a085, 0xe84393, 0x7f8c8d];
const PANTS = [0x2c3e50, 0x1b2631, 0x5d4037, 0x7f8c8d, 0x1f3a93, 0xbdc3c7, 0x212121];
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0x5c3a21];
const HAIR = [0x1b1b1b, 0x3e2723, 0x6d4c41, 0xd4a017, 0x9e9e9e, 0xb5651d];

/* =====================================================================
   PEDS: behaviour
   ===================================================================== */
export const peds = [];
const PRAD = 0.32;
class Ped {
  constructor(node, link, t) {
    this.pos = new V3(); this.vel = new V3(); this.facing = 0; this.state = 'walk'; this.timer = 0;
    this.node = node; this.link = link; this.pi = 0; this.target = null; this.walkSpeed = rr(1.1, 1.6); this.phase = rand() * 6;
    this.scale = rr(0.9, 1.07); this.threat = new V3(); this.grounded = true; this.limb = 0; this.lie = 0;
    this.colors = { shirt: pick(SHIRTS), pants: pick(PANTS), skin: pick(SKIN), hair: pick(HAIR) };
    this.hp = 50; this.cop = false; this.ko = false; this.koT = 0; this.goal = new V3(); this.fireT = rr(0.5, 1.5);
    const to = link.to; this.pos.set(node.x + (to.x - node.x) * t, 0, node.z + (to.z - node.z) * t); this.pos.y = baseGround(this.pos.x, this.pos.z);
    this.setLink(link);
  }
  setLink(link) { this.link = link; this.pi = 0; }
  chooseNext() {
    const at = this.link.to, opts = at.links.filter(l => l.to !== this.node);
    this.node = at; return pick(opts.length ? opts : at.links);
  }
  flee(from, secs = rr(5, 9)) {
    if (this.keep || this.cop || this.hostile || this.ko || this.state === 'down' || this.state === 'getup') return;
    this.threat.copy(from); this.state = 'flee'; this.timer = secs;
  }
  // take damage from a punch, bullet or vehicle: knocked out at 0 hp (cartoon stars, no gore)
  damage(amount, by, dir) {
    if (this.ko) return;
    this.hp -= amount;
    if (dir) { this.vel.x += dir.x * 2; this.vel.z += dir.z * 2; }
    if (this.hp <= 0) { this.ko = true; if (this.state !== 'down') this.knockDown(dir ? dir.x * 3 : 0, dir ? dir.z * 3 : 0, 2.5); emit('pedKO', this, by); return; }
    emit('pedDamaged', this, by);
    if (!this.cop && by === 'player') this.flee(player.pos, rr(8, 12));
  }
  knockDown(vx, vz, up) {
    this.state = 'down'; this.timer = rr(2.5, 3.5); this.vel.set(vx, up, vz); this.grounded = false; this.threat.copy(player.pos);
  }
  update(dt) {
    const p = this.pos;
    let speed = 0, dirX = 0, dirZ = 0;
    if (this.state === 'walk' || this.state === 'wait') {
      const tgt = this.link.pts[this.pi], dx = tgt[0] - p.x, dz = tgt[1] - p.z, d = Math.hypot(dx, dz);
      if (d < 0.35) {
        if (this.pi < this.link.pts.length - 1) this.pi++;
        else { this.setLink(this.chooseNext()); }
      } else {
        // wait at the kerb for the walk signal before stepping onto a crossing
        if (this.link.axis && this.pi === 0 && !walkAllowed(this.link.node, this.link.axis) && d < 3.5) { this.state = 'wait'; this.facing = lerpAngle(this.facing, Math.atan2(dx, dz), 0.1); }
        else { this.state = 'walk'; speed = this.walkSpeed; dirX = dx / d; dirZ = dz / d; }
      }
    } else if (this.state === 'flee' || this.state === 'return') {
      if (this.state === 'flee') {
        let dx = p.x - this.threat.x, dz = p.z - this.threat.z; const d = Math.hypot(dx, dz) || 1;
        dirX = dx / d + Math.sin(this.phase * 3.1) * 0.25; dirZ = dz / d + Math.cos(this.phase * 2.7) * 0.25;
        const l = Math.hypot(dirX, dirZ); dirX /= l; dirZ /= l; speed = 4.6;
        if ((this.timer -= dt) <= 0) {   // calm down and walk back to the nearest sidewalk corner
          let best = pnodes[0], bd = Infinity; for (const n of pnodes) { const dd = (n.x - p.x) ** 2 + (n.z - p.z) ** 2; if (dd < bd) { bd = dd; best = n; } }
          this.state = 'return'; this.target = best;
        }
      } else {
        const dx = this.target.x - p.x, dz = this.target.z - p.z, d = Math.hypot(dx, dz);
        if (d < 0.5) { this.node = this.target; this.state = 'walk'; this.setLink(pick(this.target.links)); this.node = this.target; }
        else { dirX = dx / d; dirZ = dz / d; speed = 1.8; }
      }
    } else if (this.state === 'chase') {   // police on foot running toward a goal
      const dx = this.goal.x - p.x, dz = this.goal.z - p.z, d = Math.hypot(dx, dz);
      if (d > 0.9) { dirX = dx / d; dirZ = dz / d; speed = d > 6 ? 5.4 : 3; }
    } else if (this.state === 'aim') {
      this.facing = lerpAngle(this.facing, Math.atan2(this.goal.x - p.x, this.goal.z - p.z), 1 - Math.exp(-10 * dt));
    } else if (this.state === 'idle') {   // story characters: stand still, turn to face the player when close
      if (p.distanceTo(player.pos) < 8) this.facing = lerpAngle(this.facing, Math.atan2(player.pos.x - p.x, player.pos.z - p.z), 1 - Math.exp(-4 * dt));
    } else if (this.state === 'react') {
      this.facing = lerpAngle(this.facing, Math.atan2(player.pos.x - p.x, player.pos.z - p.z), 1 - Math.exp(-8 * dt));
      if ((this.timer -= dt) <= 0) this.state = 'walk';
    } else if (this.state === 'down') {
      if (!this.grounded) { this.vel.y -= 22 * dt; }
      this.vel.x *= Math.exp(-(this.grounded ? 6 : 0.5) * dt); this.vel.z *= Math.exp(-(this.grounded ? 6 : 0.5) * dt);
      p.x += this.vel.x * dt; p.z += this.vel.z * dt; p.y += this.vel.y * dt;
      const g = baseGround(p.x, p.z); if (p.y <= g) { p.y = g; this.vel.y = 0; this.grounded = true; }
      this.lie = Math.min(1, this.lie + dt * 4);
      this.collide();
      if (this.ko) { this.koT += dt; if (this.koT % 0.5 < dt) emitP(fireFx, p.x, p.y + 0.5, p.z, (rand() - .5), 1.2, (rand() - .5), 0.6, 0.18, 0.1, [1, 0.9, 0.3, 1], [1, 0.8, 0.2, 0], 0.5, 0); }
      else if (this.grounded && (this.timer -= dt) <= 0) { this.state = 'getup'; this.timer = 0.7; }
      return;
    } else if (this.state === 'getup') {
      this.lie = Math.max(0, this.lie - dt * 1.6);
      if ((this.timer -= dt) <= 0) { this.lie = 0; this.state = 'flee'; this.timer = rr(5, 8); }
      return;
    }
    if (speed > 0) {
      const k = 1 - Math.exp(-8 * dt);
      this.vel.x += (dirX * speed - this.vel.x) * k; this.vel.z += (dirZ * speed - this.vel.z) * k;
      this.facing = lerpAngle(this.facing, Math.atan2(this.vel.x, this.vel.z), 1 - Math.exp(-10 * dt));
    } else { this.vel.x *= Math.exp(-10 * dt); this.vel.z *= Math.exp(-10 * dt); }
    p.x += this.vel.x * dt; p.z += this.vel.z * dt;
    if (this.state !== 'walk' && this.state !== 'wait') this.collide();
    if (this.state === 'chase' && speed === 0) this.facing = lerpAngle(this.facing, Math.atan2(this.goal.x - p.x, this.goal.z - p.z), 1 - Math.exp(-8 * dt));
    p.y = lerp(p.y, baseGround(p.x, p.z), 1 - Math.exp(-20 * dt));
    this.limb = Math.hypot(this.vel.x, this.vel.z);
    this.phase += dt * this.limb * 2.1;
  }
  collide() {   // static world collision (only needed off the sidewalk graph)
    const p = this.pos;
    for (const c of queryColliders(p.x - 0.6, p.z - 0.6, p.x + 0.6, p.z + 0.6)) {
      if (c.maxY <= p.y + 0.5 || c.minY >= p.y + 1.7) continue;
      const cx = clamp(p.x, c.minX, c.maxX), cz = clamp(p.z, c.minZ, c.maxZ), dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
      if (d < PRAD && d > 1e-6) { p.x += dx / d * (PRAD - d); p.z += dz / d * (PRAD - d); }
      else if (d <= 1e-6) { this.threat.set(cx * 2 - p.x, 0, cz * 2 - p.z); }
    }
  }
}

/* =====================================================================
   PEDS: interactions with vehicles and the player
   ===================================================================== */
function interact(pd, dt) {
  const p = pd.pos;
  for (const v of vehicles) {
    if (v.removed) continue;
    const dx = p.x - v.pos.x, dz = p.z - v.pos.z;
    if (Math.abs(dx) > v.T.len + 6 || Math.abs(dz) > v.T.len + 6) continue;
    const sp = v.speed, fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    // dive out of the way of fast vehicles heading at them
    if (sp > 7 && pd.state !== 'down' && pd.state !== 'flee') {
      const f = dx * fx + dz * fz, l = dx * fz - dz * fx;
      if (f > 0 && f < 6 + sp * 0.5 && Math.abs(l) < 2.6) {   // flee sideways, away from the vehicle's line of travel
        pd.flee(new V3(v.pos.x + fx * f - fz * Math.sign(l || 1) * 0.5, 0, v.pos.z + fz * f + fx * Math.sign(l || 1) * 0.5), rr(1.5, 3)); continue;
      }
    }
    if (Math.abs(p.y - v.pos.y) > 2) continue;
    for (const o of v.offs) {
      const cx = v.pos.x + fx * o, cz = v.pos.z + fz * o, ex = p.x - cx, ez = p.z - cz, d = Math.hypot(ex, ez), rs = v.cr + PRAD;
      if (d >= rs || d < 1e-5) continue;
      if (sp > 4 && pd.state !== 'down') {   // hit: cartoon knock-down, no gore
        pd.knockDown(v.vel.x * 0.75 + ex / d * 2, v.vel.z * 0.75 + ez / d * 2, 3 + sp * 0.15);
        v.vel.multiplyScalar(0.96); emit('pedHit', pd, v);
        pd.damage(sp * 3.5, v.driver?.isPlayer ? 'player' : null);
      } else { p.x += ex / d * (rs - d); p.z += ez / d * (rs - d); }
      break;
    }
  }
  if (!player.vehicle) {   // the player bumps into people
    const dx = p.x - player.pos.x, dz = p.z - player.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.65 && d > 1e-5 && Math.abs(p.y - player.pos.y) < 1.5) {
      p.x += dx / d * (0.65 - d); p.z += dz / d * (0.65 - d);
      const ps = Math.hypot(player.vel.x, player.vel.z);
      if (ps > 7 && pd.state !== 'down' && !pd.cop) pd.knockDown(player.vel.x * 0.5, player.vel.z * 0.5, 2.5);
      else if (pd.state === 'walk' || pd.state === 'wait') { pd.state = 'react'; pd.timer = 1.4; }
    }
  }
}
on('explosion', pos => { for (const pd of peds) { const d = pd.pos.distanceTo(pos); if (d < 8 && pd.state !== 'down') pd.knockDown((pd.pos.x - pos.x) / (d || 1) * (9 - d), (pd.pos.z - pos.z) / (d || 1) * (9 - d), 5); else if (d < 50) pd.flee(pos); } });
on('vehicleImpact', (v, speed) => { if (speed < 8) return; for (const pd of peds) if (pd.pos.distanceTo(v.pos) < 25) pd.flee(v.pos, rr(3, 6)); });
on('gunshot', pos => { for (const pd of peds) if (!pd.cop && pd.pos.distanceTo(pos) < 40) pd.flee(pos, rr(6, 10)); });
on('honk', pos => { for (const pd of peds) if ((pd.state === 'walk' || pd.state === 'wait') && pd.pos.distanceTo(pos) < 14) pd.flee(pos, rr(1, 2)); });

/* =====================================================================
   PEDS: spawning + per-frame update + rendering
   ===================================================================== */
const frustum = new THREE.Frustum(), _pm = new THREE.Matrix4();
export function inView(x, y, z, r = 2) {
  _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(_pm);
  return frustum.intersectsSphere(new THREE.Sphere(new V3(x, y, z), r));
}
const COP_COLORS = { shirt: 0x22345a, pants: 0x151b2b, skin: 0, hair: 0x0e1424 };
export function spawnCop(x, z) {
  const pd = spawnPedAt(x, z); pd.cop = true; pd.hp = 70; pd.state = 'chase'; pd.goal.copy(player.pos);
  pd.colors = { ...COP_COLORS, skin: pick(SKIN) }; pd.scale = rr(1.0, 1.08); return pd;
}
function evict() {   // make room: drop the farthest civilian (or knocked-out body)
  let bi = -1, bd = -1; peds.forEach((p, i) => { const d = p.pos.distanceTo(player.pos) + (p.ko ? 500 : 0); if (!p.cop && !p.keep && d > bd) { bd = d; bi = i; } });
  peds.splice(bi >= 0 ? bi : 0, 1);
}
export function spawnPedAt(x, z, fleeFrom) {
  if (peds.length >= MAXP) evict();
  let best = pnodes[0], bd = Infinity; for (const n of pnodes) { const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bd) { bd = d; best = n; } }
  const pd = new Ped(best, best.links[0], 0); pd.pos.set(x, baseGround(x, z), z);
  if (fleeFrom) pd.flee(fleeFrom, rr(6, 10)); peds.push(pd); return pd;
}
let spawnT = 0;
export function updatePeds(dt, focus) {
  if ((spawnT -= dt) <= 0) {
    spawnT = 0.4;
    for (let i = peds.length - 1; i >= 0; i--) { const pd = peds[i]; if (!pd.keep && (pd.pos.distanceTo(focus) > 140 || pd.koT > 30) && !inView(pd.pos.x, 1, pd.pos.z)) peds.splice(i, 1); }
    const near = pnodes.filter(n => { const d = Math.hypot(n.x - focus.x, n.z - focus.z); return d > 18 && d < 110; });
    for (let tries = 0; tries < 12 && near.length && peds.length < Math.min(MAXP, Q.peds ?? MAXP) - 4; tries++) {
      const n = pick(near), d = Math.hypot(n.x - focus.x, n.z - focus.z);
      const link = pick(n.links.filter(l => !l.axis)), t = rand();
      const x = n.x + (link.to.x - n.x) * t, z = n.z + (link.to.z - n.z) * t;
      if (d < 70 && inView(x, 1, z)) continue;
      peds.push(new Ped(n, link, t));
    }
  }
  for (const pd of peds) { pd.update(dt); interact(pd, dt); }
  render();
}
const _m = new THREE.Matrix4(), _h = new THREE.Matrix4(), _l = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _v = new V3(), _s = new V3(), _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
function render() {
  const cp = camera.position;
  for (let i = 0; i < MAXP; i++) {
    const pd = peds[i];
    if (!pd || pd.pos.distanceToSquared(cp) > 150 * 150) {
      IM.torso.setMatrixAt(i, ZERO); IM.head.setMatrixAt(i, ZERO); IM.hair.setMatrixAt(i, ZERO);
      for (const k of [0, 1]) { IM.arm.setMatrixAt(i * 2 + k, ZERO); IM.leg.setMatrixAt(i * 2 + k, ZERO); }
      continue;
    }
    const lie = pd.lie, run = pd.limb > 3, sw = Math.sin(pd.phase) * Math.min(1, pd.limb / 1.5) * (run ? 1.0 : 0.6);
    _e.set(-lie * Math.PI / 2, pd.facing, 0, 'YXZ'); _q.setFromEuler(_e);
    _m.compose(_v.set(pd.pos.x, pd.pos.y + lie * 0.15, pd.pos.z), _q, _s.setScalar(pd.scale));
    _h.makeRotationX(run ? 0.2 : 0.03).setPosition(0, 0.95, 0).premultiply(_m);
    const set = (im, idx, x, y, ang, col, z = 0) => { _l.makeRotationX(ang).setPosition(x, y, z).premultiply(_h); im.setMatrixAt(idx, _l); im.setColorAt(idx, _c.setHex(col)); };
    const flail = pd.state === 'down' && !pd.grounded ? Math.sin(performance.now() * 0.03) * 1.5 : 0;
    const wave = pd.state === 'flee' ? -2.6 + Math.sin(pd.phase * 2) * 0.4 : pd.state === 'aim' ? -1.5 : 0;   // arms up fleeing, forward when aiming
    set(IM.torso, i, 0, 0, 0, pd.colors.shirt); set(IM.head, i, 0, 0, 0, pd.colors.skin); set(IM.hair, i, 0, 0, 0, pd.colors.hair);
    set(IM.arm, i * 2, 0.31, 0.6, (wave || -sw * 0.9) + flail, pd.colors.shirt); set(IM.arm, i * 2 + 1, -0.31, 0.6, (wave || sw * 0.9) - flail, pd.colors.shirt);
    set(IM.leg, i * 2, 0.12, 0, sw + flail * 0.5, pd.colors.pants); set(IM.leg, i * 2 + 1, -0.12, 0, -sw - flail * 0.5, pd.colors.pants);
  }
  for (const im of Object.values(IM)) { im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
}
