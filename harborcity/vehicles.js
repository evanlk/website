// vehicles.js — vehicle types, procedural meshes, arcade physics, collisions, damage, spawning
import * as THREE from 'three';
import { CFG, V3, clamp, lerp, rand, pick, scene, camera, queryColliders, cam, emit, nightU } from './core.js';
import { baseGround, groundAt, parkingSpots, blockAt, ringSD, isWater, rampHeight, ramps } from './world.js';
import { engineSmoke, fireLick, tireSmoke, sparks, splash, wake, explosionFX } from './particles.js';
import * as sfx from './audio.js';

/* =====================================================================
   VEHICLES: type data (handling is tuned here)
   ===================================================================== */
// speeds in m/s, accel/brake in m/s², steer = max wheel angle (rad), grip = lateral damping (1/s)
export const TYPES = {
  sedan:  { name: 'Sedan',      kind: 'car',  len: 4.6, wid: 1.9,  hgt: 1.5,  mass: 1400, maxSpeed: 46, maxRev: 12, accel: 9.5, brake: 22, steer: 0.62, grip: 9,   driftGrip: 1.4, wheelbase: 2.8, health: 1000, camDist: 6.5,  engine: 52, wheelR: 0.36, wheelW: 0.26, circles: 3 },
  sports: { name: 'Sports car', kind: 'car',  len: 4.4, wid: 1.95, hgt: 1.25, mass: 1250, maxSpeed: 64, maxRev: 14, accel: 12,  brake: 24, steer: 0.58, grip: 11,  driftGrip: 1.7, wheelbase: 2.7, health: 800,  camDist: 6.2,  engine: 68, wheelR: 0.34, wheelW: 0.3,  circles: 3 },
  truck:  { name: 'Box truck',  kind: 'car',  len: 7.4, wid: 2.45, hgt: 3.6,  mass: 5500, maxSpeed: 31, maxRev: 8,  accel: 5,   brake: 14, steer: 0.5,  grip: 7,   driftGrip: 1.8, wheelbase: 4.6, health: 1800, camDist: 10.5, engine: 34, wheelR: 0.5,  wheelW: 0.34, circles: 4 },
  moto:   { name: 'Motorcycle', kind: 'bike', len: 2.1, wid: 0.7,  hgt: 1.2,  mass: 220,  maxSpeed: 58, maxRev: 5,  accel: 14,  brake: 24, steer: 0.55, grip: 10,  driftGrip: 2.5, wheelbase: 1.45, health: 450, camDist: 4.8,  engine: 88, wheelR: 0.33, wheelW: 0.14, circles: 2, rider: true },
  police: { name: 'Police cruiser', kind: 'car', len: 4.7, wid: 1.92, hgt: 1.55, mass: 1600, maxSpeed: 52, maxRev: 12, accel: 11, brake: 24, steer: 0.62, grip: 9.5, driftGrip: 1.5, wheelbase: 2.85, health: 1400, camDist: 6.6, engine: 56, wheelR: 0.36, wheelW: 0.27, circles: 3 },
  boat:   { name: 'Speedboat',  kind: 'boat', len: 6.2, wid: 2.3,  hgt: 1.4,  mass: 1200, maxSpeed: 30, maxRev: 6,  accel: 7,   brake: 6,  steer: 0.9,  grip: 1.6, driftGrip: 1.0, wheelbase: 3.2, health: 1000, camDist: 8,    engine: 44, circles: 3, rider: true },
};
const PAINTS = [0xb32428, 0x1f4e9c, 0xe7e7e2, 0x222326, 0x8a8f96, 0x2d6b3c, 0xd8a419, 0x6b2d7a, 0xc75b1c, 0x1c8a8a, 0x5a3a2a, 0xf2f2f2];
const GLASS = 0x1b2530, DARK = 0x18191b, CHROME = 0xa8acb0, HEAD = 0xfff1c8, TAIL = 0xd01818, WOOD = 0x9a6b43;

/* =====================================================================
   VEHICLES: procedural meshes
   ===================================================================== */
// part: [w, h, d, x, y, z, colour, emissive?, rotX?] — boxes merged into one vertex-coloured mesh
function bodyParts(type, paint) {
  const T = TYPES[type], L = T.len, W = T.wid;
  const lights = (y, zf, zr, xo, w = 0.38) => [[w, 0.14, 0.06, xo, y, zf, HEAD, 1], [w, 0.14, 0.06, -xo, y, zf, HEAD, 1], [w, 0.14, 0.06, xo, y + 0.03, zr, TAIL, 1], [w, 0.14, 0.06, -xo, y + 0.03, zr, TAIL, 1]];
  switch (type) {
    case 'sedan': return [
      [W, 0.55, L, 0, 0.62, 0, paint], [W * 0.88, 0.5, L * 0.46, 0, 1.14, -0.2, GLASS], [W * 0.86, 0.07, L * 0.42, 0, 1.42, -0.22, paint],
      [W + 0.04, 0.14, L * 0.92, 0, 0.4, 0, DARK], [W * 1.02, 0.22, 0.2, 0, 0.46, L / 2, DARK], [W * 1.02, 0.22, 0.2, 0, 0.46, -L / 2, DARK],
      [W * 0.5, 0.16, 0.05, 0, 0.72, L / 2 + 0.01, DARK], ...lights(0.76, L / 2 + 0.01, -L / 2 - 0.01, 0.62)];
    case 'police': return [...bodyParts('sedan', 0xf2f2f2), [W * 1.01, 0.3, L * 0.5, 0, 0.62, -0.05, 0x14213d], [W * 0.7, 0.1, 0.32, 0, 1.5, -0.25, DARK]];
    case 'sports': return [
      [W, 0.42, L, 0, 0.52, 0, paint], [W * 0.8, 0.38, L * 0.36, 0, 0.9, -0.35, GLASS], [W * 0.78, 0.06, L * 0.3, 0, 1.1, -0.42, paint],
      [W * 0.96, 0.1, L * 0.5, 0, 0.77, L * 0.24, paint], [W * 0.9, 0.06, 0.4, 0, 1.02, -L / 2 + 0.25, DARK],
      [0.08, 0.26, 0.1, 0.6, 0.86, -L / 2 + 0.25, DARK], [0.08, 0.26, 0.1, -0.6, 0.86, -L / 2 + 0.25, DARK],
      [W + 0.04, 0.12, L * 0.9, 0, 0.33, 0, DARK], [W * 1.02, 0.18, 0.18, 0, 0.38, L / 2, DARK], [W * 1.02, 0.18, 0.18, 0, 0.38, -L / 2, DARK],
      ...lights(0.62, L / 2 + 0.01, -L / 2 - 0.01, 0.66, 0.42)];
    case 'truck': return [
      [W * 0.9, 0.42, L, 0, 0.78, 0, DARK], [W, 1.65, 2.2, 0, 1.75, L / 2 - 1.1, paint],
      [W * 0.92, 0.72, 0.08, 0, 2.15, L / 2 + 0.01, GLASS], [W + 0.02, 0.6, 1.0, 0, 2.18, L / 2 - 0.85, GLASS],
      [W * 1.03, 2.75, L - 2.5, 0, 2.38, -1.22, 0xe9e7e0], [W * 1.04, 0.2, L - 2.5, 0, 1.15, -1.22, paint],
      [W * 1.02, 0.28, 0.22, 0, 0.62, L / 2 + 0.02, CHROME], [W * 0.96, 0.25, 0.15, 0, 0.62, -L / 2 + 0.02, DARK],
      ...lights(1.0, L / 2 + 0.04, -L / 2 - 0.01, 0.95, 0.32)];
    case 'moto': return [
      [0.28, 0.32, 1.25, 0, 0.62, 0, DARK], [0.42, 0.26, 0.55, 0, 0.92, 0.18, paint], [0.34, 0.12, 0.7, 0, 0.92, -0.38, DARK],
      [0.36, 0.28, 0.42, 0, 0.72, -0.72, paint], [0.08, 0.72, 0.08, 0.1, 0.72, 0.72, CHROME, 0, -0.35], [0.08, 0.72, 0.08, -0.1, 0.72, 0.72, CHROME, 0, -0.35],
      [0.72, 0.05, 0.05, 0, 1.12, 0.58, DARK], [0.2, 0.16, 0.12, 0, 1.0, 0.86, HEAD, 1], [0.16, 0.08, 0.05, 0, 0.82, -0.95, TAIL, 1],
      [0.14, 0.14, 0.5, 0.18, 0.45, -0.45, CHROME]];
    case 'boat': return [
      [W, 0.85, L - 1.4, 0, 0.12, -0.7, 0xf4f4f0], [W * 0.62, 0.85, 1.5, 0, 0.12, L / 2 - 0.95, 0xf4f4f0], [W * 0.3, 0.7, 0.7, 0, 0.2, L / 2 - 0.05, 0xf4f4f0],
      [W + 0.02, 0.14, L - 1.4, 0, 0.42, -0.7, paint], [W * 0.64, 0.14, 1.5, 0, 0.42, L / 2 - 0.95, paint],
      [W * 0.88, 0.05, L - 1.7, 0, 0.56, -0.75, WOOD], [W * 0.8, 0.45, 0.06, 0, 0.95, 0.75, GLASS, 0, -0.45],
      [0.7, 0.55, 0.45, 0, 0.82, 0.35, 0xf4f4f0], [W * 0.8, 0.35, 0.6, 0, 0.75, -L / 2 + 1.2, paint],
      [0.45, 0.85, 0.45, 0, 0.45, -L / 2 + 0.25, DARK], [0.12, 0.1, 0.06, 0.4, 0.62, L / 2 - 0.6, HEAD, 1]];
  }
}
function wheelLayout(type) {
  const T = TYPES[type], hx = T.wid / 2 - T.wheelW / 2 + 0.02, wb = T.wheelbase / 2;
  if (type === 'boat') return [];
  if (type === 'moto') return [{ x: 0, z: 0.72, front: true }, { x: 0, z: -0.72, front: false }];
  if (type === 'truck') return [[hx, T.len / 2 - 1.3, true], [-hx, T.len / 2 - 1.3, true], [hx, -T.len / 2 + 1.3], [-hx, -T.len / 2 + 1.3], [hx, -T.len / 2 + 2.4], [-hx, -T.len / 2 + 2.4]].map(([x, z, f]) => ({ x, z, front: !!f }));
  return [[hx, wb, true], [-hx, wb, true], [hx, -wb], [-hx, -wb]].map(([x, z, f]) => ({ x, z, front: !!f }));
}
const _col = new THREE.Color();
function buildGeo(parts) {
  const pos = [], nor = [], col = [], emi = [];
  for (const [w, h, d, x, y, z, hex, e = 0, rx = 0] of parts) {
    let g = new THREE.BoxGeometry(w, h, d); if (rx) g.rotateX(rx); g.translate(x, y, z); g = g.toNonIndexed();
    _col.setHex(hex); const n = g.attributes.position.count;
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
    for (let i = 0; i < n; i++) { col.push(_col.r, _col.g, _col.b); emi.push(e); }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('aEmit', new THREE.Float32BufferAttribute(emi, 1));
  return out;
}
// Only parts flagged emissive (head/tail lights) glow; per-vehicle brightness comes from material.emissiveIntensity.
const VEH_OBC = sh => {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aEmit; varying float vEmit;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmit = aEmit;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vEmit;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vEmit * vColor.rgb;');
};

// all wheels of all vehicles share one instanced mesh (1 draw call)
const MAXV = 72, MAXW = MAXV * 6, MAX_PARKED = 40;
const wheelGeo = (() => {
  const tyre = new THREE.CylinderGeometry(1, 1, 1, 14).rotateZ(Math.PI / 2).toNonIndexed();
  const hub = new THREE.CylinderGeometry(0.55, 0.55, 1.04, 8).rotateZ(Math.PI / 2).toNonIndexed();
  const g = new THREE.BufferGeometry(), c = [];
  const pos = [...tyre.attributes.position.array, ...hub.attributes.position.array], nor = [...tyre.attributes.normal.array, ...hub.attributes.normal.array];
  for (let i = 0; i < tyre.attributes.position.count; i++) c.push(0.03, 0.03, 0.03);
  for (let i = 0; i < hub.attributes.position.count; i++) c.push(0.45, 0.46, 0.48);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); return g;
})();
const wheelIM = new THREE.InstancedMesh(wheelGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), MAXW);
wheelIM.castShadow = true; wheelIM.frustumCulled = false; scene.add(wheelIM);

const headlight = new THREE.SpotLight(0xfff1d6, 0, 70, 0.6, 0.55, 1.2);
scene.add(headlight, headlight.target);

/* =====================================================================
   VEHICLES: Vehicle class — arcade physics, damage, effects
   ===================================================================== */
export const vehicles = [];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _p = new V3(), _s = new V3();

export class Vehicle {
  constructor(type, x, z, heading, paint = pick(PAINTS)) {
    const T = this.T = TYPES[type];
    this.type = type; this.paint = paint;
    this.pos = new V3(x, 0, z); this.vel = new V3(); this.heading = heading; this.angVel = 0; this.vy = 0; this.vF = 0; this.prevVF = 0;
    this.steer = 0; this.steerAngle = 0; this.throttle = 0; this.slip = 0;
    this.health = T.health; this.state = 'ok'; this.burn = 0; this.wreckT = 0; this.submerged = 0;
    this.driver = null; this.parked = true; this.sleep = true; this.sleepT = 0; this.removed = false;
    this.susp = 0; this.suspV = 0; this.pitch = 0; this.roll = 0; this.bPitch = 0; this.bRoll = 0; this.lean = 0;
    this.grounded = true; this.lastG = null; this.spin = 0; this.fxT = 0; this.crashT = 0; this.inWater = T.kind === 'boat';
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.3, emissive: 0xffffff, emissiveIntensity: 0 });
    this.mat.onBeforeCompile = VEH_OBC;
    this.root = new THREE.Group(); this.root.rotation.order = 'YXZ';
    this.body = new THREE.Mesh(buildGeo(bodyParts(type, paint)), this.mat);
    this.body.castShadow = true; this.body.receiveShadow = true; this.root.add(this.body); scene.add(this.root);
    this.wheels = wheelLayout(type);
    const r = T.kind === 'bike' ? 0.38 : T.wid / 2, n = T.circles;
    this.cr = r; this.offs = Array.from({ length: n }, (_, i) => -T.len / 2 + r + i * (T.len - 2 * r) / (n - 1));
    this.pos.y = T.kind === 'boat' ? CFG.waterY : groundAt(x, z, 60, 0.6, 0.3);
    if (T.kind === 'bike') this.lean = 0.18;
    this.lastAttacker = null; this.police = type === 'police'; this.siren = false;
    if (this.police) {   // flashing light bar: two unlit boxes whose colours swap
      this.bar = [0, 1].map(i => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.28), new THREE.MeshBasicMaterial({ color: i ? 0x2040ff : 0xff2020, toneMapped: false }));
        m.position.set(i ? -0.32 : 0.32, 1.62, -0.25); this.body.add(m); return m; });
    }
  }
  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get dead() { return this.state === 'wreck' || this.state === 'sunk'; }
  wake() { this.sleep = false; this.sleepT = 0; }

  update(dt, ctl) {
    const T = this.T, boat = T.kind === 'boat';
    if (this.dead) ctl = null;
    if (this.sleep && !ctl) { this.updateFx(dt); return; }
    if (ctl) this.parked = false;
    const h = this.heading, fx = Math.sin(h), fz = Math.cos(h), sx = Math.cos(h), sz = -Math.sin(h);
    let vF = this.vel.x * fx + this.vel.z * fz, vS = this.vel.x * sx + this.vel.z * sz;
    const thr = ctl ? ctl.throttle : 0, hb = ctl ? ctl.handbrake && !boat : this.parked;
    const st = ctl ? ctl.steer : 0;
    this.steer += (st - this.steer) * Math.min(1, dt * (Math.abs(st) < Math.abs(this.steer) || st * this.steer < 0 ? 7 : 3.2));
    this.throttle = thr;
    const traction = boat ? this.inWater : this.grounded;
    if (traction) {
      // surface: paved inside the highway ring, rough terrain outside, sand on the beach
      let drag = 0, gripMul = 1;
      if (!boat && ringSD(this.pos.x, this.pos.z) > 13 && !blockAt(this.pos.x, this.pos.z)) {
        const sand = this.pos.z > 600 && this.pos.y < 0.8; drag = sand ? 3.5 : 1.4; gripMul = sand ? 0.6 : 0.75;
      }
      if (thr > 0) { if (vF < -0.5) vF = Math.min(0, vF + T.brake * thr * dt); else vF += T.accel * thr * Math.max(0, 1 - (vF / T.maxSpeed) ** 2) * dt; }
      else if (thr < 0) { if (vF > 0.5) vF = Math.max(0, vF + T.brake * thr * dt); else if (vF > -T.maxRev) vF += T.accel * 0.55 * thr * dt; }
      const roll = (thr === 0 ? (ctl ? 1.2 : 3) : 0.3) + drag;
      vF -= Math.sign(vF) * Math.min(Math.abs(vF), roll * dt);
      if (hb) vF -= Math.sign(vF) * Math.min(Math.abs(vF), (ctl ? 9 : 14) * dt);
      if (boat) vF -= vF * 0.22 * dt;
      vS *= Math.exp(-(hb ? T.driftGrip : T.grip) * gripMul * dt);
      this.slip = Math.abs(vS);
      const speedFac = 1 - 0.62 * Math.min(1, Math.abs(vF) / T.maxSpeed);
      this.steerAngle = this.steer * T.steer * speedFac;
      let yawT = boat ? -this.steer * T.steer * clamp(vF / 7, -1, 1) : -vF * Math.tan(this.steerAngle) / T.wheelbase;
      if (hb && Math.abs(vF) > 5) yawT *= 1.45;
      this.angVel += (yawT - this.angVel) * Math.min(1, dt * (hb ? 3.5 : 9));
    } else { this.angVel *= Math.exp(-0.8 * dt); this.slip = 0; }
    // velocity stays in world space; only the body rotates, so lateral slip builds up when grip is low (drifting)
    this.vel.x = fx * vF + sx * vS; this.vel.z = fz * vF + sz * vS;
    this.heading += this.angVel * dt;
    this.accelF = (vF - this.prevVF) / dt; this.prevVF = vF; this.vF = vF;

    const ox = this.pos.x, oz = this.pos.z;
    this.pos.x = clamp(this.pos.x + this.vel.x * dt, -CFG.worldLimit, CFG.worldLimit);
    this.pos.z = clamp(this.pos.z + this.vel.z * dt, -CFG.worldLimit, CFG.worldLimit);
    if (boat) this.boatFloat(dt, ox, oz); else this.groundFollow(dt);
    this.collideStatic();

    if (!ctl && this.speed < 0.1 && Math.abs(this.angVel) < 0.02 && (this.grounded || boat)) {
      if ((this.sleepT += dt) > 0.6) { this.sleep = true; this.vel.set(0, 0, 0); this.angVel = 0; }
    } else this.sleepT = 0;
    this.updateFx(dt);
  }

  groundFollow(dt) {
    const T = this.T, h = this.heading, fx = Math.sin(h), fz = Math.cos(h), sx = Math.cos(h), sz = -Math.sin(h);
    const smp = (lx, lz) => groundAt(this.pos.x + sx * lx + fx * lz, this.pos.z + sz * lx + fz * lz, this.pos.y, 0.6, 0.25);
    const hl = T.len * 0.38, hw = T.kind === 'bike' ? 0 : T.wid * 0.4;
    const fl = smp(hw, hl), fr = smp(-hw, hl), rl = smp(hw, -hl), rrr = smp(-hw, -hl);
    const gF = (fl + fr) / 2, gB = (rl + rrr) / 2, g = (gF + gB) / 2;
    const tp = Math.atan2(gF - gB, hl * 2), tr = hw ? Math.atan2((fl + rl) / 2 - (fr + rrr) / 2, hw * 2) : 0;
    this.vy -= 24 * dt; this.pos.y += this.vy * dt;
    if (this.pos.y <= g) {
      if (!this.grounded && this.vy < -3) { this.suspV += this.vy * 0.5; if (this.vy < -13) this.damage((-this.vy - 13) * 40); if (this.driver?.isPlayer) cam.shake = Math.max(cam.shake, Math.min(0.6, -this.vy * 0.04)); }
      const dG = this.lastG === null ? 0 : g - this.lastG;
      this.pos.y = g;
      const onRamp = ramps.length && rampHeight(this.pos.x, this.pos.z) > -Infinity;
      this.vy = dG > 0 && (dG < 0.08 || onRamp) ? Math.min(dG / dt, onRamp ? 16 : 12) : 0;   // ramps launch, kerbs just bump
      if (dG >= 0.08 && !onRamp) this.suspV -= dG * 10;
      this.grounded = true;
    } else if (this.grounded && this.pos.y - g < 0.35 && this.vy <= 0.5) { this.pos.y = g; this.vy = 0; }
    else this.grounded = false;
    this.lastG = g;
    const k = 1 - Math.exp(-(this.grounded ? 12 : 1) * dt);
    this.pitch = lerp(this.pitch, this.grounded ? tp : -0.12, k); this.roll = lerp(this.roll, this.grounded ? tr : 0, k);
    // driving into deep water: the car floods and sinks
    if (isWater(this.pos.x, this.pos.z, 0.9) && this.pos.y < CFG.waterY - 0.3) {
      if (this.submerged === 0) { splash(this.pos.x, CFG.waterY, this.pos.z, 30, 1.2); sfx.splashSfx(1); }
      this.submerged += dt; this.vel.multiplyScalar(Math.exp(-2.5 * dt));
      if (this.submerged > 1.5 && this.state !== 'sunk') { this.state = 'sunk'; this.health = 0; this.mat.emissiveIntensity = 0; emit('vehicleSunk', this); }
    }
  }

  boatFloat(dt, ox, oz) {
    const T = this.T, fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const bowX = this.pos.x + fx * T.len * 0.45, bowZ = this.pos.z + fz * T.len * 0.45;
    if (!isWater(bowX, bowZ, 0.35) || !isWater(this.pos.x, this.pos.z, 0.35)) {   // ran aground: bounce off the shore
      const imp = this.speed; this.pos.x = ox; this.pos.z = oz; this.vel.multiplyScalar(-0.25); this.angVel *= -0.5;
      if (imp > 3) this.onImpact(imp, bowX, CFG.waterY + 0.5, bowZ);
    }
    this.inWater = isWater(this.pos.x, this.pos.z, 0.35);
    const t = performance.now() / 1000, sp = Math.abs(this.vF) / T.maxSpeed;
    this.pos.y = CFG.waterY - 0.3 + Math.sin(t * 1.6 + this.pos.x * 0.15) * 0.07 + sp * 0.25;
    this.pitch = lerp(this.pitch, sp * 0.13 + Math.sin(t * 1.3 + this.pos.z * 0.2) * 0.025, 1 - Math.exp(-4 * dt));
    this.roll = lerp(this.roll, clamp(this.vF * this.angVel * 0.012, -0.2, 0.2) + Math.sin(t * 1.1) * 0.03, 1 - Math.exp(-4 * dt));
    this.grounded = true; this.vy = 0;
  }

  collideStatic() {
    const T = this.T, fx = Math.sin(this.heading), fz = Math.cos(this.heading), r = this.cr;
    let maxImp = 0, hx = 0, hz = 0;
    for (let it = 0; it < 2; it++) for (const oz of this.offs) {
      const cx = this.pos.x + fx * oz, cz = this.pos.z + fz * oz;
      for (const c of queryColliders(cx - r - 0.2, cz - r - 0.2, cx + r + 0.2, cz + r + 0.2)) {
        if (c.maxY <= this.pos.y + 0.6 || c.minY >= this.pos.y + T.hgt) continue;
        const px = clamp(cx, c.minX, c.maxX), pz = clamp(cz, c.minZ, c.maxZ);
        let dx = cx - px, dz = cz - pz; const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let nx, nz, pen;
        if (d2 > 1e-9) { const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; pen = r - d; }
        else { const p = [cx - c.minX, c.maxX - cx, cz - c.minZ, c.maxZ - cz], i = p.indexOf(Math.min(...p)); [nx, nz] = [[-1, 0], [1, 0], [0, -1], [0, 1]][i]; pen = p[i] + r; }
        this.pos.x += nx * pen; this.pos.z += nz * pen;
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn < 0) {
          this.vel.x -= nx * vn * 1.3; this.vel.z -= nz * vn * 1.3;
          const vt = -this.vel.x * nz + this.vel.z * nx; this.vel.x -= -nz * vt * 0.15; this.vel.z -= nx * vt * 0.15;
          const rx = fx * oz, rz = fz * oz; this.angVel += (rz * (-nx * vn) - rx * (-nz * vn)) * 6 / (T.len * T.len);
          if (-vn > maxImp) { maxImp = -vn; hx = cx - nx * r; hz = cz - nz * r; }
        }
        if (this.speed > 7 && Math.random() < 0.35) sparks(cx - nx * r, this.pos.y + 0.5, cz - nz * r, 2);   // scraping along a wall
      }
    }
    if (maxImp > 1.5) this.onImpact(maxImp, hx, this.pos.y + 0.6, hz);
  }

  onImpact(speed, x, y, z) {
    this.wake();
    if (speed > 5) this.damage(Math.pow(speed - 5, 1.35) * 3.5);
    sparks(x, y, z, Math.min(30, speed * 1.5 | 0));
    if (this.crashT <= 0) {
      const d = camera.position.distanceTo(this.pos);
      sfx.crash(Math.min(1, speed / 18) * clamp(1 - d / 80, 0, 1)); this.crashT = 0.15;
    }
    if (this.driver) cam.shake = Math.max(cam.shake, Math.min(0.7, speed * 0.025));
    emit('vehicleImpact', this, speed);
  }

  damage(d, by) {
    if (by) this.lastAttacker = by;
    if (this.dead || d <= 0) return;
    const T = this.T; this.health = Math.max(0, this.health - d);
    if (this.health <= T.health * 0.12) { if (this.state !== 'burning') { this.state = 'burning'; this.burn = 5 + rand() * 2; emit('vehicleFire', this); } }
    else if (this.health < T.health * 0.4) this.state = 'smoking';
  }

  explode() {
    if (this.state === 'wreck') return;
    this.state = 'wreck'; this.health = 0; this.wreckT = 25; this.wake(); this.parked = true;
    this.mat.color.setHex(0x2a2826); this.mat.emissiveIntensity = 0;
    this.vy = 6 + rand() * 3; this.grounded = false; this.angVel += (rand() - 0.5) * 3;
    const p = this.pos;
    explosionFX(p.x, p.y, p.z);
    const dCam = camera.position.distanceTo(p);
    sfx.explosion(clamp(1 - dCam / 250, 0, 1));
    cam.shake = Math.max(cam.shake, clamp(1.4 - dCam / 35, 0, 1.4));
    for (const o of vehicles) {
      if (o === this || o.removed) continue;
      const dx = o.pos.x - p.x, dz = o.pos.z - p.z, d = Math.hypot(dx, dz);
      if (d > 12) continue;
      const f = (12 - d) * 1.4 * Math.min(1, 1400 / o.T.mass);
      o.wake(); o.vel.x += dx / (d || 1) * f; o.vel.z += dz / (d || 1) * f; o.vy += f * 0.4; o.grounded = false;
      o.damage((12 - d) * 110);
    }
    emit('explosion', p.clone(), 9, this);
  }

  updateFx(dt) {
    const T = this.T, p = this.pos, fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    this.crashT -= dt;
    if (this.removed) return;
    if (this.state === 'burning' && (this.burn -= dt) <= 0) { this.explode(); return; }
    if (this.root.visible === false) return;
    this.fxT -= dt;
    const ex = p.x + fx * T.len * 0.36, ey = p.y + T.hgt * 0.7, ez = p.z + fz * T.len * 0.36;
    if (this.state === 'smoking' && this.fxT <= 0) { engineSmoke(ex, ey, ez, false); this.fxT = 0.09; }
    if (this.state === 'burning') {
      fireLick(ex, ey, ez); fireLick(ex, ey, ez);
      if (this.fxT <= 0) { engineSmoke(ex, ey + 0.5, ez, true); this.fxT = 0.06; }
    }
    if (this.state === 'wreck' && this.wreckT > 0) {
      this.wreckT -= dt;
      if (this.fxT <= 0) { engineSmoke(p.x, p.y + 1, p.z, true); if (this.wreckT > 18) fireLick(p.x, p.y + 0.8, p.z); this.fxT = 0.12; }
    }
    if (T.kind !== 'boat' && this.grounded && !this.sleep) {   // tyre smoke when sliding or doing a burnout
      const burnout = this.throttle > 0.9 && Math.abs(this.vF) < 7 && T.accel >= 9 && this.driver && this.prevVF >= 0;
      const amt = Math.max(clamp((this.slip - 4.5) / 6, 0, 1), burnout ? 0.7 : 0);
      if (amt > 0 && rand() < amt * 1.4) for (const w of this.wheels) if (!w.front) {
        const sx = Math.cos(this.heading), sz = -Math.sin(this.heading);
        tireSmoke(p.x + sx * w.x + fx * w.z, p.y, p.z + sz * w.x + fz * w.z, amt);
      }
    }
    if (T.kind === 'boat' && Math.abs(this.vF) > 3 && rand() < 0.8) {
      const sx = Math.cos(this.heading), sz = -Math.sin(this.heading), a = Math.min(1, Math.abs(this.vF) / 15);
      for (const s of [-1, 1]) wake(p.x - fx * T.len * 0.45 + sx * s * 0.9, CFG.waterY, p.z - fz * T.len * 0.45 + sz * s * 0.9, a);
    }
  }

  // visual transform: body on suspension, wheels via the shared instanced mesh
  updateVisual(dt, wheelIdx) {
    const T = this.T, k = 1 - Math.exp(-10 * dt);
    this.suspV += (-160 * this.susp - 11 * this.suspV) * dt; this.susp += this.suspV * dt; this.susp = clamp(this.susp, -0.25, 0.25);
    this.bPitch = lerp(this.bPitch, T.kind === 'boat' ? 0 : clamp(-(this.accelF || 0) * 0.004, -0.06, 0.06), k);
    this.bRoll = lerp(this.bRoll, T.kind === 'car' ? clamp(this.vF * this.angVel * 0.005, -0.08, 0.08) : 0, k);
    if (T.kind === 'bike') this.lean = lerp(this.lean, this.driver ? clamp(-this.vF * this.angVel * 0.07, -0.75, 0.75) : (this.speed < 0.5 ? 0.18 : 0), k);
    this.root.position.copy(this.pos);
    this.root.rotation.set(-this.pitch, this.heading, this.roll + this.lean);
    this.body.position.y = this.susp; this.body.rotation.set(this.bPitch, 0, this.bRoll);
    this.mat.emissiveIntensity = this.dead ? 0 : this.driver ? 0.25 + nightU.value * 1.6 : 0.05;
    if (this.bar) {
      const on = this.siren && !this.dead, ph = Math.floor(performance.now() / 140) % 2;
      this.bar[0].material.color.setHex(on ? (ph ? 0xff2020 : 0x401010) : 0x401010); this.bar[1].material.color.setHex(on ? (ph ? 0x101840 : 0x2040ff) : 0x101840);
    }
    this.spin += this.vF * dt / (T.wheelR || 1);
    this.root.updateMatrixWorld();
    for (const w of this.wheels) {
      _e.set(this.spin, w.front ? -this.steerAngle * (T.kind === 'bike' ? 0.6 : 1) : 0, 0, 'YXZ'); _q.setFromEuler(_e);
      _m.compose(_p.set(w.x, T.wheelR, w.z), _q, _s.set(T.wheelW, T.wheelR, T.wheelR)).premultiply(this.root.matrixWorld);
      wheelIM.setMatrixAt(wheelIdx++, _m);
    }
    return wheelIdx;
  }
}

/* =====================================================================
   VEHICLES: world management — update, vehicle-vs-vehicle, player pushout, spawning
   ===================================================================== */
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
export function updateVehicles(dt, driven, ctl) {
  for (const v of vehicles) v.update(dt, v === driven ? ctl : v.ai ? v.ai.ctl : null);
  collideVehicles();
  let wi = 0;
  const cp = camera.position;
  for (const v of vehicles) {
    const vis = v.pos.distanceToSquared(cp) < 280 * 280;
    v.root.visible = vis;
    if (vis) wi = v.updateVisual(dt, wi);
  }
  for (let i = wi; i < wheelIM.count; i++) wheelIM.setMatrixAt(i, ZERO);
  wheelIM.instanceMatrix.needsUpdate = true;
  // headlight for the driven vehicle at night
  if (driven && !driven.dead && nightU.value > 0.15) {
    const f = Math.sin(driven.heading), g = Math.cos(driven.heading), L = driven.T.len / 2;
    headlight.position.set(driven.pos.x + f * L, driven.pos.y + 0.9, driven.pos.z + g * L);
    headlight.target.position.set(driven.pos.x + f * (L + 25), driven.pos.y - 1, driven.pos.z + g * (L + 25));
    headlight.intensity = nightU.value * 600;
  } else headlight.intensity = 0;
}

function collideVehicles() {
  for (let i = 0; i < vehicles.length; i++) for (let j = i + 1; j < vehicles.length; j++) {
    const a = vehicles[i], b = vehicles[j];
    if (a.sleep && b.sleep) continue;
    if ((a.T.kind === 'boat') !== (b.T.kind === 'boat')) continue;
    const reach = (a.T.len + b.T.len) / 2 + 0.5;
    if (Math.abs(a.pos.x - b.pos.x) > reach || Math.abs(a.pos.z - b.pos.z) > reach || Math.abs(a.pos.y - b.pos.y) > 2.2) continue;
    const afx = Math.sin(a.heading), afz = Math.cos(a.heading), bfx = Math.sin(b.heading), bfz = Math.cos(b.heading);
    let worst = 0, hx = 0, hz = 0;
    for (const oa of a.offs) for (const ob of b.offs) {
      const ax = a.pos.x + afx * oa, az = a.pos.z + afz * oa, bx = b.pos.x + bfx * ob, bz = b.pos.z + bfz * ob;
      const dx = ax - bx, dz = az - bz, d = Math.hypot(dx, dz), rs = a.cr + b.cr;
      if (d >= rs || d < 1e-5) continue;
      const nx = dx / d, nz = dz / d, pen = rs - d, ma = a.T.mass, mb = b.T.mass;
      a.pos.x += nx * pen * mb / (ma + mb); a.pos.z += nz * pen * mb / (ma + mb);
      b.pos.x -= nx * pen * ma / (ma + mb); b.pos.z -= nz * pen * ma / (ma + mb);
      const vrel = (a.vel.x - b.vel.x) * nx + (a.vel.z - b.vel.z) * nz;
      if (vrel < 0) {
        const jm = -1.3 * vrel / (1 / ma + 1 / mb);
        a.vel.x += nx * jm / ma; a.vel.z += nz * jm / ma; b.vel.x -= nx * jm / mb; b.vel.z -= nz * jm / mb;
        a.angVel += (afz * oa * nx - afx * oa * nz) * (jm / ma) * 4 / (a.T.len * a.T.len);
        b.angVel -= (bfz * ob * nx - bfx * ob * nz) * (jm / mb) * 4 / (b.T.len * b.T.len);
        if (-vrel > worst) { worst = -vrel; hx = (ax + bx) / 2; hz = (az + bz) / 2; }
      }
      a.wake(); b.wake();
    }
    if (worst > 1.5 && (a.driver?.isPlayer || b.driver?.isPlayer)) { if (a.driver?.isPlayer) b.lastAttacker = 'player'; else a.lastAttacker = 'player'; }
    if (worst > 1.5) { const y = Math.max(a.pos.y, b.pos.y) + 0.7; a.onImpact(worst * b.T.mass / (a.T.mass + b.T.mass) * 2, hx, y, hz); b.onImpact(worst * a.T.mass / (a.T.mass + b.T.mass) * 2, hx, y, hz); }
  }
}

// keep an on-foot character (circle radius pr) out of vehicles
export function pushFromVehicles(p, vel, pr, ph, exclude) {
  let hit = null;
  for (const v of vehicles) {
    if (v === exclude || v.removed) continue;
    if (p.y >= v.pos.y + v.T.hgt - 0.15 || p.y + ph < v.pos.y) continue;
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    if (Math.abs(p.x - v.pos.x) > v.T.len || Math.abs(p.z - v.pos.z) > v.T.len) continue;
    for (const o of v.offs) {
      const dx = p.x - (v.pos.x + fx * o), dz = p.z - (v.pos.z + fz * o), d = Math.hypot(dx, dz), rs = v.cr + pr;
      if (d >= rs || d < 1e-5) continue;
      const nx = dx / d, nz = dz / d; p.x += nx * (rs - d); p.z += nz * (rs - d);
      const vn = vel.x * nx + vel.z * nz; if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
      const closing = v.vel.x * nx + v.vel.z * nz;   // vehicle velocity toward the character
      if (v.speed > 5 && closing > 3 && (!hit || v.speed > hit.speed)) hit = { v, speed: v.speed };
    }
  }
  return hit;
}

export function spawnVehicle(type, x, z, heading, paint) {
  if (vehicles.length >= MAXV) { const i = vehicles.findIndex(o => !o.driver && !o.keep && o.pos.distanceTo(camera.position) > 60); if (i >= 0) removeVehicle(i); }
  const v = new Vehicle(type, x, z, heading, paint); vehicles.push(v); return v;
}
export function removeVehicle(i) {
  const v = vehicles[i]; v.removed = true; scene.remove(v.root); v.body.geometry.dispose(); v.mat.dispose(); vehicles.splice(i, 1);
}
function pickType(s) {
  if (s.force) return s.force;
  if (s.kind === 'boat') return 'boat';
  const r = rand(), d = s.district;
  if (d === 'industrial' || d === 'outskirts') return r < 0.55 ? 'truck' : r < 0.85 ? 'sedan' : 'moto';
  if (d === 'downtown' || d === 'plaza') return r < 0.28 ? 'sports' : r < 0.42 ? 'moto' : r < 0.5 ? 'truck' : 'sedan';
  return r < 0.12 ? 'sports' : r < 0.24 ? 'moto' : r < 0.32 ? 'truck' : 'sedan';
}
// Vehicles live near the player: spawn at parking spots within ~230 m, despawn beyond ~320 m.
export function updateSpawns(focus, keep, initial = false) {
  for (let i = vehicles.length - 1; i >= 0; i--) {
    const v = vehicles[i]; if (v === keep || v.driver || v.keep) continue;
    if (Math.hypot(v.pos.x - focus.x, v.pos.z - focus.z) > 320 || (v.state === 'sunk' && v.submerged > 20)) removeVehicle(i);
  }
  const cand = [];
  for (const s of parkingSpots) {
    if (s.v && s.v.removed) s.v = null;   // despawned with the spot: free immediately
    else if (s.v && Math.hypot(s.v.pos.x - s.x, s.v.pos.z - s.z) > 6) { s.v = null; s.cooldown = 45; }   // vehicle was taken or pushed away
    if (s.cooldown > 0) { s.cooldown -= 0.5; continue; }
    if (s.v) continue;
    const d = Math.hypot(s.x - focus.x, s.z - focus.z);
    if (d < 230 && (initial || d > 90)) cand.push([d, s]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  let parked = vehicles.filter(v => !v.ai).length;
  for (const [, s] of cand) {
    if (parked >= MAX_PARKED || vehicles.length >= MAXV - 2) break;
    if (vehicles.some(v => Math.abs(v.pos.x - s.x) < 5 && Math.abs(v.pos.z - s.z) < 5)) continue;
    s.v = spawnVehicle(pickType(s), s.x, s.z, s.heading); parked++;
  }
}
