// world.js — city layout, terrain, procedural generation, render chunks, static collision queries
import * as THREE from 'three';
import { CFG, Q, V3, clamp, lerp, smooth, rand, rr, ri, pick, vnoise, fbm, scene, camera, M, KINDS, PAL,
  batches, inst, addCollider, queryColliders, solid, building } from './core.js';

/* =====================================================================
   WORLD: layout functions (highway ring, terrain, road grid, blocks)
   ===================================================================== */
export function ringSD(x, z) {   // signed distance to the highway centreline (rounded rectangle)
  const R = CFG.ring; const qx = Math.abs(x - R.cx) - R.hx + R.r, qz = Math.abs(z - R.cz) - R.hz + R.r;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - R.r;
}
export function terrainH(x, z) {
  const d = ringSD(x, z); if (d < 16) return 0;
  const n = fbm(x * 0.0035 + 11.3, z * 0.0035 - 7.1);
  const edge = smooth(1080, 1300, Math.max(Math.abs(x), Math.abs(z))) * (1 - smooth(250, 520, z));
  const eastF = 1 - 0.45 * smooth(600, 800, x) * smooth(-750, -550, z);
  const hill = smooth(16, 170, d) * (10 + 85 * n * n) * eastF + edge * 140;
  const beach = d < 140 ? -0.012 * (d - 16) : -1.49 - 0.07 * (d - 140);
  const sea = Math.max(beach, -10);
  const quay = d < 100 ? 0 : -10 * smooth(100, 108, d);
  const rock = hill * 0.45 * (1 - smooth(70, 130, d)) - 10 * smooth(100, 170, d);
  const west = lerp(quay, rock, smooth(-320, -420, z));
  const wS = smooth(560, 640, z), wW = smooth(-760, -830, x) * (1 - wS);
  return hill * (1 - wS - wW) + sea * wS + west * wW;
}
export const TS = 2600, TN = 325, TSTEP = TS / TN, TV = TN + 1;
export const heights = new Float32Array(TV * TV);
export function sampleH(x, z) {
  const fx = clamp((x + TS / 2) / TSTEP, 0, TN - 0.001), fz = clamp((z + TS / 2) / TSTEP, 0, TN - 0.001);
  const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * TV + ix;
  const a = heights[i], b = heights[i + 1], c = heights[i + TV], d = heights[i + TV + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
export const _tc = [0, 0, 0];
export function terrainColor(x, z, h) {
  const d = ringSD(x, z);
  const set = (r, g, b) => { _tc[0] = r; _tc[1] = g; _tc[2] = b; return _tc; };
  if (d < 16) return set(0.36, 0.45, 0.27);
  const wS = smooth(560, 640, z), wW = smooth(-760, -830, x) * (1 - wS);
  if (wW > 0.5 && z > -360 && d < 101) return set(0.5, 0.5, 0.48);
  if (h < CFG.waterY - 0.05) { const k = clamp(1 + h / 14, 0.45, 1); return set(0.62 * k, 0.56 * k, 0.4 * k); }
  if (h < 0.7 && (wS > 0.3 || wW > 0.3)) return set(0.86, 0.78, 0.57);
  const n = vnoise(x * 0.045, z * 0.045), n2 = vnoise(x * 0.2 + 3, z * 0.2);
  let r = lerp(0.34, 0.24, n) + n2 * 0.03, g = lerp(0.49, 0.38, n) + n2 * 0.03, b = lerp(0.22, 0.17, n);
  const rk = smooth(55, 80, h); r = lerp(r, 0.47, rk); g = lerp(g, 0.44, rk); b = lerp(b, 0.4, rk);
  return set(r, g, b);
}

// --- road grid: vertical lines x = -700..700, horizontal z = -600..500, every 100m
export const XL = [], ZL = [];
for (let x = -700; x <= 700; x += 100) XL.push(x);
for (let z = -600; z <= 500; z += 100) ZL.push(z);
export const ROAD_HW = 7;

// --- blocks (16 x 13), corner blocks are cut by the highway curve and left empty
export const blocks = [], blockGrid = new Array(16 * 13).fill(null);
export const PARKS = [[350, -250], [-350, -450], [550, 250], [-150, 350]];
export function districtOf(cx, cz) {
  if (Math.abs(cx + 50) < 30 && Math.abs(cz + 50) < 30) return 'plaza';
  for (const [px, pz] of PARKS) if (Math.abs(cx - px) < 30 && Math.abs(cz - pz) < 30) return 'park';
  if (cx < -380 && cz > 40) return 'industrial';
  if (Math.abs(cx) < 260 && Math.abs(cz + 20) < 250) return 'downtown';
  if (Math.hypot(cx, cz) < 540) return 'midtown';
  return 'suburb';
}
for (let c = 0; c < 16; c++) for (let r = 0; r < 13; r++) {
  if ((c === 0 || c === 15) && (r === 0 || r === 12)) continue;
  const x0 = -800 + c * 100, z0 = -700 + r * 100;
  const b = { c, r, x0: x0 + (c === 0 ? 12 : ROAD_HW), x1: x0 + 100 - (c === 15 ? 12 : ROAD_HW),
    z0: z0 + (r === 0 ? 12 : ROAD_HW), z1: z0 + 100 - (r === 12 ? 12 : ROAD_HW) };
  b.cx = (b.x0 + b.x1) / 2; b.cz = (b.z0 + b.z1) / 2; b.district = districtOf(b.cx, b.cz);
  blocks.push(b); blockGrid[c * 13 + r] = b;
}
export function blockAt(x, z) {
  const c = Math.floor((x + 800) / 100), r = Math.floor((z + 700) / 100);
  if (c < 0 || c > 15 || r < 0 || r > 12) return null;
  const b = blockGrid[c * 13 + r];
  return b && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 ? b : null;
}
// height of the static ground (roads, sidewalks, terrain) — no props
export function baseGround(x, z) {
  if (blockAt(x, z)) return CFG.curb;
  if (ringSD(x, z) < 16) return 0;
  return sampleH(x, z);
}
export const lotOf = (b, inset) => ({ x0: b.x0 + inset, x1: b.x1 - inset, z0: b.z0 + inset, z1: b.z1 - inset });

/* =====================================================================
   WORLD: generation
   ===================================================================== */
export let lampHeads = [];      // positions for the night-time point-light pool
// Vehicle spawn points: { x, z, heading, kind: 'car'|'boat', district }. heading h faces (sin h, cos h).
export const parkingSpots = [];
function addSpot(x, z, heading, kind = 'car') {
  const b = blockAt(x, z) || blockAt(x + 8, z) || blockAt(x - 8, z) || blockAt(x, z + 8) || blockAt(x, z - 8);
  parkingSpots.push({ x, z, heading, kind, district: b ? b.district : 'outskirts', v: null, cooldown: 0 });
}
export let radioBeacon = null;

export const _tcol = new THREE.Color();
export function buildTerrain() {
  const geo = new THREE.PlaneGeometry(TS, TS, TN, TN).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position; const col = new Float32Array(pos.count * 3), sd = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = terrainH(x, z); sd[i] = ringSD(x, z);
    heights[i] = h;
    pos.setY(i, h - (ringSD(x, z) < 13 ? 0.3 : 0));
    const c = _tcol.setRGB(...terrainColor(x, z, h), THREE.SRGBColorSpace); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // drop triangles fully hidden under the city's asphalt sheet (about a third of the terrain)
  const idx = geo.index.array, keep = [];
  for (let t = 0; t < idx.length; t += 3) if (!(sd[idx[t]] < -16 && sd[idx[t + 1]] < -16 && sd[idx[t + 2]] < -16)) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  geo.setIndex(keep);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  mesh.receiveShadow = true; scene.add(mesh);

  // asphalt: one rounded-rect sheet covering the whole road network inside (and including) the highway
  const R = CFG.ring, ex = R.w / 2, s = new THREE.Shape();
  const x0 = R.cx - R.hx - ex, x1 = R.cx + R.hx + ex, y0 = -(R.cz + R.hz + ex), y1 = -(R.cz - R.hz - ex), r = R.r + ex;
  s.moveTo(x0 + r, y0); s.lineTo(x1 - r, y0); s.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - r); s.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  s.lineTo(x0 + r, y1); s.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + r); s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  const ag = new THREE.ShapeGeometry(s, 24).rotateX(-Math.PI / 2);
  const asphalt = new THREE.Mesh(ag, M.asphalt); asphalt.receiveShadow = true; scene.add(asphalt);
}

export function tree(x, z, s = 1, y) {
  y = y ?? baseGround(x, z);
  const lc = pick(PAL.leaves);
  inst('trunk', x, y, z, 0.38 * s, 3.2 * s, 0.38 * s, 0, 0x5b4231);
  inst('leaf', x, y + 3.6 * s, z, 1.9 * s, 1.7 * s, 1.9 * s, rand() * 6, lc);
  if (rand() < 0.7) inst('leaf', x + rr(-.6, .6) * s, y + 4.7 * s, z + rr(-.6, .6) * s, 1.3 * s, 1.2 * s, 1.3 * s, rand() * 6, lc);
  addCollider(x - 0.25 * s, y, z - 0.25 * s, x + 0.25 * s, y + 3 * s, z + 0.25 * s, false);
}
export function palm(x, z) {
  const y = baseGround(x, z), h = rr(6.5, 9.5);
  inst('trunk', x, y, z, 0.32, h, 0.32, 0, 0x8a7558);
  inst('palm', x, y + h, z, 1.25, 1.25, 1.25, rand() * 6, pick([0x4f8f35, 0x5c9a3a, 0x3f7f2c]));
  addCollider(x - 0.18, y, z - 0.18, x + 0.18, y + h, z + 0.18, false);
}
export function planter(x, z, along) {   // low concrete planter with shrub — vaultable
  const w = along === 'x' ? 3 : 1.1, d = along === 'x' ? 1.1 : 3;
  solid('small', x, CFG.curb, z, w, 0.75, d, 0x9a968c);
  inst('leaf', x, CFG.curb + 0.95, z, w * 0.42, 0.5, d * 0.42, 0, pick(PAL.leaves));
}

export function genRoadsAndLamps() {
  const WHITE = 0xf2f2ee, YEL = 0xe8b830;
  const segs = [];
  for (const X of XL) { const st = [-700, ...ZL, 600];
    for (let i = 0; i < st.length - 1; i++) segs.push({ ax: 'z', c: X, a: st[i] + (i === 0 ? 12 : 7), b: st[i + 1] - (i === st.length - 2 ? 12 : 7) }); }
  for (const Z of ZL) { const st = [-800, ...XL, 800];
    for (let i = 0; i < st.length - 1; i++) segs.push({ ax: 'x', c: Z, a: st[i] + (i === 0 ? 12 : 7), b: st[i + 1] - (i === st.length - 2 ? 12 : 7) }); }
  for (const s of segs) {
    const P = (t, off) => s.ax === 'z' ? [s.c + off, t] : [t, s.c + off];
    const rot = s.ax === 'z' ? 0 : Math.PI / 2;
    const mid = (s.a + s.b) / 2, len = s.b - s.a;
    for (const off of [-0.17, 0.17]) { const [x, z] = P(mid, off); inst('mark', x, 0.02, z, 0.12, 1, len - 7, rot, YEL); }
    for (let t = s.a + 6; t < s.b - 6; t += 9) for (const off of [-3.5, 3.5]) { const [x, z] = P(t + 1.5, off); inst('mark', x, 0.02, z, 0.13, 1, 3, rot, WHITE); }
    for (const end of [s.a + 1.6, s.b - 1.6]) for (let i = 0; i < 9; i++) { const [x, z] = P(end, -6 + i * 1.5); inst('mark', x, 0.02, z, 0.75, 1, 2.8, rot, WHITE); }
    // curbside parking (right-hand traffic: +z traffic uses the -x side, +x traffic uses the +z side)
    for (let t = s.a + 14; t < s.b - 10; t += 24) if (rand() < 0.3) {
      const side = rand() < 0.5 ? 1 : -1, [x, z] = P(t, side * 5.6);
      addSpot(x, z, s.ax === 'z' ? (side > 0 ? Math.PI : 0) : (side > 0 ? Math.PI / 2 : -Math.PI / 2));
    }
    // street lamps, alternating sides
    let side = 1;
    for (let t = s.a + 12; t < s.b - 6; t += 30, side = -side) {
      const [x, z] = P(t, side * 8.3);
      const th = s.ax === 'z' ? (side > 0 ? Math.PI : 0) : side * Math.PI / 2;
      lamp(x, CFG.curb, z, th);
    }
  }
  // highway: walk the centreline, use SDF gradient as outward normal
  const pts = ringPath(3);
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i], [nx2, nz2] = pts[(i + 1) % pts.length];
    const tx = nx2 - x, tz = nz2 - z, L = Math.hypot(tx, tz); if (L < 0.01) continue;
    const rot = Math.atan2(tx, tz), nx = -tz / L, nz = tx / L;
    const sgn = Math.sign(ringSD(x + nx * 5, z + nz * 5)) || 1;   // make n point outward
    const ox = nx * sgn, oz = nz * sgn, mx = x + tx / 2, mz = z + tz / 2;
    for (const off of [-0.17, 0.17]) inst('mark', mx + ox * off, 0.02, mz + oz * off, 0.12, 1, L + 0.1, rot, YEL);
    if (i % 2 === 0) for (const off of [-8, -4, 4, 8]) inst('mark', mx + ox * off, 0.02, mz + oz * off, 0.15, 1, L, rot, WHITE);
    for (const off of [-11.4, 11.4]) inst('mark', mx + ox * off, 0.02, mz + oz * off, 0.15, 1, L + 0.1, rot, WHITE);
    if (i % 14 === 0) lamp(x + ox * 13.6, 0, z + oz * 13.6, Math.atan2(oz, -ox));
  }
}
export function ringPath(step) {
  const R = CFG.ring, pts = [];
  const C = [[R.cx + R.hx - R.r, R.cz + R.hz - R.r, 0], [R.cx - R.hx + R.r, R.cz + R.hz - R.r, Math.PI / 2],
             [R.cx - R.hx + R.r, R.cz - R.hz + R.r, Math.PI], [R.cx + R.hx - R.r, R.cz - R.hz + R.r, Math.PI * 1.5]];
  for (let i = 0; i < 4; i++) {
    const [cx, cz, a0] = C[i];
    for (let a = 0; a < Math.PI / 2; a += step / R.r) pts.push([cx + Math.cos(a0 + a) * R.r, cz + Math.sin(a0 + a) * R.r]);
    const sx = cx + Math.cos(a0 + Math.PI / 2) * R.r, sz = cz + Math.sin(a0 + Math.PI / 2) * R.r;
    const [ncx, ncz, na0] = C[(i + 1) % 4]; const ex = ncx + Math.cos(na0) * R.r, ez = ncz + Math.sin(na0) * R.r;
    const L = Math.hypot(ex - sx, ez - sz);
    for (let t = 0; t < L; t += step) pts.push([sx + (ex - sx) * t / L, sz + (ez - sz) * t / L]);
  }
  return pts;
}
export function lamp(x, y, z, th) {
  inst('pole', x, y, z, 1, 1, 1, th, 0xffffff);
  inst('lampHead', x, y, z, 1, 1, 1, th, 0xffffff);
  const hx = x + Math.cos(th) * 2.2, hz = z - Math.sin(th) * 2.2;
  inst('glow', hx, 0.2, hz, 17, 1, 17, 0, 0xffffff);
  lampHeads.push(new V3(hx, y + 7.6, hz));
  addCollider(x - 0.12, y, z - 0.12, x + 0.12, y + 8, z + 0.12, false);
}

export function genBlocks() {
  const LOTC = { downtown: 0x8d8c88, plaza: 0xb7ae9c, midtown: 0x8a8780, industrial: 0x6f6c66, suburb: 0x5b8a3a, park: 0x4e8a34 };
  for (const b of blocks) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    inst('slab', b.cx, 0, b.cz, w, CFG.curb, d, 0, 0xa9a69d);
    inst('lot', b.cx, CFG.curb + 0.01, b.cz, w - 8, 1, d - 8, 0, LOTC[b.district]);
    ({ downtown: genDowntown, plaza: genPlaza, midtown: genMidtown, industrial: genIndustrial, suburb: genSuburb, park: genPark })[b.district](b);
  }
}
export function edgeProps(b, fn, spacing, inset) {   // call fn along each sidewalk edge
  for (let t = b.x0 + 8; t < b.x1 - 8; t += spacing) { fn(t + rr(-2, 2), b.z0 + inset, 'x'); fn(t + rr(-2, 2), b.z1 - inset, 'x'); }
  for (let t = b.z0 + 8; t < b.z1 - 8; t += spacing) { fn(b.x0 + inset, t + rr(-2, 2), 'z'); fn(b.x1 - inset, t + rr(-2, 2), 'z'); }
}
export function roofUnits(x, z, w, d, y) {
  for (let k = ri(1, 3); k > 0; k--) solid('small', x + rr(-.3, .3) * w, y, z + rr(-.3, .3) * d, rr(2, 4), rr(1.2, 2.4), rr(2, 4), 0x8c8f94);
}
export function genDowntown(b) {
  const L = lotOf(b, 4.5), W = L.x1 - L.x0, D = L.z1 - L.z0;
  const dist = Math.hypot(b.cx, b.cz + 20), hb = 35 + 150 * Math.pow(Math.max(0, 1 - dist / 340), 1.4);
  const r = rand();
  const cells = r < 0.3 ? [[0, 0, 1, 1]] : r < 0.6 ? [[0, 0, .5, 1], [.5, 0, 1, 1]] : [[0, 0, .5, .5], [.5, 0, 1, .5], [0, .5, .5, 1], [.5, .5, 1, 1]];
  for (const [u0, v0, u1, v1] of cells) {
    const cw = (u1 - u0) * W - 2, cd = (v1 - v0) * D - 2, fw = cw * rr(0.72, 0.96), fd = cd * rr(0.72, 0.96);
    const x = L.x0 + (u0 + u1) / 2 * W + rr(-1, 1) * (cw - fw) / 2, z = L.z0 + (v0 + v1) / 2 * D + rr(-1, 1) * (cd - fd) / 2;
    const h = Math.max(18, hb * rr(0.5, 1.05) * (cells.length === 1 ? 1.1 : 1)), col = pick(PAL.downtown);
    building('bld', x, z, fw, fd, h, col);
    let top = CFG.curb + h;
    if (h > 55 && rand() < 0.65) {
      const f = rr(0.55, 0.8), h2 = rr(8, h * 0.3);
      building('bld', x, z, fw * f, fd * f, h2, col, top); top += h2;
      if (h > 110) solid('small', x, top, z, 0.5, rr(14, 28), 0.5, 0xd0d0d0, false, false);
    } else roofUnits(x, z, fw, fd, top);
  }
  edgeProps(b, (x, z, al) => { if (rand() < 0.55) planter(x, z, al); }, 22, 2.6);
}
export function genPlaza(b) {
  const { cx, cz } = b, y = CFG.curb, stone = 0xc9c2b0;
  for (const [dx, dz, w, d] of [[0, -6, 12.6, 0.6], [0, 6, 12.6, 0.6], [-6, 0, 0.6, 12.6], [6, 0, 0.6, 12.6]])
    solid('small', cx + dx, y, cz + dz, w, 0.7, d, stone);
  inst('small', cx, y, cz, 11.4, 0.45, 11.4, 0, 0x3f86a8);
  solid('small', cx, y, cz, 1.6, 3.2, 1.6, stone);
  solid('small', cx, y + 3.2, cz, 2.6, 0.4, 2.6, stone);
  for (const [dx, dz] of [[-25, -25], [25, -25], [-25, 25], [25, 25], [-25, 0], [25, 0], [0, -25], [0, 25]]) {
    solid('small', cx + dx, y, cz + dz, 4, 0.8, 4, 0x9a968c); tree(cx + dx, cz + dz, 1.1, y + 0.8);
  }
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; solid('small', cx + Math.cos(a) * 14, y, cz + Math.sin(a) * 14, 1.8, 0.45, 0.6, 0x6b4a32, false, false); }
}
export function genMidtown(b) {
  const L = lotOf(b, 4.5), cw = (L.x1 - L.x0) / 3, cd = (L.z1 - L.z0) / 3;
  const dist = Math.hypot(b.cx, b.cz), hb = 12 + 26 * Math.max(0, 1 - (dist - 250) / 300);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const x = L.x0 + cw * (i + .5), z = L.z0 + cd * (j + .5);
    if (i === 1 && j === 1) { if (rand() < 0.7) { tree(x - 4, z, 1); tree(x + 4, z + 3, 0.9); continue; } }
    if (rand() < 0.1) continue;
    const fw = cw - rr(2.5, 6), fd = cd - rr(2.5, 6), h = hb * rr(0.5, 1.35);
    building('bld', x, z, fw, fd, h, pick(PAL.mid));
    if (rand() < 0.5) roofUnits(x, z, fw, fd, CFG.curb + h);
  }
  edgeProps(b, (x, z) => { if (rand() < 0.35) tree(x, z, rr(.8, 1)); }, 20, 2.4);
}
export function genIndustrial(b) {
  const L = lotOf(b, 4), W = L.x1 - L.x0, D = L.z1 - L.z0, y = CFG.curb;
  const alongX = rand() < 0.5;
  let yard;
  if (alongX) {
    const ww = W * rr(0.5, 0.6), wd = D * rr(0.6, 0.85), h = rr(8, 14);
    building('big', L.x0 + ww / 2 + 2, b.cz + rr(-1, 1) * (D - wd) / 3, ww, wd, h, pick(PAL.ind));
    yard = { x0: L.x0 + ww + 6, x1: L.x1 - 2, z0: L.z0 + 2, z1: L.z1 - 2 };
  } else {
    const ww = W * rr(0.6, 0.85), wd = D * rr(0.5, 0.6), h = rr(8, 14);
    building('big', b.cx + rr(-1, 1) * (W - ww) / 3, L.z0 + wd / 2 + 2, ww, wd, h, pick(PAL.ind));
    yard = { x0: L.x0 + 2, x1: L.x1 - 2, z0: L.z0 + wd + 6, z1: L.z1 - 2 };
  }
  if (rand() < 0.35) {
    const r = rr(4, 6), h = rr(7, 12), tx = (yard.x0 + yard.x1) / 2, tz = (yard.z0 + yard.z1) / 2;
    for (const o of [-1, 1]) { const x = tx + o * (r + 1.5) * ((yard.x1 - yard.x0) > (yard.z1 - yard.z0) ? 1 : 0), z = tz + o * (r + 1.5) * ((yard.x1 - yard.x0) > (yard.z1 - yard.z0) ? 0 : 1);
      inst('tank', x, y, z, r * 2, h, r * 2, 0, 0xd8d8d0); addCollider(x - r * .9, y, z - r * .9, x + r * .9, y + h, z + r * .9); }
  } else {
    for (let z = yard.z0 + 2; z < yard.z1 - 2; z += 3.4) for (let x = yard.x0 + 3.5; x < yard.x1 - 3.5; x += 7)
      if (rand() < 0.5) { const n = ri(1, 3); for (let s = 0; s < n; s++) solid('cont', x, y + s * 2.6, z, 6.06, 2.59, 2.44, pick(PAL.container)); }
  }
  // perimeter wall with a gate gap (climbable at 1.8m)
  const wy = 1.8, T = 0.3, gate = rr(0.3, 0.7);
  const wall = (x0, z0, x1, z1) => { const w = Math.max(T, x1 - x0), d = Math.max(T, z1 - z0); solid('small', (x0 + x1) / 2, y, (z0 + z1) / 2, w, wy, d, 0x8b8880); };
  const gx = L.x0 + (L.x1 - L.x0) * gate;
  wall(L.x0, L.z1, gx - 6, L.z1); wall(gx + 6, L.z1, L.x1, L.z1);
  wall(L.x0, L.z0, L.x1, L.z0); wall(L.x0, L.z0, L.x0, L.z1 * 0.5 + L.z0 * 0.5 - 5);
}
export function genSuburb(b) {
  const L = lotOf(b, 4), W = L.x1 - L.x0, n = Math.max(2, Math.floor(W / 16)), sp = W / n;
  for (const row of [0, 1]) for (let i = 0; i < n; i++) {
    const hw = rr(8, 11), hd = rr(7, 9.5), stories = rand() < 0.4 ? 2 : 1, h = stories * 3 + 0.2;
    const x = L.x0 + sp * (i + .5) + rr(-1, 1), z = row === 0 ? L.z0 + 6 + hd / 2 : L.z1 - 6 - hd / 2;
    building('house', x, z, hw, hd, h, pick(PAL.house));
    inst('roof', x, CFG.curb + h, z, hw + 0.9, rr(2, 3), hd + 0.9, 0, pick(PAL.roof));
    if (rand() < 0.6) tree(x + rr(-sp / 3, sp / 3), row === 0 ? z + hd / 2 + rr(6, 12) : z - hd / 2 - rr(6, 12), rr(.7, 1.1));
    if (rand() < 0.35) addSpot(x + rr(-2, 2), row === 0 ? L.z0 + 3 : L.z1 - 3, row === 0 ? 0 : Math.PI);   // driveway
    if (i > 0) { const fx = L.x0 + sp * i, z0 = row === 0 ? L.z0 + 6 + 10 : (L.z0 + L.z1) / 2, z1 = row === 0 ? (L.z0 + L.z1) / 2 : L.z1 - 16;
      solid('small', fx, CFG.curb, (z0 + z1) / 2, 0.15, 1.1, z1 - z0, 0xe8e2d4); }
  }
  solid('small', b.cx, CFG.curb, (L.z0 + L.z1) / 2, W, 1.1, 0.15, 0xe8e2d4);   // back-yard fence (vaultable)
  edgeProps(b, (x, z) => { if (rand() < 0.5) tree(x, z, rr(.8, 1.1)); }, 18, 2.2);
}
export function genPark(b) {
  const L = lotOf(b, 4), { cx, cz } = b, y = CFG.curb;
  inst('lot', cx, y + 0.02, cz, 4, 1, L.z1 - L.z0, 0, 0xc2b28a);
  inst('lot', cx, y + 0.02, cz, L.x1 - L.x0, 1, 4, 0, 0xc2b28a);
  for (let i = 0; i < 34; i++) { const x = rr(L.x0 + 3, L.x1 - 3), z = rr(L.z0 + 3, L.z1 - 3); if (Math.abs(x - cx) < 4 || Math.abs(z - cz) < 4) continue; tree(x, z, rr(.8, 1.4)); }
  for (const [dx, dz, al] of [[10, 0, 'z'], [-10, 0, 'z'], [0, 10, 'x'], [0, -10, 'x']]) planter(cx + dx, cz + dz, al);
  for (const d of [-20, 20]) { solid('small', cx + 3, y, cz + d, 0.6, 0.45, 1.8, 0x6b4a32, false, false); solid('small', cx + d, y, cz + 3, 1.8, 0.45, 0.6, 0x6b4a32, false, false); }
}

export function genOutskirts() {
  // hill forest + rocks
  for (let i = 0; i < 16000; i++) {
    const x = rr(-1250, 1250), z = rr(-1250, 1250), d = ringSD(x, z); if (d < 28) continue;
    const h = sampleH(x, z); if (h < 1.2 || h > 100) continue;
    const wS = smooth(560, 640, z), wW = smooth(-760, -830, x) * (1 - wS);
    if (wS > 0.4 || (wW > 0.4 && z > -420)) continue;
    if (fbm(x * 0.01 + 5, z * 0.01 + 9) < 0.45) continue;
    const g = Math.hypot(sampleH(x + 3, z) - sampleH(x - 3, z), sampleH(x, z + 3) - sampleH(x, z - 3)) / 6; if (g > 0.8) continue;
    if (rand() < 0.12) { const s = rr(0.8, 2.5); inst('leaf', x, h + s * 0.3, z, s * 1.3, s * 0.8, s, rand() * 6, 0x7a756c); addCollider(x - s, h, z - s, x + s, h + s, z + s, false); }
    else tree(x, z, rr(0.8, 1.5), h);
  }
  // radio mast on the highest northern hill
  let best = [0, -900, -1];
  for (let x = -900; x <= 900; x += 20) for (let z = -1100; z <= -800; z += 20) { const h = sampleH(x, z); if (h > best[2]) best = [x, z, h]; }
  const [mx, mz, mh] = best;
  solid('big', mx, mh, mz, 3, 1.2, 3, 0x777777);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) inst('big', mx + dx, mh, mz + dz, 0.25, 70, 0.25, 0, 0xc8c8c8);
  for (let y = 6; y < 70; y += 6) inst('big', mx, mh + y, mz, 2.2, 0.2, 2.2, 0, 0xb04030);
  radioBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
  radioBeacon.position.set(mx, mh + 71, mz); scene.add(radioBeacon);

  // beach: palms, lifeguard towers, pier
  for (let x = -760; x < 1150; x += rr(14, 30)) { const z = rr(624, 652); if (baseGround(x, z) > CFG.waterY + 0.3 && Math.abs(x - 300) > 8) palm(x, z); }
  for (const x of [-450, 0, 560, 940]) {
    const z = 650, y = baseGround(x, z);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) inst('trunk', x + dx, y, z + dz, 0.2, 2.4, 0.2, 0, 0xe0e0e0);
    solid('box', x, y + 2.4, z, 3, 2.2, 3, 0xd94a3a);
    inst('roof', x, y + 4.6, z, 3.6, 1, 3.6, 0, 0xf2f2f2);
  }
  const px = 300, pz0 = 628, pz1 = 790, wood = 0x8b6a48;
  solid('box', px, -0.3, (pz0 + pz1) / 2, 8, 0.6, pz1 - pz0, wood);
  solid('box', px, -0.3, pz1 + 8, 18, 0.6, 16, wood);
  for (let z = pz0 + 8; z < pz1 + 16; z += 8) for (const dx of [-3.5, 3.5]) inst('trunk', px + dx, -8, z, 0.5, 7.8, 0.5, 0, 0x5d4632);
  for (const dx of [-3.9, 3.9]) solid('small', px + dx, 0.3, (pz0 + 12 + pz1) / 2, 0.15, 1.0, pz1 - pz0 - 12, 0xe8e2d4);
  solid('box', px, 0.3, pz1 + 12, 6, 3, 5, 0x3b7ea1);
  inst('roof', px, 3.3, pz1 + 12, 7, 1.4, 6, 0, 0xf0ece0);

  // west quay: containers, gantry cranes, moored ship
  for (let z = -330; z < 540; z += 3.4) {
    if (((z + 330) % 40) > 29) continue;
    for (let k = 0; k < 4; k++) { const x = -858 + k * 6.8; if (rand() < 0.6) { const n = ri(1, 3); for (let s = 0; s < n; s++) solid('cont', x, s * 2.6, z, 6.06, 2.59, 2.44, pick(PAL.container)); } }
  }
  for (const cz of [-200, 60, 320]) {
    const Y = 0xe2a52a;
    for (const lx of [-897, -872]) for (const dz of [-9, 9]) solid('big', lx, 0, cz + dz, 1.4, 34, 1.4, Y);
    for (const dz of [-9, 9]) inst('big', -912, 34, cz + dz, 104, 2.4, 1.6, 0, Y);
    for (const lx of [-897, -872]) inst('big', lx, 33, cz, 1.6, 1.6, 19.6, 0, Y);
    inst('big', -905, 31, cz, 5, 3, 5, 0, 0x404850);
    inst('big', -870, 36.4, cz, 8, 4, 22, 0, 0xd09030);
  }
  solid('big', -942, -8, 40, 30, 14, 190, 0x7a2a22);
  solid('big', -942, 6, -40, 24, 14, 22, 0xf0f0ee);
  solid('big', -942, 20, -42, 4, 8, 4, 0x2a2a2a);
  for (let z = -10; z < 125; z += 6.5) for (let k = -1; k <= 1; k++) { const n = ri(1, 3); for (let s = 0; s < n; s++) solid('cont', -942 + k * 7, 6 + s * 2.6, z, 6.06, 2.59, 2.44, pick(PAL.container), false, true); }
  for (let z = -320; z < 540; z += 25) solid('small', -899, 0, z, 0.6, 0.7, 0.6, 0x333333, false, false);

  // vehicle spots outside the grid: quay trucks, boats by the pier / port / beach
  for (const z of [-260, -120, 180, 460]) addSpot(-818, z, rand() < 0.5 ? 0 : Math.PI);
  for (const [x, z, h] of [[289, 760, Math.PI], [311, 775, Math.PI], [300, 822, Math.PI], [-918, -150, 0], [-918, 250, Math.PI], [-918, 420, 0], [720, 770, Math.PI / 2], [-300, 780, -Math.PI / 2]])
    addSpot(x, z, h, 'boat');
}

export function buildChunks() {
  const chunks = new Map(), col = new THREE.Color();
  for (const b of batches.values()) {
    let ch = chunks.get(b.ck);
    if (!ch) {
      const [ix, iz] = b.ck.split(',').map(Number);
      ch = { cx: (ix + .5) * CFG.chunk, cz: (iz + .5) * CFG.chunk, near: new THREE.Group(), mid: new THREE.Group(), far: new THREE.Group() };
      scene.add(ch.near, ch.mid, ch.far); chunks.set(b.ck, ch);
    }
    const K = KINDS[b.kind], n = b.c.length;
    const im = new THREE.InstancedMesh(K.geo, K.mat, n);
    im.instanceMatrix.array.set(b.m);
    for (let i = 0; i < n; i++) im.setColorAt(i, col.setHex(b.c[i]));
    im.castShadow = K.cast; im.receiveShadow = K.recv;
    im.computeBoundingSphere(); im.computeBoundingBox?.();
    ch[K.tier].add(im);
  }
  batches.clear();
  return [...chunks.values()];
}
let chunkList = [];
export const chunkCount = () => chunkList.length;
export function updateChunkVisibility() {
  const cx = camera.position.x, cz = camera.position.z, far = Math.min(Q.farDist, scene.fog.far + 80);
  for (const ch of chunkList) {
    const d = Math.max(0, Math.hypot(ch.cx - cx, ch.cz - cz) - CFG.chunk * 0.71);
    ch.far.visible = d < far; ch.mid.visible = d < Math.min(Q.midDist, far); ch.near.visible = d < Q.nearDist;
  }
}

/* =====================================================================
   WORLD: static collision queries (ground height, rays), zone names
   ===================================================================== */
// Highest walkable surface at (x,z): ground or the top of a collider no more than `step` above `feet`.
// sloped stunt ramps: { x, z, h (heading it rises toward), len, wid, top }
export const ramps = [];
export function rampHeight(x, z) {
  let best = -Infinity;
  for (const r of ramps) {
    const dx = x - r.x, dz = z - r.z, f = dx * Math.sin(r.h) + dz * Math.cos(r.h), l = dx * Math.cos(r.h) - dz * Math.sin(r.h);
    if (Math.abs(f) > r.len / 2 || Math.abs(l) > r.wid / 2) continue;
    best = Math.max(best, r.base + r.top * (f + r.len / 2) / r.len);
  }
  return best;
}
export function groundAt(x, z, feet, step = 0.5, m = 0.175) {
  let g = baseGround(x, z);
  if (ramps.length) { const rh = rampHeight(x, z); if (rh > g && rh <= feet + Math.max(step, 1.2)) g = rh; }
  for (const c of queryColliders(x - m, z - m, x + m, z + m)) {
    if (x < c.minX - m || x > c.maxX + m || z < c.minZ - m || z > c.maxZ + m) continue;
    if (c.maxY <= feet + step && c.maxY > g) g = c.maxY;
  }
  return g;
}
export function rayAABB(ox, oy, oz, dx, dy, dz, c) {
  let tmin = 0, tmax = Infinity;
  for (const [o, d, mn, mx] of [[ox, dx, c.minX, c.maxX], [oy, dy, c.minY, c.maxY], [oz, dz, c.minZ, c.maxZ]]) {
    if (Math.abs(d) < 1e-8) { if (o < mn || o > mx) return null; continue; }
    let t1 = (mn - o) / d, t2 = (mx - o) / d; if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null;
  }
  return tmin;
}
// Distance along a ray to the first static obstacle (camera-blocking colliders or terrain), capped at maxT.
export function rayWorld(o, dx, dy, dz, maxT) {
  let best = maxT; const ex = o.x + dx * maxT, ez = o.z + dz * maxT;
  for (const c of queryColliders(Math.min(o.x, ex) - .2, Math.min(o.z, ez) - .2, Math.max(o.x, ex) + .2, Math.max(o.z, ez) + .2)) {
    if (!c.cam) continue; const t = rayAABB(o.x, o.y, o.z, dx, dy, dz, c); if (t !== null && t < best) best = t;
  }
  for (let t = 0.3; t < best; t += 0.4) if (o.y + dy * t < baseGround(o.x + dx * t, o.z + dz * t) + 0.25) { best = t; break; }
  return best;
}
export const isWater = (x, z, depth = 0) => baseGround(x, z) < CFG.waterY - depth;

export function zoneName(x, z) {
  const d = ringSD(x, z);
  if (Math.abs(d) < 14) return ['Coastline Loop', 'Highway'];
  if (d < 0) {
    const bb = blockAt(x, z) || blocks.reduce((a, c) => Math.hypot(c.cx - x, c.cz - z) < Math.hypot(a.cx - x, a.cz - z) ? c : a);
    return ({ downtown: ['Meridian', 'Downtown'], plaza: ['Founders Plaza', 'Downtown'], midtown: ['Midtown', 'Harbor City'],
      industrial: ['Ironworks', 'Industrial'], park: ['Greenway Park', 'Harbor City'],
      suburb: [bb.cx > 0 ? (bb.cz < -100 ? 'Northgate' : 'Maple Grove') : (bb.cz < -100 ? 'Cedar Heights' : 'Westbrook'), 'Suburbs'] })[bb.district];
  }
  const h = sampleH(x, z);
  if (h < CFG.waterY - 0.5) return ['Open Water', 'Pacific Reach'];
  if (z > 560) return ['Saltline Beach', 'Coast'];
  if (x < -800 && z > -360) return ['Port Calloway', 'Docks'];
  return ['Cedar Hills', 'Outskirts'];
}

export function generateWorld(extra) {
  buildTerrain();
  genRoadsAndLamps();
  genBlocks();
  genOutskirts();
  addSpot(5.6, 34, Math.PI); parkingSpots[parkingSpots.length - 1].force = 'sports';   // a fast car right by the spawn point
  extra?.();
  chunkList = buildChunks();
}