// missions.js — data-driven mission engine (story + side activities), markers, dialogue, AI drivers for missions,
// street races, taxi jobs, stunt jumps, collectibles
import * as THREE from 'three';
import { CFG, V3, clamp, rand, rr, pick, scene, camera, S, on, emit, cam } from './core.js';
import { blocks, baseGround, groundAt, rayWorld, ramps } from './world.js';
import { nodes, pnodes } from './nav.js';
import { vehicles, spawnVehicle, removeVehicle } from './vehicles.js';
import { player } from './player.js';
import { peds, spawnPedAt, inView } from './peds.js';
import { wanted, addCrime, stations, hospitals } from './police.js';
import { npcShoot } from './combat.js';
import { Driver, spawnOnRoad } from './traffic.js';
import * as sfx from './audio.js';

/* =====================================================================
   MISSIONS: progress (saved) + location helpers
   ===================================================================== */
// S.progress holds everything the save file needs about missions and activities
S.progress = { done: {}, best: {}, jumps: {}, reels: {}, cars: [], outfits: ['default'], outfit: 'default', loft: false, taxiBest: 0 };
const P = () => S.progress;
const blockNear = (tx, tz) => blocks.filter(b => b.district !== 'park' && b.district !== 'plaza').reduce((a, c) => Math.hypot(c.cx - tx, c.cz - tz) < Math.hypot(a.cx - tx, a.cz - tz) ? c : a);
// a sidewalk point on the west side of the block nearest (tx,tz), plus a kerbside parking spot on the road beside it
export function spot(tx, tz) {
  const b = blockNear(tx, tz), x = b.x0 + 3.4, z = b.cz;
  return { x, z, car: { x: b.x0 - 7 + 5.6, z: z + 7, h: Math.PI } };
}
const Y = (x, z) => groundAt(x, z, 3, 0.5);   // ground or a low prop top (never lamp posts / trees)

/* =====================================================================
   MISSIONS: markers (3D beacons) and pickups
   ===================================================================== */
const COL = { waypoint: 0xff4fd8, mission: 0xffd34d, objective: 0xffd34d, shop: 0x5fd35b, safe: 0x4aa8ff, activity: 0xc77dff, checkpoint: 0xff5a4a };
function beacon(color, r = 1.4, h = 2.6) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24, 1, true).translate(0, h / 2, 0), mat));
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.75, r, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }));
  ring.position.y = 0.05; g.add(ring); scene.add(g); return g;
}
export function beaconAt(kind, x, z) { const b = beacon(COL[kind]); b.position.set(x, Y(x, z), z); return b; }
const objMarker = beacon(COL.objective, 2.2, 5); objMarker.visible = false;
const cpMarker = beacon(COL.checkpoint, 7, 7); cpMarker.visible = false;
const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.9, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: COL.objective, toneMapped: false })); arrow.visible = false; scene.add(arrow);
function propBox(color, w = 0.5, h = 0.4, d = 0.4) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 })); m.castShadow = true; scene.add(m); return m; }

/* =====================================================================
   MISSIONS: AI drivers used by missions (flee, race, chase)
   ===================================================================== */
const _o = new V3();
class DirectDriver {
  constructor(v, opts = {}) {
    this.v = v; v.ai = this; v.driver = this; v.parked = false; v.keep = true; v.wake();
    Object.assign(this, { isAI: true, ctl: { throttle: 0, steer: 0, handbrake: false }, wait: 0, panic: 0, honkT: 0, stuckT: 0, revT: 0, goal: new V3(), want: 20, gone: false }, opts);
  }
  honk() {}
  bail(from, keepVehicle) { const v = this.v; if (this.gone) return; this.gone = true; v.ai = null; if (!keepVehicle) v.driver = null; v.parked = true; spawnPedAt(v.pos.x + Math.cos(v.heading) * 1.8, v.pos.z - Math.sin(v.heading) * 1.8, from || v.pos); }
  drive(dt) {
    const v = this.v, c = this.ctl; if (this.gone || v.dead) return;
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading), lx = this.goal.x - v.pos.x, lz = this.goal.z - v.pos.z;
    let steer = clamp(Math.atan2(lx * -fz + lz * fx, lx * fx + lz * fz) * 2, -1, 1), want = this.want;
    const L = 7 + v.speed * 0.6; _o.set(v.pos.x + fx * 2, v.pos.y + 0.8, v.pos.z + fz * 2);
    for (const side of [1, -1]) { const a = v.heading + side * 0.45, t = rayWorld(_o, Math.sin(a), 0, Math.cos(a), L); if (t < L) steer += side * (1 - t / L) * 1.6; }
    if (rayWorld(_o, fx, 0, fz, L) < L * 0.5 && v.speed > 6) want = Math.min(want, 7);
    const turn = Math.abs(Math.atan2(lx * -fz + lz * fx, lx * fx + lz * fz)); if (turn > 0.6 && Math.hypot(lx, lz) < 40) want = Math.min(want, 11);
    if (want > 3 && v.speed < 1 && this.revT <= 0) { if ((this.stuckT += dt) > 1.3) { this.revT = 1.1; this.stuckT = 0; } } else this.stuckT = 0;
    if (this.revT > 0) { this.revT -= dt; c.throttle = -1; c.steer = clamp(-steer, -1, 1); }
    else { c.steer = clamp(steer, -1, 1); const d = want - v.vF; c.throttle = d > 0 ? clamp(d * 0.4, 0.2, 1) : clamp(d * 0.4, -1, 0); }
    c.handbrake = false;
  }
}
const nodeNear = p => nodes.reduce((a, n) => (n.x - p.x) ** 2 + (n.z - p.z) ** 2 < (a.x - p.x) ** 2 + (a.z - p.z) ** 2 ? n : a);
// Lane-following drivers built on the traffic AI: they ignore lights and pick their own route at each junction.
class FleeAI extends Driver {   // runs away through the street grid, choosing junctions away from the player
  constructor(v, e, s) { super(v, e, s); this.panic = 1e9; v.keep = true; }
  speedLimit() { return this.edge.ring ? 30 : 22; }
  turnSpeed() { return 10; }
  chooseNext() {
    const pp = player.pos, opts = this.edge.to.out.filter(e => e.to !== this.edge.from);
    opts.sort((a, b) => Math.hypot(b.to.x - pp.x, b.to.z - pp.z) - Math.hypot(a.to.x - pp.x, a.to.z - pp.z));
    this.next = rand() < 0.75 ? opts[0] : pick(opts); this.leftTurn = false;
  }
  drive(dt) { this.panic = 1e9; this.update(dt); }
}
class RacerAI extends Driver {   // heads for the next checkpoint (checkpoints sit on junctions)
  constructor(v, e, s) { super(v, e, s); this.panic = 1e9; this.cp = 0; this.skill = rr(0.84, 0.95); this.band = 1; v.keep = true; this.ringLane = 2; }
  ignoreV(o) { return o.ai instanceof RacerAI || o === player.vehicle; }   // racers trade paint instead of queuing
  speedLimit() { return (this.edge.ring ? 42 : 31) * this.skill * this.band; }
  turnSpeed() { return 12; }
  chooseNext() {
    const R = MS.race; let k = this.cp, c = R.cps[Math.min(k, R.cps.length - 1)];
    if (Math.hypot(this.edge.to.x - c.x, this.edge.to.z - c.z) < 20 && k + 1 < R.cps.length) c = R.cps[k + 1];   // about to reach it: aim past
    const opts = this.edge.to.out.filter(e => e.to !== this.edge.from);
    opts.sort((a, b) => Math.hypot(a.to.x - c.x, a.to.z - c.z) - Math.hypot(b.to.x - c.x, b.to.z - c.z));
    this.next = opts[0]; this.leftTurn = false;
  }
  drive(dt) { this.panic = 1e9; this.update(dt); }
}
class ChaserDriver extends DirectDriver {   // hostile driver that rams the player
  drive(dt) { const t = player.vehicle || player; const pv = player.vehicle; this.goal.set(t.pos.x + (pv ? pv.vel.x * 0.6 : 0), 0, t.pos.z + (pv ? pv.vel.z * 0.6 : 0)); this.want = 36; super.drive(dt); }
}

/* =====================================================================
   MISSIONS: hostile gang members (for combat objectives)
   ===================================================================== */
const GANG = { shirt: 0x222226, pants: 0x121214, hair: 0x101010 };
function spawnGoon(x, z) {
  const g = spawnPedAt(x, z); g.hostile = true; g.hp = 60; g.state = 'aim'; g.goal.set(x + rr(-5, 5), 0, z + rr(-5, 5));
  g.colors = { ...GANG, skin: g.colors.skin }; g.aggro = false; g.fireT = rr(0.8, 1.6); return g;
}
function updateGoons(list, dt) {
  const tgt = player.vehicle ? player.vehicle.pos : player.pos;
  for (const g of list) {
    if (g.ko || g.state === 'down' || g.state === 'getup') continue;
    const d = g.pos.distanceTo(tgt);
    if ((g.losT = (g.losT || 0) - dt) <= 0) { g.losT = 0.3; _o.set(g.pos.x, g.pos.y + 1.5, g.pos.z); const dx = tgt.x - _o.x, dy = tgt.y + 1.2 - _o.y, dz = tgt.z - _o.z, l = Math.hypot(dx, dy, dz) || 1; g.los = d < 60 && rayWorld(_o, dx / l, dy / l, dz / l, l) >= l - 0.6; }
    if (!g.aggro && ((g.los && d < 30) || g.hp < 60)) { for (const o of list) o.aggro = true; }
    if (!g.aggro) continue;
    g.goal.copy(tgt);
    if (g.los && d < 35) {
      g.state = 'aim';
      if ((g.fireT -= dt) <= 0) { g.fireT = rr(0.9, 1.6); const f = Math.sin(g.facing), h = Math.cos(g.facing);
        npcShoot(new V3(g.pos.x + f * 0.55, g.pos.y + 1.45, g.pos.z + h * 0.55), new V3(tgt.x, tgt.y + 1.2, tgt.z), clamp(0.5 - d / 90, 0.08, 0.5), 7, g); }
    } else g.state = 'chase';
  }
}

/* =====================================================================
   MISSIONS: engine — step types
   ===================================================================== */
export const MS = { active: null, idx: 0, st: null, timer: null, text: '', target: null, targetV: null, dlg: null, mv: null,
  spawned: { v: [], p: [], props: [] }, race: null, taxi: null, goons: [], chasers: [], countdown: 0 };
const fail = r => 'fail:' + r;
const near = (x, z, r) => Math.hypot(player.pos.x - x, player.pos.z - z) < r;
function track(v) { MS.spawned.v.push(v); return v; }
function setTarget(x, z, y) { MS.target = { x, z, y: y ?? Y(x, z) }; }

const STEPS = {
  dialogue: {
    start(s) { MS.dlg = { lines: s.lines, i: 0, t: 0 }; S.cutscene = true; MS.target = null; MS.text = ''; },
    update(s, dt) {
      const d = MS.dlg; d.t += dt;
      if (d.i < d.lines.length && d.t > Math.max(3.2, d.lines[d.i][1].length * 0.065)) advanceDialogue();
      if (d.i >= d.lines.length) { MS.dlg = null; S.cutscene = false; return true; }
    },
  },
  vehicle: {   // get into a (spawned) vehicle
    start(s) {
      if (s.spawn) { const o = s.spawn; MS.mv = track(spawnVehicle(o.type, o.x, o.z, o.h ?? 0, o.paint)); MS.mv.keep = true; if (o.police) MS.mv.siren = false; }
      MS.text = s.text;
    },
    update(s) {
      if (MS.mv.dead) return fail(s.failText || 'The vehicle was destroyed');
      MS.targetV = MS.mv; MS.target = null;
      if (player.vehicle === MS.mv) { MS.targetV = null; return true; }
    },
  },
  drive: {   // reach a point (optionally in the mission vehicle, against the clock, without wrecking it)
    start(s) { MS.timer = s.time ?? null; MS.text = s.text; setTarget(s.x, s.z); if (s.chasers) for (let i = 0; i < s.chasers; i++) spawnChaser(); },
    update(s) {
      if (s.inMission && MS.mv) {
        if (MS.mv.dead) return fail('The vehicle was destroyed');
        if (s.minHealth && MS.mv.health < MS.mv.T.health * s.minHealth) return fail('The car is too damaged');
        if (player.vehicle !== MS.mv) { MS.text = 'Get back in the vehicle.'; MS.targetV = MS.mv; return; }
      }
      MS.text = s.text; MS.targetV = null; setTarget(s.x, s.z);
      if (MS.timer !== null && MS.timer <= 0) return fail('Out of time');
      if (s.carrying && !MS.carrying) return;
      if (near(s.x, s.z, s.r ?? 6) && (!s.inVehicle || player.vehicle)) return true;
    },
  },
  goto: {
    start(s) { MS.text = s.text; MS.timer = s.time ?? null; setTarget(s.x, s.z);
      if (s.prop) { const m = propBox(s.prop, 0.6, 0.45, 0.45); m.position.set(s.x, Y(s.x, s.z) + 0.9, s.z); MS.spawned.props.push(m); MS.propM = m; } },
    update(s, dt) {
      if (MS.propM) MS.propM.rotation.y += dt * 2;
      if (MS.timer !== null && MS.timer <= 0) return fail('Out of time');
      if (near(s.x, s.z, s.r ?? 2.5) && Math.abs(player.pos.y - MS.target.y) < 3 && (!s.onFoot || !player.vehicle)) {
        if (MS.propM) { scene.remove(MS.propM); MS.propM = null; MS.carrying = true; sfx.pickupSfx(); } return true;
      }
    },
  },
  chase: {   // stop a fleeing vehicle
    start(s) { const o = s.spawn, d = spawnOnRoad(o.type, o.x, o.z, o.paint, FleeAI); const v = track(d.v); MS.chaseV = v; MS.chaseD = d; v.health *= s.healthMul ?? 1; MS.text = s.text; },
    update(s, dt) {
      const v = MS.chaseV; MS.targetV = v; MS.target = null; if (v.ai === MS.chaseD) MS.chaseD.drive(dt);
      if (v.dead || v.health < v.T.health * 0.25) { if (v.ai) v.ai.bail(v.pos); MS.targetV = null; return true; }
      if (v.pos.distanceTo(player.pos) > 350) return fail('The target got away');
    },
  },
  escape: {
    start(s) { MS.text = s.text || 'Lose the police.'; MS.target = null; const TH = [0, 1, 5, 12, 22, 35]; if (wanted.level < s.stars) addCrime(TH[s.stars] - wanted.points + 0.1); MS.escT = 0; },
    update(s, dt) { MS.escT += dt; return MS.escT > 1 && wanted.level === 0 ? true : undefined; },
  },
  exitVehicle: { start(s) { MS.text = s.text; MS.target = null; }, update() { if (!player.vehicle) { if (MS.mv) MS.mv.keep = false; return true; } } },
  eliminate: {
    start(s) { MS.text = s.text; MS.goons = []; for (let i = 0; i < s.count; i++) { const a = i / s.count * Math.PI * 2; const g = spawnGoon(s.x + Math.cos(a) * rr(3, s.spread ?? 8), s.z + Math.sin(a) * rr(3, s.spread ?? 8)); MS.goons.push(g); MS.spawned.p.push(g); } setTarget(s.x, s.z); },
    update(s, dt) {
      updateGoons(MS.goons, dt);
      const left = MS.goons.filter(g => !g.ko && peds.includes(g)).length;
      MS.text = `${s.text} (${left} left)`; MS.target = left ? MS.target : null;
      if (!left) return true;
    },
  },
  race: {
    start(s) {
      const cps = s.cps.map(([x, z]) => ({ x, z }));
      MS.race = { cps, i: 0, t: 0, racers: [], countdown: 3.5, finished: [] };
      const pv = player.vehicle; const h = pv ? pv.heading : 0, fx = Math.sin(h), fz = Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
      for (let k = 0; k < (s.racers ?? 3); k++) {   // single file behind the player, on the same lane
        const d = spawnOnRoad(pick(['sports', 'sports', 'sedan', 'moto']), pv.pos.x - fx * (k + 1) * 8, pv.pos.z - fz * (k + 1) * 8, undefined, RacerAI);
        track(d.v); MS.race.racers.push(d);
      }
      S.countdown = true;
    },
    update(s, dt) {
      const R = MS.race;
      if (R.countdown > 0) { R.countdown -= dt; MS.text = R.countdown > 0.5 ? `Get ready… ${Math.ceil(R.countdown - 0.5)}` : 'GO!'; if (R.countdown <= 0) S.countdown = false; for (const d of R.racers) { d.ctl.throttle = 0; d.ctl.handbrake = true; } return; }
      R.t += dt;
      const total = R.cps.length;
      for (const d of R.racers) {   // AI racers chase their next checkpoint, with mild rubber-banding
        if (d.v.dead || d.gone || d.v.ai !== d) continue;
        const cp = R.cps[Math.min(d.cp, total - 1)];
        const lead = d.cp - R.i; d.band = lead > 0 ? 0.9 : lead < 0 ? 1.1 : 1;   // gentle rubber-banding
        if (d.cp < total) d.drive(dt); else { d.ctl.throttle = d.v.vF > 0.5 ? -1 : 0; d.ctl.handbrake = true; }
        if (Math.hypot(d.v.pos.x - cp.x, d.v.pos.z - cp.z) < 16 && d.cp < total) { d.cp++; if (d.cp === total) R.finished.push(d); }
      }
      const cp = R.cps[R.i];
      if (!player.vehicle) MS.text = 'Get back in a vehicle!';
      else if (Math.hypot(player.pos.x - cp.x, player.pos.z - cp.z) < 13) { R.i++; sfx.pickupSfx(); if (R.i === total) {
        R.place = R.finished.length + 1; return s.mustWin && R.place > 1 ? fail(`You finished ${ordinal(R.place)}`) : true; } }
      const pos = 1 + R.racers.filter(d => !d.v.dead && (d.cp > R.i || (d.cp === R.i && Math.hypot(d.v.pos.x - cp.x, d.v.pos.z - cp.z) < Math.hypot(player.pos.x - cp.x, player.pos.z - cp.z)))).length;
      if (player.vehicle) MS.text = `Checkpoint ${R.i + 1}/${total}   ·   Position ${ordinal(pos)}/${R.racers.length + 1}`;
      MS.target = null; MS.checkpoint = R.cps[R.i];
    },
  },
  taxi: {   // chain of fares until you fail one or leave the cab
    start(s) { MS.taxi = { fares: 0, earned: 0, phase: 'find', t: 0, away: 0 }; nextFare(); },
    update(s, dt) {
      const T = MS.taxi;
      if (!player.vehicle || player.vehicle !== MS.mv) { T.away += dt; MS.text = 'Get back in the taxi.'; MS.targetV = MS.mv; if (T.away > 10 || MS.mv.dead) return 'end'; return; }
      T.away = 0; MS.targetV = null;
      if (T.phase === 'pickup') {
        MS.text = `Pick up the passenger.   Fares: ${T.fares}  ·  $${T.earned}`; setTarget(T.from.x, T.from.z);
        if (T.ped && near(T.from.x, T.from.z, 8) && player.vehicle.speed < 3) { const i = peds.indexOf(T.ped); if (i >= 0) peds.splice(i, 1); T.phase = 'drop'; MS.timer = T.limit; sfx.door(); }
      } else {
        MS.text = `Take the passenger to the marker.   Fares: ${T.fares}  ·  $${T.earned}`; setTarget(T.to.x, T.to.z);
        if (MS.timer <= 0) return 'end';
        if (near(T.to.x, T.to.z, 8) && player.vehicle.speed < 3) {
          const fare = Math.round(40 + T.dist * 0.35 + Math.max(0, MS.timer) * 2); T.earned += fare; T.fares++; S.money += fare; sfx.pickupSfx();
          emit('toast', `Fare paid: $${fare}`, 2); nextFare();
        }
      }
    },
  },
  wait: { start(s) { MS.waitT = s.t; MS.text = s.text || ''; }, update(s, dt) { return (MS.waitT -= dt) <= 0; } },
};
function nextFare() {
  const T = MS.taxi, p = player.pos;
  const pick2 = (lo, hi, from) => { const c = pnodes.filter(n => { const d = Math.hypot(n.x - from.x, n.z - from.z); return d > lo && d < hi; }); return pick(c.length ? c : pnodes); };
  T.from = pick2(120, 320, p); T.to = pick2(300, 650, T.from); T.dist = Math.hypot(T.to.x - T.from.x, T.to.z - T.from.z);
  T.limit = Math.round(T.dist / 11 + 25); T.phase = 'pickup'; MS.timer = null;
  T.ped = spawnPedAt(T.from.x, T.from.z); T.ped.state = 'react'; T.ped.timer = 9999; T.ped.hostile = true;   // waits, doesn't flee
}
function spawnChaser() {
  const pv = player.vehicle || player, a = rand() * Math.PI * 2;
  const v = track(spawnVehicle('sedan', pv.pos.x + Math.cos(a) * 70, pv.pos.z + Math.sin(a) * 70, a + Math.PI, 0x1a1a1a)); MS.chasers.push(new ChaserDriver(v));
}
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][n] || 'th');

/* =====================================================================
   MISSIONS: engine — run, pass, fail
   ===================================================================== */
export function startMission(m) {
  if (MS.active || wanted.level > 0) { emit('toast', wanted.level > 0 ? 'Lose the police first.' : 'Finish the current job first.'); return; }
  MS.active = m; MS.idx = -1; MS.carrying = false; MS.mv = null; MS.chasers = []; MS.goons = []; MS.race = null; MS.taxi = null; MS.checkpoint = null;
  emit('missionStart', m); nextStep();
}
function nextStep() {
  MS.idx++; MS.timer = null; MS.target = null; MS.targetV = null; MS.checkpoint = null;
  const s = MS.active.steps[MS.idx];
  if (!s) { pass(); return; }
  MS.st = s; STEPS[s.type].start(s);
}
function cleanup(keepPlayerVehicle = true) {
  for (const v of MS.spawned.v) {
    if (v.ai && !v.ai.isPlayer && v.ai.gone !== undefined) { v.ai.gone = true; v.ai = null; if (v.driver && !v.driver.isPlayer) v.driver = null; }
    v.keep = false;
    if (!(keepPlayerVehicle && player.vehicle === v) && !inView(v.pos.x, 1, v.pos.z, 4)) { const i = vehicles.indexOf(v); if (i >= 0 && !v.driver) removeVehicle(i); }
  }
  for (const p of MS.spawned.p) { p.hostile = false; if (!p.ko) { p.state = 'flee'; p.timer = 8; } }
  for (const m of MS.spawned.props) scene.remove(m);
  MS.spawned = { v: [], p: [], props: [] }; MS.dlg = null; S.cutscene = false; S.countdown = false;
  MS.active = null; MS.st = null; MS.text = ''; MS.timer = null; MS.target = null; MS.targetV = null; MS.checkpoint = null; MS.chasers = []; MS.goons = []; MS.propM = null;
}
function pass() {
  const m = MS.active, first = !P().done[m.id];
  let reward = typeof m.reward === 'function' ? m.reward(first) : first ? m.reward : (m.repeatReward ?? 0);
  if (m.race && MS.race) { const t = MS.race.t; if (!P().best[m.id] || t < P().best[m.id]) P().best[m.id] = t; }
  P().done[m.id] = true; S.money += reward;
  emit('missionPassed', m, reward); cleanup(); emit('save');
}
function failMission(reason) { const m = MS.active; emit('missionFailed', m, reason); cleanup(); }
function endActivity() { const m = MS.active, T = MS.taxi; if (T && T.earned > P().taxiBest) P().taxiBest = T.earned; emit('missionPassed', m, 0, T ? `${T.fares} fares · $${T.earned} earned` : ''); cleanup(); emit('save'); }
on('playerDied', () => { if (MS.active) failMission('You were hospitalized'); });
on('playerBusted', () => { if (MS.active) failMission('You were arrested'); });
export function advanceDialogue() { if (!MS.dlg) return; MS.dlg.i++; MS.dlg.t = 0; }
export const cancelMission = () => { if (MS.active && !MS.dlg) failMission('Cancelled'); };

/* =====================================================================
   STORY: Rae Calloway is back in Harbor City to save her aunt's garage
   ===================================================================== */
export const GIVERS = {};
export const MISSIONS = [];
export const ACTIVITIES = [];
export function buildMissions() {
  const dex = spot(50, 50), garage = spot(-450, -50), port = { x: -822, z: 200 }, reyes = { x: stations[0].x, z: stations[0].z + 10 };
  const buyer = spot(250, 300), ind = blocks.filter(b => b.district === 'industrial')[5], wh = { x: ind.x0 + 3.4, z: ind.cz };
  const st2 = stations[1];
  Object.assign(GIVERS, { dex: { ...dex, name: 'Dex', letter: 'D' }, marta: { ...garage, name: 'Marta', letter: 'M' }, harlow: { ...port, name: 'Harlow', letter: 'H' }, reyes: { ...reyes, name: 'Reyes', letter: 'R' } });
  GIVERS.garage = garage;
  const L = (who, text) => [who, text];
  MISSIONS.push(
    { id: 'm1', title: 'Homecoming', giver: 'dex', reward: 500, steps: [
      { type: 'dialogue', lines: [L('Dex', 'Rae Calloway! Five years gone and you still walk like you own the street.'), L('Rae', 'Dex. Good to see a friendly face. How bad is it?'),
        L('Dex', "Your aunt's garage is in trouble. Real trouble. You drive — I'll explain on the way.")] },
      { type: 'vehicle', spawn: { type: 'sedan', ...dex.car, paint: 0x3b5b7a }, text: "Get in Dex's car." },
      { type: 'drive', x: garage.car.x, z: garage.car.z, r: 8, inMission: true, text: 'Drive to Calloway Garage in Westbrook.' },
      { type: 'dialogue', lines: [L('Marta', "Rae, honey. I didn't want you to find out like this."), L('Marta', 'I borrowed from Vince Harlow to keep the doors open. Now he wants fifty grand — or the garage.'),
        L('Rae', 'Then we pay him. One job at a time.'), L('Dex', 'I know people who need a fast driver. Find me downtown when you are ready.'), L('Marta', 'The garage is yours to use, kid. Save your progress there any time.')] },
    ] },
    { id: 'm2', title: 'Test Drive', giver: 'dex', requires: ['m1'], reward: 800, steps: [
      { type: 'dialogue', lines: [L('Dex', 'A client left a sports car downtown. He wants it at the garage — fast, and without a scratch.'), L('Rae', 'Fast and clean. My two favourite words.')] },
      { type: 'vehicle', spawn: { type: 'sports', x: 105.6, z: -160, h: Math.PI, paint: 0xd8a419 }, text: 'Get in the sports car.' },
      { type: 'drive', x: garage.car.x, z: garage.car.z, r: 8, inMission: true, time: 150, minHealth: 0.6, text: 'Deliver the car to Calloway Garage. Keep it clean!' },
      { type: 'dialogue', lines: [L('Dex', 'Not a scratch. Okay, I am impressed.'), L('Dex', 'Word travels. Vince Harlow wants to meet you at the docks.')] },
    ] },
    { id: 'm3', title: 'Dockside Pickup', giver: 'harlow', requires: ['m2'], reward: 1200, steps: [
      { type: 'dialogue', lines: [L('Harlow', "So you're Marta's niece. You want to work off her debt? Fine."), L('Harlow', "There's a package on the quay. Take it to my buyer in Midtown. Don't open it. Don't be late.")] },
      { type: 'goto', x: -822, z: 120, prop: 0x8b6a48, text: 'Pick up the package on the quay.' },
      { type: 'drive', x: buyer.x, z: buyer.z, r: 4, time: 140, text: 'Deliver the package to the buyer in Midtown.' },
      { type: 'dialogue', lines: [L('Nico', "Harlow's new runner? You're early. I like early."), L('Rae', "Don't get used to me.")] },
    ] },
    { id: 'm4', title: 'Rival Runner', giver: 'harlow', requires: ['m3'], reward: 1500, steps: [
      { type: 'dialogue', lines: [L('Harlow', 'The Saltline crew hijacked my delivery truck. It is leaving Ironworks right now.'), L('Harlow', "Stop that truck. I don't care how.")] },
      { type: 'vehicle', spawn: { type: 'sedan', x: -818, z: 212, h: Math.PI, paint: 0x6b2d7a }, text: 'Get in the car.' },
      { type: 'chase', spawn: { type: 'truck', x: -601.75, z: 300, h: 0, paint: 0x2e6da4 }, healthMul: 0.7, text: 'Stop the stolen truck!' },
      { type: 'dialogue', lines: [L('Harlow', 'Truck is back where it belongs. Maybe you are worth the trouble, Calloway.')] },
    ] },
    { id: 'm5', title: 'Heat Wave', giver: 'harlow', requires: ['m4'], reward: 2000, steps: [
      { type: 'dialogue', lines: [L('Harlow', 'Cops are sniffing around my docks. I need them busy somewhere else.'), L('Harlow', 'Borrow a cruiser from the Midtown station. Give them a chase, lose them, ditch the car.')] },
      { type: 'vehicle', spawn: { type: 'police', x: st2.x - 3.4 - 1.4, z: st2.z + 4, h: Math.PI, police: true }, text: 'Steal the police cruiser.' },
      { type: 'escape', stars: 3, text: 'Lose the police!' },
      { type: 'exitVehicle', text: 'Ditch the cruiser.' },
      { type: 'dialogue', lines: [L('Harlow', 'Every cop in the city chasing ghosts. Beautiful work.')] },
    ] },
    { id: 'm6', title: 'Street Cred', giver: 'dex', requires: ['m3'], race: true, reward: 2500, steps: [
      { type: 'dialogue', lines: [L('Dex', 'The Saltline racers think they own these streets.'), L('Dex', 'Show them what a real stunt driver can do. First place or nothing.')] },
      { type: 'vehicle', spawn: { type: 'sports', x: 101.75, z: 330, h: Math.PI, paint: 0xb32428 }, text: 'Get in the race car.' },
      { type: 'race', mustWin: true, racers: 3, cps: [[100, 100], [300, 100], [300, -200], [-100, -200], [-100, 200], [100, 200], [100, 300]] },
      { type: 'dialogue', lines: [L('Dex', 'Did you see their faces? Priceless.')] },
    ] },
    { id: 'm7', title: 'Paper Trail', giver: 'reyes', requires: ['m5'], reward: 3000, steps: [
      { type: 'dialogue', lines: [L('Reyes', "Detective Sam Reyes. Relax, I'm not here about the cruiser."), L('Reyes', 'Councilwoman Strand is buying up the waterfront, and Harlow does her dirty work.'),
        L('Reyes', 'Her files are in a warehouse in Ironworks. It is guarded. I need those files.'), L('Rae', 'And if I get them, my aunt keeps her garage.')] },
      { type: 'drive', x: wh.x, z: wh.z, r: 25, text: 'Go to the Ironworks warehouse.' },
      { type: 'eliminate', x: wh.x - 3, z: wh.z, count: 4, spread: 9, text: 'Take out the guards' },
      { type: 'goto', x: wh.x, z: wh.z + 6, prop: 0xe8e2c4, text: 'Grab the files.' },
      { type: 'escape', stars: 2, text: 'Lose the police!' },
      { type: 'drive', x: reyes.x, z: reyes.z, r: 4, text: 'Bring the files to Detective Reyes.' },
      { type: 'dialogue', lines: [L('Reyes', 'Land deals, payoffs… and a cargo ship. This is bigger than I thought.')] },
    ] },
    { id: 'm8', title: 'The Pier', giver: 'reyes', requires: ['m7'], reward: 3500, steps: [
      { type: 'dialogue', lines: [L('Reyes', "The files point to a ship at Port Calloway. The manifest is in a lock-box on the quay."), L('Reyes', "Harlow's men are crawling all over the docks. Go in by water — there's a boat at the pier.")] },
      { type: 'drive', x: 300, z: 700, r: 6, text: 'Go to the Saltline pier.' },
      { type: 'vehicle', spawn: { type: 'boat', x: 311, z: 770, h: Math.PI, paint: 0x1f4e9c }, text: 'Take the speedboat.' },
      { type: 'drive', x: -912, z: 150, r: 14, inMission: true, text: 'Sail to the cargo ship at Port Calloway.' },
      { type: 'eliminate', x: -860, z: 150, count: 3, spread: 6, text: "Deal with Harlow's guards" },
      { type: 'goto', x: -850, z: 160, prop: 0x9aa4b0, text: 'Grab the manifest from the lock-box.' },
      { type: 'escape', stars: 2, text: 'Lose the police!' },
      { type: 'dialogue', lines: [L('Reyes', 'The manifest ties Strand to the smuggling. One more stop, Calloway.')] },
    ] },
    { id: 'm9', title: 'Rising Tide', giver: 'marta', requires: ['m6', 'm8'], reward: 10000, steps: [
      { type: 'dialogue', lines: [L('Marta', "Rae… Harlow's men came by. They know what you found."), L('Rae', 'Then it ends tonight. Reyes gets the evidence and Strand goes down.'),
        L('Marta', 'Take my old car. And Rae — drive like your father taught you.')] },
      { type: 'vehicle', spawn: { type: 'sedan', ...garage.car, paint: 0xc75b1c }, text: "Get in Marta's car." },
      { type: 'drive', x: reyes.x, z: reyes.z, r: 6, time: 180, chasers: 3, text: "Get the evidence to Reyes — Harlow's crew is on your tail!" },
      { type: 'dialogue', lines: [L('Reyes', "Files, manifest, payoffs. Strand's finished, and Harlow's debt ledger goes into evidence."), L('Marta', 'The garage is ours again.'),
        L('Rae', 'Welcome home, Calloway.'), L('Narrator', 'THE END — but Harbor City never sleeps. Keep exploring!')] },
    ] },
  );
  // street races (side activity)
  const race = (id, title, at, h, cps, reward) => ({ id, title, at, race: true, side: true, reward, repeatReward: 300, steps: [
    { type: 'vehicle', spawn: { type: 'sports', x: at.x, z: at.z, h, paint: pick([0xb32428, 0x1f4e9c, 0xd8a419]) }, text: 'Get in the race car.', skipIfInCar: true },
    { type: 'race', mustWin: true, racers: 3, cps }] });
  ACTIVITIES.push(
    race('r1', 'Street Race: Downtown Dash', { x: -98.25, z: 330 }, Math.PI, [[-100, 100], [100, 100], [100, -300], [-300, -300], [-300, 200], [-100, 200], [-100, 300]], 1000),
    race('r2', 'Street Race: Coastline Loop', { x: 802, z: 420 }, Math.PI, [[800, -500], [600, -700], [-600, -700], [-800, -500], [-800, 400], [-600, 600], [600, 600], [800, 450]], 1500),
    race('r3', 'Street Race: Northgate Sprint', { x: 501.75, z: -330 }, Math.PI, [[500, -600], [300, -600], [300, -300], [600, -300], [600, -100], [400, -100], [400, -400]], 1200),
    { id: 'taxi', title: 'Taxi Driver', at: spot(50, 450), side: true, reward: 0, activity: true, steps: [
      { type: 'vehicle', spawn: { type: 'sedan', ...spot(50, 450).car, paint: 0xf2c230 }, text: 'Get in the taxi.' }, { type: 'taxi' }] },
  );
  // a race/taxi vehicle step is skipped when the player brings their own car (races only)
  STEPS.vehicle._start = STEPS.vehicle.start;
  STEPS.vehicle.start = s => { if (s.skipIfInCar && player.vehicle && player.vehicle.T.kind !== 'boat') { MS.mv = player.vehicle; MS.text = s.text; return; } STEPS.vehicle._start(s); };
  buildRamps(); buildReels();
}

/* =====================================================================
   SIDE: stunt jumps (ramps) + collectibles (lost film reels)
   ===================================================================== */
const rampMat = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 });
function addRamp(x, z, h, len = 11, wid = 5, top = 2.4) {
  const base = groundAt(x - Math.sin(h) * len / 2, z - Math.cos(h) * len / 2, 1, 0.5);
  const r = { x, z, h, len, wid, top, base }; ramps.push(r);
  // wedge mesh: rises along local +z
  const L = len / 2, W = wid / 2, v = [[-W, 0, -L], [W, 0, -L], [W, 0, L], [-W, 0, L], [-W, top, L], [W, top, L]];
  const tri = [[0, 2, 1], [0, 3, 2], [0, 1, 5], [0, 5, 4], [3, 4, 5], [3, 5, 2], [0, 4, 3], [1, 2, 5]];
  const pos = []; for (const t of tri) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  const m = new THREE.Mesh(g, rampMat); m.position.set(x, base, z); m.rotation.y = h; m.castShadow = m.receiveShadow = true; scene.add(m);
}
function buildRamps() {
  addRamp(100, 646, -Math.PI / 2); addRamp(620, 646, Math.PI / 2);   // beach
  addRamp(0, -728, Math.PI);                                          // north shoulder, toward the hills
  addRamp(-826, 470, Math.PI, 11, 5, 2.6);                            // along the quay
  addRamp(845, 200, 0);                                               // east shoulder
  addRamp(300, 712, 0, 9, 4, 1.8);                                    // off the end of the pier into the sea
}
const jump = { armed: null, air: false, from: new V3(), maxH: 0 };
function updateJumps(dt) {
  const v = player.vehicle;
  if (!v || v.T.kind === 'boat') { if (jump.air) { jump.air = false; S.timeScale = 1; } jump.armed = null; return; }
  const onRamp = ramps.find(r => { const dx = v.pos.x - r.x, dz = v.pos.z - r.z; return Math.abs(dx * Math.sin(r.h) + dz * Math.cos(r.h)) < r.len / 2 + 1 && Math.abs(dx * Math.cos(r.h) - dz * Math.sin(r.h)) < r.wid / 2 + 1; });
  if (onRamp && v.speed > 15) { jump.armed = onRamp; jump.from.copy(v.pos); }
  if (jump.armed && !v.grounded && !jump.air && v.pos.distanceTo(jump.from) < 12) { jump.air = true; jump.maxH = 0; S.timeScale = 0.45; }
  if (jump.air) {
    jump.maxH = Math.max(jump.maxH, v.pos.y - baseGround(v.pos.x, v.pos.z));
    if (v.grounded || v.inWater) {
      jump.air = false; S.timeScale = 1; const dist = Math.hypot(v.pos.x - jump.from.x, v.pos.z - jump.from.z), id = ramps.indexOf(jump.armed);
      if (dist > 24 && !P().jumps[id]) { P().jumps[id] = true; S.money += 500; emit('stuntJump', dist, true); }
      else emit('stuntJump', dist, false);
      jump.armed = null;
    }
  } else if (!onRamp && jump.armed && v.pos.distanceTo(jump.from) > 15) jump.armed = null;
}
export const reels = [];
function buildReels() {
  const pts = [[300, 806], [-44, -42], [356, -244], [-344, -444], [556, 256], [-144, 356], [-450, 660], [900, 662], [780, 575], [-850, 540],
    [-400, -900], [400, -950], [930, -300], [0, -880], [-826, -300], [-826, 380], [-620, 470], [640, -640], [-760, -640], [160, 690]];
  const geo = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16).rotateX(Math.PI / 2);
  pts.forEach(([x, z], i) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe0c341, emissive: 0xe0a020, emissiveIntensity: 0.5, metalness: 0.7, roughness: 0.3 }));
    const y = Y(x, z) + 0.9; m.position.set(x, y, z); scene.add(m); reels.push({ i, x, z, y, m });
  });
}
function updateReels(dt) {
  const t = performance.now() / 1000;
  for (const r of reels) {
    if (P().reels[r.i]) { r.m.visible = false; continue; }
    r.m.rotation.y = t * 2.5; r.m.position.y = r.y + Math.sin(t * 2 + r.i) * 0.12;
    if (Math.hypot(player.pos.x - r.x, player.pos.z - r.z) < (player.vehicle ? 3 : 1.4) && Math.abs(player.pos.y + 0.9 - r.y) < 2.5) {
      P().reels[r.i] = true; S.money += 250; sfx.pickupSfx();
      const n = Object.keys(P().reels).length; emit('toast', `Film reel found: ${n}/${reels.length}  (+$250)`, 3);
      if (n === reels.length) { S.money += 5000; emit('toast', 'All film reels found! +$5,000', 5); }
      emit('save');
    }
  }
}

/* =====================================================================
   MISSIONS: per-frame update, interaction, markers & blips
   ===================================================================== */
const giverMarks = {}, actMarks = [], giverPeds = {};
const LOOKS = { dex: { shirt: 0xd35400, pants: 0x2c3e50, skin: 0x8d5524, hair: 0x1b1b1b }, marta: { shirt: 0x7b4fa0, pants: 0x5d4037, skin: 0xe0ac69, hair: 0x9e9e9e },
  harlow: { shirt: 0xecebe4, pants: 0xecebe4, skin: 0xf1c27d, hair: 0x3e2723 }, reyes: { shirt: 0xb39b74, pants: 0x34495e, skin: 0xc68642, hair: 0x1b1b1b } };
function updateGiverPeds() {   // story characters stand at their markers while the player is nearby
  for (const key of Object.keys(LOOKS)) {
    const g = GIVERS[key], show = !!giverMission(key) && Math.hypot(player.pos.x - g.x, player.pos.z - g.z) < 120;
    let pd = giverPeds[key];
    if (pd && (!peds.includes(pd) || pd.ko)) pd = giverPeds[key] = null;
    if (show && !pd) { pd = giverPeds[key] = spawnPedAt(g.x + 1.6, g.z); Object.assign(pd, { keep: true, state: 'idle', colors: { ...LOOKS[key] }, hp: 9999, scale: key === 'harlow' ? 1.08 : 1 }); pd.facing = -Math.PI / 2; }
    if (!show && pd && !MS.active) { const i = peds.indexOf(pd); if (i >= 0) peds.splice(i, 1); giverPeds[key] = null; }
  }
}
export function available() {
  return MISSIONS.filter(m => !P().done[m.id] && (m.requires || []).every(r => P().done[r]));
}
function giverMission(key) { return available().find(m => m.giver === key); }
export function updateMissions(dt) {
  updateJumps(dt); updateReels(dt); updateGiverPeds();
  // markers for available missions and activities
  for (const key of ['dex', 'marta', 'harlow', 'reyes']) {
    const g = GIVERS[key], m = giverMission(key); giverMarks[key] ||= beacon(COL.mission);
    giverMarks[key].visible = !!m && !MS.active; giverMarks[key].position.set(g.x, Y(g.x, g.z), g.z);
  }
  ACTIVITIES.forEach((a, i) => { actMarks[i] ||= beacon(COL.activity); actMarks[i].visible = !MS.active; actMarks[i].position.set(a.at.x, Y(a.at.x, a.at.z), a.at.z); });
  for (const d of MS.chasers) d.drive(dt);
  if (MS.active) {
    if (MS.timer !== null && !S.cutscene) MS.timer -= dt;
    const r = STEPS[MS.st.type].update(MS.st, dt);
    if (r === true) nextStep();
    else if (r === 'end') endActivity();
    else if (typeof r === 'string' && r.startsWith('fail:')) failMission(r.slice(5));
  }
  // objective beacon / vehicle arrow / race checkpoint
  const t = MS.active ? (MS.targetV ? null : MS.target) : null;
  objMarker.visible = !!t; if (t) objMarker.position.set(t.x, t.y, t.z);
  arrow.visible = !!(MS.active && MS.targetV); if (arrow.visible) { const v = MS.targetV; arrow.position.set(v.pos.x, v.pos.y + v.T.hgt + 1.2 + Math.sin(performance.now() / 200) * 0.2, v.pos.z); }
  const cp = MS.active && MS.checkpoint; cpMarker.visible = !!cp; if (cp) cpMarker.position.set(cp.x, Y(cp.x, cp.z), cp.z);
}
// what pressing E would do here (used by the HUD prompt and the key binding)
export function interactable() {
  if (MS.active || player.dead) return null;
  for (const key of ['dex', 'marta', 'harlow', 'reyes']) { const g = GIVERS[key], m = giverMission(key); if (m && near(g.x, g.z, 2.5) && !player.vehicle) return { label: `Start mission: ${m.title}`, go: () => startMission(m) }; }
  for (const a of ACTIVITIES) if (near(a.at.x, a.at.z, a.race ? 6 : 3)) {
    const best = P().best[a.id]; return { label: `${a.title}${best ? `  (best ${best.toFixed(1)} s)` : ''}`, go: () => startMission(a) };
  }
  return null;
}
// minimap blips: { x, z, color, label }
export function blips() {
  const out = [];
  if (!MS.active) {
    for (const key of ['dex', 'marta', 'harlow', 'reyes']) { const m = giverMission(key); if (m) out.push({ x: GIVERS[key].x, z: GIVERS[key].z, color: '#ffd34d', label: GIVERS[key].letter }); }
    for (const a of ACTIVITIES) out.push({ x: a.at.x, z: a.at.z, color: '#c77dff', label: a.race ? 'R' : 'T' });
  }
  return out;
}
export function objectivePoint() {
  if (!MS.active) return null;
  if (MS.targetV) return MS.targetV.pos;
  if (MS.checkpoint) return MS.checkpoint;
  return MS.target;
}
