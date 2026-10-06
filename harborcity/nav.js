// nav.js — road graph (nodes, directed edges, lanes, turn curves), traffic lights, sidewalk graph for pedestrians
import * as THREE from 'three';
import { CFG, rand, scene, inst, addCollider, timeU } from './core.js';
import { XL, ZL, blockGrid, ringPath } from './world.js';

/* =====================================================================
   NAV: road graph
   ===================================================================== */
// Nodes are grid intersections ('grid', with traffic lights) and junctions where grid roads meet the highway ('ring').
// Edges are directed centre-line polylines between nodes; lanes are offset to the right (right-hand traffic).
export const nodes = [], edges = [];
const nodeMap = new Map();
function addNode(x, z, type, ringAxis) {
  const k = x + ',' + z; if (nodeMap.has(k)) return nodeMap.get(k);
  const n = { id: nodes.length, x, z, type, ringAxis, out: [], in: [], phase: rand() * 31 };
  nodes.push(n); nodeMap.set(k, n); return n;
}
const getNode = (x, z) => nodeMap.get(x + ',' + z);
function addEdge(a, b, pts, ring) {
  const e = { id: edges.length, from: a, to: b, pts, ring, lanes: {} };
  edges.push(e); a.out.push(e); b.in.push(e); return e;
}
export function buildRoadGraph() {
  for (const X of XL) for (const Z of ZL) addNode(X, Z, 'grid');
  for (const X of XL) { addNode(X, -700, 'ring', 'x'); addNode(X, 600, 'ring', 'x'); }
  for (const Z of ZL) { addNode(-800, Z, 'ring', 'z'); addNode(800, Z, 'ring', 'z'); }
  const both = (a, b, ring, pts) => { addEdge(a, b, pts, ring); addEdge(b, a, pts.slice().reverse(), ring); };
  for (const X of XL) { const st = [-700, ...ZL, 600]; for (let i = 0; i < st.length - 1; i++) both(getNode(X, st[i]), getNode(X, st[i + 1]), false, [[X, st[i]], [X, st[i + 1]]]); }
  for (const Z of ZL) { const st = [-800, ...XL, 800]; for (let i = 0; i < st.length - 1; i++) both(getNode(st[i], Z), getNode(st[i + 1], Z), false, [[st[i], Z], [st[i + 1], Z]]); }
  // highway: split the loop polyline at each junction
  const P = ringPath(2), ringNodes = nodes.filter(n => n.type === 'ring');
  const idxOf = n => { let bi = 0, bd = Infinity; P.forEach(([x, z], i) => { const d = (x - n.x) ** 2 + (z - n.z) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
  const order = ringNodes.map(n => [idxOf(n), n]).sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < order.length; k++) {
    const [ia, a] = order[k], [ib, b] = order[(k + 1) % order.length];
    const pts = [[a.x, a.z]];
    for (let i = (ia + 1) % P.length; i !== ib; i = (i + 1) % P.length) pts.push(P[i]);
    pts.push([b.x, b.z]);
    both(a, b, true, pts);
  }
}

/* =====================================================================
   NAV: lanes, turn curves, path sampling
   ===================================================================== */
function withCum(pts) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}
// trim a polyline by arc length from both ends
function trim(pts, a, b) {
  const { cum, len } = withCum(pts); const out = [];
  const at = s => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; };
  out.push(at(a)); for (let i = 0; i < pts.length; i++) if (cum[i] > a && cum[i] < len - b) out.push(pts[i]); out.push(at(len - b));
  // densify long straight segments so path tracking has regular points
  const dense = [out[0]];
  for (let i = 1; i < out.length; i++) { const [x0, z0] = out[i - 1], [x1, z1] = out[i], d = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(d / 6));
    for (let k = 1; k <= n; k++) dense.push([x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n]); }
  return dense;
}
const TRIM = { grid: 13, ringFromGrid: 16, ringOnRing: 8 };
export function lanePath(e, off) {
  if (e.lanes[off]) return e.lanes[off];
  const P = e.pts, n = P.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1;
    out.push([P[i][0] - tz / l * off, P[i][1] + tx / l * off]);   // right of travel = (-tz, tx)
  }
  const tr = node => node.type === 'grid' ? TRIM.grid : e.ring ? TRIM.ringOnRing : TRIM.ringFromGrid;
  return (e.lanes[off] = withCum(trim(out, tr(e.from), tr(e.to))));
}
// smooth curve through an intersection from the end of one lane to the start of the next
export function turnPath(p0, d0, p2, d2) {
  const cross = d0[0] * d2[1] - d0[1] * d2[0];
  let c;
  if (Math.abs(cross) < 0.2) c = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
  else { const t = ((p2[0] - p0[0]) * d2[1] - (p2[1] - p0[1]) * d2[0]) / cross; c = [p0[0] + d0[0] * t, p0[1] + d0[1] * t]; }
  const pts = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10, u = 1 - t; pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]]); }
  return withCum(pts);
}
export function dirAt(path, end) {
  const p = path.pts, n = p.length, [a, b] = end ? [p[n - 2], p[n - 1]] : [p[0], p[1]];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}
export function pointAt(path, s) {
  const { pts, cum, len } = path; s = Math.max(0, Math.min(len, s));
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}
// arc-length position of the closest point on a path, searching forward from segment hint i
export function project(path, x, z, i = 0) {
  const { pts, cum } = path; let best = { s: 0, i: 0, d: Infinity };
  for (let k = Math.max(0, i - 1); k < Math.min(pts.length - 1, i + 6); k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), px = ax + dx * t, pz = az + dz * t, d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < best.d) best = { s: cum[k] + t * Math.sqrt(l2), i: k, d };
  }
  best.d = Math.sqrt(best.d); return best;
}
export const axisOf = d => Math.abs(d[0]) > Math.abs(d[1]) ? 'x' : 'z';

/* =====================================================================
   NAV: traffic lights
   ===================================================================== */
// 31 s cycle per intersection: x-axis green 0–11, yellow 11–13.5, 2 s all-red; z-axis green 15.5–26.5, yellow 26.5–29, 2 s all-red.
const CYCLE = 31;
export function lightState(node, axis) {
  const t = (timeU.value + node.phase) % CYCLE;
  if (axis === 'x') return t < 11 ? 'green' : t < 13.5 ? 'yellow' : 'red';
  return t >= 15.5 && t < 26.5 ? 'green' : t >= 26.5 && t < 29 ? 'yellow' : 'red';
}
// pedestrians walking along `axis` may start crossing early in that axis' green phase
export function walkAllowed(node, axis) {
  const t = (timeU.value + node.phase) % CYCLE;
  return axis === 'x' ? t < 7 : t >= 15.5 && t < 22.5;
}
const heads = [];
let lampIM = null;
const LAMP_COL = { red: new THREE.Color(0xff2a1a).multiplyScalar(2.2), yellow: new THREE.Color(0xffb020).multiplyScalar(2.2), green: new THREE.Color(0x30ff70).multiplyScalar(2) };
// static poles/arms/housings go into the instanced world batches; lamps are one dynamic instanced mesh
export function buildLightProps() {
  for (const n of nodes) if (n.type === 'grid') for (const d of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const rx = -d[1], rz = d[0];   // right of travel
    const cx = n.x - d[0] * 9.2 + rx * 8.8, cz = n.z - d[1] * 9.2 + rz * 8.8;
    inst('small', cx, CFG.curb, cz, 0.16, 4.6, 0.16, 0, 0x2c2f33);
    addCollider(cx - 0.1, CFG.curb, cz - 0.1, cx + 0.1, CFG.curb + 4.6, cz + 0.1, false);
    const ax = cx - rx * 1.6, az = cz - rz * 1.6;
    inst('small', ax, 4.55, az, Math.abs(rx) > 0 ? 3.2 : 0.12, 0.12, Math.abs(rz) > 0 ? 3.2 : 0.12, 0, 0x2c2f33);
    const hx = cx - rx * 3.0, hz = cz - rz * 3.0;
    inst('small', hx, 3.55, hz, 0.42, 1.05, 0.42, 0, 0x1c1d20);
    heads.push({ n, axis: axisOf(d), x: hx - d[0] * 0.22, z: hz - d[1] * 0.22, rot: Math.atan2(d[0], d[1]) });
  }
  lampIM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.28, 0.06), new THREE.MeshBasicMaterial({ toneMapped: false }), heads.length);
  lampIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(heads.length * 3), 3);
  scene.add(lampIM);
  updateLights(true);
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);
let lightTimer = 0;
export function updateLights(force = false, dt = 0) {
  if (!lampIM || (!force && (lightTimer -= dt) > 0)) return;
  lightTimer = 0.2;
  heads.forEach((h, i) => {
    const st = lightState(h.n, h.axis), y = 3.55 + (st === 'red' ? 0.85 : st === 'yellow' ? 0.53 : 0.21);
    _q.setFromAxisAngle(_up, h.rot); _m.compose(_p.set(h.x, y, h.z), _q, _s);
    lampIM.setMatrixAt(i, _m); lampIM.setColorAt(i, LAMP_COL[st]);
  });
  lampIM.instanceMatrix.needsUpdate = true; lampIM.instanceColor.needsUpdate = true;
  if (force) lampIM.computeBoundingSphere();
}

/* =====================================================================
   NAV: sidewalk graph (pedestrians)
   ===================================================================== */
// One node per block corner on a walking line 3.5 m in from the kerb; links run along block sides
// and across the zebra crossings at grid intersections.
export const pnodes = [];
const WALK = 3.5;
export function buildSidewalkGraph() {
  const corner = new Map();
  for (const b of blockGrid) {
    if (!b) continue;
    const cs = [[b.x0 + WALK, b.z0 + WALK], [b.x1 - WALK, b.z0 + WALK], [b.x1 - WALK, b.z1 - WALK], [b.x0 + WALK, b.z1 - WALK]]
      .map(([x, z]) => { const p = { id: pnodes.length, x, z, links: [] }; pnodes.push(p); return p; });
    for (let k = 0; k < 4; k++) { const a = cs[k], c = cs[(k + 1) % 4]; a.links.push({ to: c, pts: [[c.x, c.z]] }); c.links.push({ to: a, pts: [[a.x, a.z]] }); }
    corner.set(b.c * 13 + b.r, cs);
  }
  const link = (a, b, pts, node, axis) => {
    a.links.push({ to: b, pts: [...pts, [b.x, b.z]], node, axis });
    b.links.push({ to: a, pts: [...pts.slice().reverse(), [a.x, a.z]], node, axis });
  };
  for (const X of XL) for (const Z of ZL) {
    const c = (X + 800) / 100 - 1, r = (Z + 700) / 100 - 1, n = getNode(X, Z);
    const get = (cc, rr, k) => corner.get(cc * 13 + rr)?.[k];
    const NW = get(c, r, 2), NE = get(c + 1, r, 3), SW = get(c, r + 1, 1), SE = get(c + 1, r + 1, 0);
    if (NW && NE) link(NW, NE, [[X - 7.5, Z - 8.6], [X + 7.5, Z - 8.6]], n, 'x');
    if (SW && SE) link(SW, SE, [[X - 7.5, Z + 8.6], [X + 7.5, Z + 8.6]], n, 'x');
    if (NW && SW) link(NW, SW, [[X - 8.6, Z - 7.5], [X - 8.6, Z + 7.5]], n, 'z');
    if (NE && SE) link(NE, SE, [[X + 8.6, Z - 7.5], [X + 8.6, Z + 7.5]], n, 'z');
  }
}
