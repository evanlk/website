// traffic.js — AI drivers: lane following, traffic lights, junction yielding, obstacle braking, honking, panic, bailing out
import { V3, Q, clamp, lerp, rand, rr, pick, camera, S, timeU, on, emit } from './core.js';
import { edges, lanePath, turnPath, dirAt, pointAt, project, lightState, axisOf } from './nav.js';
import { vehicles, spawnVehicle, removeVehicle } from './vehicles.js';
import { player } from './player.js';
import { peds, spawnPedAt, inView } from './peds.js';
import * as sfx from './audio.js';

/* =====================================================================
   TRAFFIC: driver agent
   ===================================================================== */
export const drivers = [];
const MAX_TRAFFIC = 28;
const RING_LANES = [2, 6];
export class Driver {
  constructor(v, edge, s) {
    this.v = v; this.isAI = true; v.ai = this; v.driver = this; v.parked = false; v.wake();
    this.ringLane = pick(RING_LANES); this.edge = edge; this.phase = 'lane';
    this.path = lanePath(edge, this.laneFor(edge)); this.i = 0; this.s = s;
    this.cruise = rr(0.9, 1.08); this.ctl = { throttle: 0, steer: 0, handbrake: false };
    this.wait = 0; this.honkT = 0; this.panic = 0; this.hurry = 0; this.lat = 0; this.bypassT = 0; this.offT = 0; this.next = null;
  }
  laneFor(e) { return e.ring ? this.ringLane : 1.75; }
  speedLimit() { return (this.edge.ring ? 24 : 13) * this.cruise; }
  turnSpeed() { return 7; }
  // pick the next edge at the end of the lane (no U-turns), and build the turn curve onto it
  chooseNext() {
    const opts = this.edge.to.out.filter(e => e.to !== this.edge.from);
    const d0 = dirAt(this.path, true);
    // prefer going straight on (half the time) to keep traffic flowing along avenues
    const straight = opts.find(e => { const d = dirAt(lanePath(e, this.laneFor(e)), false); return d0[0] * d[0] + d0[1] * d[1] > 0.9; });
    this.next = straight && rand() < 0.5 ? straight : pick(opts);
    const d2 = dirAt(lanePath(this.next, this.laneFor(this.next)), false);
    this.leftTurn = d0[0] * d2[1] - d0[1] * d2[0] < -0.5;   // right-hand traffic: left turns cross oncoming lanes
  }
  // oncoming traffic heading into the junction: a left-turner must wait for a gap
  oncoming(n, d0) {
    for (const o of vehicles) {
      if (o === this.v || o.removed || o.speed < 1.5) continue;
      const dx = n.x - o.pos.x, dz = n.z - o.pos.z, d = Math.hypot(dx, dz); if (d > 38) continue;
      if (o.ai && o.ai.phase === 'turn' && d < 16) return true;   // someone is already turning through the junction
      if (d < 4) continue;
      const vx = o.vel.x / o.speed, vz = o.vel.z / o.speed;
      if (vx * d0[0] + vz * d0[1] < -0.7 && dx * vx + dz * vz > 0) return true;
    }
    return false;
  }
  beginTurn() {
    if (!this.next) this.chooseNext();
    const d0 = dirAt(this.path, true);
    const np = lanePath(this.next, this.laneFor(this.next)), d2 = dirAt(np, false);
    this.turnStraight = d0[0] * d2[0] + d0[1] * d2[1] > 0.9;
    this.path = turnPath(this.path.pts[this.path.pts.length - 1], d0, np.pts[0], d2); this.phase = 'turn'; this.i = 0; this.s = 0;
  }
  endTurn() { this.edge = this.next; this.next = null; this.path = lanePath(this.edge, this.laneFor(this.edge)); this.phase = 'lane'; this.i = 0; this.s = 0; }

  // distance to the nearest thing in our corridor ahead (vehicles, player on foot, pedestrians)
  scan(shift = 0) {   // shift > 0 moves the scanned corridor to the left (used while overtaking)
    const v = this.v, fx = Math.sin(v.heading), fz = Math.cos(v.heading), rx = -fz, rz = fx;
    const range = 8 + v.speed * 2.2; let best = Infinity; this.blocker = null;
    const test = (px, pz, hw, hl, ref) => {
      const dx = px - v.pos.x, dz = pz - v.pos.z; if (Math.abs(dx) > range + 8 || Math.abs(dz) > range + 8) return;
      const f = dx * fx + dz * fz, l = dx * rx + dz * rz;
      if (f <= 0 || f > range + hl || Math.abs(l + shift) > v.T.wid / 2 + hw + 0.35) return;
      const d = f - v.T.len / 2 - hl; if (d < best) { best = d; this.blocker = ref; }
    };
    for (const o of vehicles) if (o !== v && !o.removed && !this.ignoreV?.(o)) test(o.pos.x, o.pos.z, o.T.wid / 2, o.T.len / 2, o);
    if (!player.vehicle) test(player.pos.x, player.pos.z, 0.4, 0.4, player);
    for (const p of peds) if (p.state !== 'down' || p.grounded) test(p.pos.x, p.pos.z, 0.4, 0.4, p);
    return best;
  }

  update(dt) {
    const v = this.v, c = this.ctl;
    if (v.dead || v.state === 'burning') { this.bail(v.pos); return; }
    this.panic -= dt; this.hurry -= dt; this.honkT -= dt;
    // follow the path
    const pr = project(this.path, v.pos.x, v.pos.z, this.i); this.i = pr.i; this.s = pr.s;
    this.offT = pr.d > 8 ? this.offT + dt : 0;
    const rem = this.path.len - this.s;
    let target = this.speedLimit() * (this.panic > 0 ? 1.35 : this.hurry > 0 ? 1.15 : 1);
    let canGo = true;
    if (this.phase === 'lane') {
      const n = this.edge.to, stopAt = (d) => Math.sqrt(Math.max(0, 2 * 5 * (d - 1.2)));
      if (n.type === 'grid' && this.panic <= 0) {
        const st = lightState(n, axisOf(dirAt(this.path, true)));
        if (st === 'red' || (st === 'yellow' && rem > v.speed * v.speed / 14 + 2)) { target = Math.min(target, stopAt(rem)); canGo = false; }
      } else if (n.type === 'ring' && !this.edge.ring && this.ringBusy(n)) { target = Math.min(target, stopAt(rem)); canGo = false; }
      if (rem < 35 && !this.next) this.chooseNext();
      if (canGo && this.leftTurn && rem < 12 && n.type === 'grid' && this.oncoming(n, dirAt(this.path, true))) { target = Math.min(target, stopAt(rem)); canGo = false; }
      if (rem < 25) target = Math.min(target, this.turnSpeed() + 2 + rem * 0.4 * (this.turnSpeed() / 7));   // slow down approaching the junction
      if (rem < 1.5 && canGo) this.beginTurn();
    } else {
      if (!this.turnStraight) target = Math.min(target, this.turnSpeed());
      if (rem < 1.5) this.endTurn();
    }
    const want = target;
    if (this.bypassT > 0) target = Math.min(target, 6);
    const obs = this.scan(this.bypassT > 0 ? 3.4 : 0);
    if (obs < Infinity) target = Math.min(target, Math.max(0, (obs - 2.5) * 0.9));
    // stuck behind something: honk, then steer around stationary obstacles
    const blocked = v.speed < 0.6 && want > 2 && this.blocker;
    this.wait = blocked ? this.wait + dt : Math.max(0, this.wait - dt * 2);
    if (this.wait > 2.2 && this.honkT <= 0) { this.honk(); this.honkT = rr(2.5, 5); }
    const bl = this.blocker;
    // go around parked cars / wrecks / abandoned vehicles, or AI cars that are themselves stuck — never cars queuing at a light
    if (this.wait > 5 && bl && bl !== player && !(peds.includes(bl) && !bl.ko) && (!bl.ai || bl.ai.wait > 8)) { this.bypassT = 4; this.wait = 2.5; }
    this.bypassT -= dt;
    this.lat = lerp(this.lat, this.bypassT > 0 ? 3.4 : 0, 1 - Math.exp(-1.5 * dt));
    // steering: pure pursuit on a look-ahead point (shifted left when bypassing)
    const L = 5 + v.speed * 0.55, [tx, tz] = this.lookAhead(L);
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    const lx = tx + fz * this.lat - v.pos.x, lz = tz - fx * this.lat - v.pos.z;
    const ang = Math.atan2(lx * -fz + lz * fx, lx * fx + lz * fz);
    c.steer = clamp(ang * 2.2, -1, 1);
    const diff = target - v.vF;
    if (target < 0.3) { c.throttle = v.vF > 0.5 ? -1 : 0; c.handbrake = v.vF <= 0.5; }
    else { c.handbrake = false; c.throttle = diff > 0 ? clamp(diff * 0.45, 0, 1) : clamp(diff * 0.5, -1, 0); }
  }
  lookAhead(L) {
    const s = this.s + L;
    if (s <= this.path.len || this.phase === 'turn' && !this.next) return pointAt(this.path, s);
    if (this.phase === 'turn') return pointAt(lanePath(this.next, this.laneFor(this.next)), s - this.path.len);
    return pointAt(this.path, this.path.len);
  }
  ringBusy(n) {   // something on the highway near this junction: wait for a gap
    for (const o of vehicles) {
      if (o === this.v || o.removed || o.speed < 2) continue;
      const d = Math.hypot(o.pos.x - n.x, o.pos.z - n.z); if (d > 40) continue;
      const toward = ((n.x - o.pos.x) * o.vel.x + (n.z - o.pos.z) * o.vel.z) > 0;
      if (toward && d > 9) return true;
    }
    return false;
  }
  honk() {
    const d = camera.position.distanceTo(this.v.pos);
    if (d < 90) sfx.honk(clamp(1 - d / 90, 0, 1) * 0.8, this.v.T.kind === 'bike' ? 1.3 : this.v.type === 'truck' ? 0.75 : 1);
    emit('honk', this.v.pos);
  }
  // driver leaves the vehicle and runs (carjacked, on fire, explosion nearby)
  bail(fleeFrom, keepVehicle = false) {
    const v = this.v; if (this.gone) return; this.gone = true;
    if (v.ai === this) { v.ai = null; if (!keepVehicle) v.driver = null; }
    v.parked = true;
    const sx = Math.cos(v.heading), sz = -Math.sin(v.heading), side = v.T.wid / 2 + 0.7;
    spawnPedAt(v.pos.x + sx * side, v.pos.z + sz * side, fleeFrom || v.pos);
    const di = drivers.indexOf(this); if (di >= 0) drivers.splice(di, 1);
  }
}

/* =====================================================================
   TRAFFIC: events, spawning, per-frame update
   ===================================================================== */
on('vehicleImpact', (v, speed) => { if (!v.ai) return; if (speed > 6) { v.ai.panic = 10; v.ai.honk(); } else if (speed > 2 && v.ai.honkT <= 0) { v.ai.honk(); v.ai.honkT = 3; } });
on('explosion', pos => { for (const d of drivers.slice()) { const r = d.v.pos.distanceTo(pos); if (r < 18) d.bail(pos); else if (r < 70) d.panic = 12; } });
on('carjack', v => { if (v.ai) v.ai.bail(player.pos, true); });
on('gunshot', pos => { for (const d of drivers) if (d.v.pos.distanceTo(pos) < 45) d.panic = Math.max(d.panic, 8); });
on('playerHorn', () => {   // honking at cars ahead makes them hurry up
  const pv = player.vehicle; if (!pv) return;
  const fx = Math.sin(pv.heading), fz = Math.cos(pv.heading);
  for (const d of drivers) { const dx = d.v.pos.x - pv.pos.x, dz = d.v.pos.z - pv.pos.z, f = dx * fx + dz * fz; if (f > 0 && f < 30 && Math.abs(dx * fz - dz * fx) < 4) d.hurry = 4; }
  emit('honk', pv.pos);
});

// spawn a vehicle on the nearest lane to (x, z) driven by DriverClass (used by missions for fleeing / racing / chasing AI)
export function spawnOnRoad(type, x, z, paint, DriverClass = Driver, opts = {}) {
  let best = null;
  for (const e of edges) { const a = e.pts[0], b = e.pts[e.pts.length - 1]; if (Math.min(Math.hypot(a[0] - x, a[1] - z), Math.hypot(b[0] - x, b[1] - z)) > 320) continue;
    const path = lanePath(e, e.ring ? 2 : 1.75), pr = project(path, x, z, 0);
    for (let i = 0; i < path.pts.length - 1; i += 4) { const q = project(path, x, z, i); if (q.d < pr.d) Object.assign(pr, q); }
    if (!best || pr.d < best.pr.d) best = { e, path, pr }; }
  const { e, path, pr } = best, [px, pz] = pointAt(path, pr.s), [qx, qz] = pointAt(path, pr.s + 2);
  const v = spawnVehicle(type, px, pz, Math.atan2(qx - px, qz - pz), paint);
  const d = new DriverClass(v, e, pr.s); d.i = pr.i; Object.assign(d, opts); return d;
}
const TYPES_W = [['sedan', 0.58], ['sports', 0.12], ['truck', 0.16], ['moto', 0.14]];
function pickType() { let r = rand(); for (const [t, w] of TYPES_W) if ((r -= w) <= 0) return t; return 'sedan'; }
function trySpawn(focus, near) {
  const e = pick(near), lane = e.ring ? pick(RING_LANES) : 1.75, path = lanePath(e, lane);
  if (path.len < 24) return;
  const s = rr(6, path.len - 10), [x, z] = pointAt(path, s), d = Math.hypot(x - focus.x, z - focus.z);
  if (d < 45 || d > 210 || (d < 160 && inView(x, 1, z, 4))) return;
  if (vehicles.some(o => Math.abs(o.pos.x - x) < 14 && Math.abs(o.pos.z - z) < 14)) return;
  const [a, b] = [pointAt(path, s), pointAt(path, s + 2)], h = Math.atan2(b[0] - a[0], b[1] - a[1]);
  const v = spawnVehicle(pickType(), x, z, h);
  const dr = new Driver(v, e, s); dr.i = project(path, x, z, 0).i;
  const sp = dr.speedLimit() * 0.7; v.vel.set(Math.sin(h) * sp, 0, Math.cos(h) * sp);
  drivers.push(dr);
}
let spawnT = 0;
export function updateTraffic(dt, focus) {
  if ((spawnT -= dt) <= 0) {
    spawnT = 0.5;
    for (const d of drivers.slice()) {   // despawn far / hopelessly stuck traffic when out of sight
      const v = d.v, far = Math.hypot(v.pos.x - focus.x, v.pos.z - focus.z);
      if ((far > 260 || d.offT > 6 || d.wait > 25) && !inView(v.pos.x, 1, v.pos.z, 4)) {
        drivers.splice(drivers.indexOf(d), 1); const i = vehicles.indexOf(v); if (i >= 0 && player.lastVehicle !== v) removeVehicle(i);
      }
    }
    if (drivers.length < (Q.traffic ?? MAX_TRAFFIC)) {
      const near = edges.filter(e => { const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
        return Math.min(Math.hypot(a[0] - focus.x, a[1] - focus.z), Math.hypot(b[0] - focus.x, b[1] - focus.z)) < 220; });
      for (let t = 0; t < 10 && near.length && drivers.length < (Q.traffic ?? MAX_TRAFFIC); t++) trySpawn(focus, near);
    }
  }
  for (const d of drivers.slice()) d.update(dt);
}
