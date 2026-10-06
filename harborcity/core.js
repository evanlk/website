// core.js — config, utilities, renderer/scene, shared materials, instancing batches, colliders, global state
import * as THREE from 'three';

/* =====================================================================
   CONFIG
   ===================================================================== */
export const CFG = {
  seed: 20261006,
  ring: { cx: 0, cz: -50, hx: 800, hz: 650, r: 100, w: 24 },   // highway loop (rounded rectangle centreline)
  waterY: -0.6,
  curb: 0.15,                 // sidewalk / block slab height
  chunk: 256,                 // render chunk size (m)
  dayLengthMin: 24,           // real minutes per in-game day
  worldLimit: 1180,
};
export const Q = { shadowSize: 2048, pixelRatio: 1.5, nearDist: 340, midDist: 650, farDist: 950, lampLights: 4 };
export const SAVE_KEY = 'harborcity.save.v1';

/* =====================================================================
   UTIL / RNG / NOISE
   ===================================================================== */
export const V3 = THREE.Vector3; export const UP = new V3(0, 1, 0);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export function lerpAngle(a, b, t) { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; }
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const rand = mulberry32(CFG.seed);
export const rr = (a, b) => a + (b - a) * rand();
export const ri = (a, b) => Math.floor(rr(a, b + 1));
export const pick = arr => arr[Math.floor(rand() * arr.length)];
export function hash2(x, z) { const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return h - Math.floor(h); }
export function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, z) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, z * f); f *= 2.03; a *= 0.5; } return s / 0.9375; }
export function mergeGeos(list) {
  const pos = [], nor = [];
  for (let g of list) { if (g.index) g = g.toNonIndexed(); pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
export const fmtMoney = n => '$' + Math.round(n).toLocaleString('en-US');

/* =====================================================================
   RENDERER / SCENE / LIGHTS
   ===================================================================== */
export const canvas = document.getElementById('game');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

export const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xa9cdea, 200, Q.farDist);
export const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.2, 1700);

export const hemi = new THREE.HemisphereLight(0xbcd8f5, 0x5a4f40, 1.0);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 1, far: 600 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* =====================================================================
   WORLD ASSETS: procedural textures, geometries, materials
   ===================================================================== */
export function canvasTex(size, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
export const texAsphalt = canvasTex(256, (g, s) => {
  g.fillStyle = '#45474b'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 9000; i++) { const v = 50 + Math.random() * 40 | 0; g.fillStyle = `rgba(${v},${v},${v + 3},${Math.random() * 0.6})`;
    g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2); }
  for (let i = 0; i < 6; i++) { g.strokeStyle = 'rgba(25,25,28,.35)'; g.lineWidth = 1 + Math.random() * 2; g.beginPath();
    let x = Math.random() * s, y = Math.random() * s; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (Math.random() - .5) * 60; y += (Math.random() - .5) * 60; g.lineTo(x, y); } g.stroke(); }
});
texAsphalt.repeat.set(1 / 9, 1 / 9);
export const texContainer = canvasTex(256, (g, s) => {   // corrugated steel: ribs + darker frame, tinted per instance
  for (let x = 0; x < s; x++) { const v = 200 + 55 * (0.5 + 0.5 * Math.sin(x / s * Math.PI * 2 * 22)); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, s); }
  g.fillStyle = 'rgba(40,40,40,.55)'; g.fillRect(0, 0, s, 10); g.fillRect(0, s - 10, s, 10); g.fillRect(0, 0, 6, s); g.fillRect(s - 6, 0, 6, s);
  g.fillStyle = 'rgba(255,255,255,.5)'; g.font = 'bold 22px sans-serif'; g.fillText('HCL', 20, 44);
});
export const texGlow = canvasTex(128, (g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
});

export const G = {};
G.box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
G.plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
G.roof = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0);
G.cyl6 = new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0);
G.cyl14 = new THREE.CylinderGeometry(0.5, 0.5, 1, 14).translate(0, 0.5, 0);
G.ico = new THREE.IcosahedronGeometry(1, 0);
G.palm = mergeGeos(Array.from({ length: 7 }, (_, i) =>
  new THREE.BoxGeometry(0.55, 0.06, 3.0).translate(0, 0, 1.5).rotateX(0.42 + (i % 2) * 0.15).rotateY(i / 7 * Math.PI * 2)));
G.lampPole = mergeGeos([new THREE.BoxGeometry(0.18, 8, 0.18).translate(0, 4, 0), new THREE.BoxGeometry(2.4, 0.13, 0.13).translate(1.1, 7.92, 0)]);
G.lampHead = new THREE.BoxGeometry(0.75, 0.18, 0.42).translate(2.2, 7.8, 0);

export const nightU = { value: 0 };
export const timeU = { value: 0 };
// Facade material: windows are generated in the shader from world position, so one
// material works for any building size and instancing scale. Lit windows glow at night.
export function makeWindowMaterial({ cellW, cellH, minY, rough, metal, litChance }) {
  const m = new THREE.MeshStandardMaterial({ roughness: rough, metalness: metal });
  m.onBeforeCompile = sh => {
    sh.uniforms.uNight = nightU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHcPos; varying vec3 vHcN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 hcW = vec4(transformed, 1.0);
        vec3 hcNo = objectNormal;
        #ifdef USE_INSTANCING
          hcW = instanceMatrix * hcW;
          hcNo = mat3(instanceMatrix) * hcNo;
        #endif
        vHcPos = (modelMatrix * hcW).xyz;
        vHcN = normalize(mat3(modelMatrix) * hcNo);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vHcPos; varying vec3 vHcN; uniform float uNight;
        float hcHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float hcWall = 1.0 - step(0.5, abs(vHcN.y));
        vec2 hcUV = abs(vHcN.x) > 0.5 ? vec2(vHcPos.z, vHcPos.y) : vec2(vHcPos.x, vHcPos.y);
        vec2 hcCell = hcUV / vec2(${cellW.toFixed(2)}, ${cellH.toFixed(2)});
        vec2 hcF = fract(hcCell);
        float hcWin = step(0.2, hcF.x) * step(hcF.x, 0.8) * step(0.3, hcF.y) * step(hcF.y, 0.82) * hcWall * step(${minY.toFixed(2)}, vHcPos.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.10, 0.15), hcWin * 0.82);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float hcLit = step(${(1 - litChance).toFixed(2)}, hcHash(floor(hcCell) + floor(vHcPos.xz * 0.11) * 7.0 + vHcN.xz * 3.0));
        totalEmissiveRadiance += vec3(1.0, 0.72, 0.4) * hcWin * hcLit * uNight * 0.75;`);
  };
  return m;
}

export const M = {
  bld: makeWindowMaterial({ cellW: 3.0, cellH: 3.5, minY: 3.2, rough: 0.55, metal: 0.25, litChance: 0.4 }),
  house: makeWindowMaterial({ cellW: 2.7, cellH: 3.0, minY: 0.4, rough: 0.9, metal: 0.0, litChance: 0.45 }),
  plain: new THREE.MeshStandardMaterial({ roughness: 0.85 }),
  leaf: new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
  metal: new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.5, metalness: 0.6 }),
  lampHead: new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffc070, emissiveIntensity: 0 }),
  glow: new THREE.MeshBasicMaterial({ map: texGlow, color: 0xffbf70, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  mark: new THREE.MeshStandardMaterial({ roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
  lot: new THREE.MeshStandardMaterial({ roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
  slab: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
  cont: new THREE.MeshStandardMaterial({ map: texContainer, roughness: 0.6, metalness: 0.25 }),
  asphalt: new THREE.MeshStandardMaterial({ map: texAsphalt, roughness: 0.92 }),
};

// kind -> geometry/material/tier. Tiers: near (props, markings) < mid (trees) < far (buildings).
export const KINDS = {
  bld:      { geo: G.box,      mat: M.bld,      tier: 'far',  cast: true,  recv: true },
  house:    { geo: G.box,      mat: M.house,    tier: 'far',  cast: true,  recv: true },
  roof:     { geo: G.roof,     mat: M.plain,    tier: 'far',  cast: true,  recv: true },
  big:      { geo: G.box,      mat: M.plain,    tier: 'far',  cast: true,  recv: true },
  tank:     { geo: G.cyl14,    mat: M.plain,    tier: 'far',  cast: true,  recv: true },
  slab:     { geo: G.box,      mat: M.slab,     tier: 'far',  cast: false, recv: true },
  lot:      { geo: G.plane,    mat: M.lot,      tier: 'far',  cast: false, recv: true },
  box:      { geo: G.box,      mat: M.plain,    tier: 'mid',  cast: true,  recv: true },
  cont:     { geo: G.box,      mat: M.cont,     tier: 'mid',  cast: true,  recv: true },
  trunk:    { geo: G.cyl6,     mat: M.plain,    tier: 'mid',  cast: true,  recv: false },
  leaf:     { geo: G.ico,      mat: M.leaf,     tier: 'mid',  cast: true,  recv: false },
  palm:     { geo: G.palm,     mat: M.leaf,     tier: 'mid',  cast: true,  recv: false },
  small:    { geo: G.box,      mat: M.plain,    tier: 'near', cast: true,  recv: true },
  pole:     { geo: G.lampPole, mat: M.metal,    tier: 'near', cast: false, recv: false },
  lampHead: { geo: G.lampHead, mat: M.lampHead, tier: 'near', cast: false, recv: false },
  glow:     { geo: G.plane,    mat: M.glow,     tier: 'near', cast: false, recv: false },
  mark:     { geo: G.plane,    mat: M.mark,     tier: 'near', cast: false, recv: true },
};

export const PAL = {
  downtown: [0x8fa3b8, 0x6e8496, 0xb8c4cc, 0x4f6274, 0xc9bfa8, 0x9aa6a8, 0x3e5568, 0xa7b8c6, 0xd8d2c4, 0x5d7b8a],
  mid: [0xb5735a, 0xc49a6c, 0xd8c7a3, 0x9c6b4e, 0xa8a39a, 0xc7b299, 0x8e7a66, 0xd6b48c, 0x9fa8a3],
  house: [0xe8dcc0, 0xd9e3e8, 0xf0d6b4, 0xc7d9b8, 0xe5c1b0, 0xd4d0e6, 0xf2efe6, 0xb8cfd8, 0xf3e3a6],
  roof: [0x6b3e2e, 0x4a4f57, 0x7a5232, 0x3d4a3a, 0x8a4a3a, 0x5a4a44],
  ind: [0x8a8f94, 0x9c8f7a, 0x6d7a82, 0xa39a8a, 0x7c8a7a, 0xb0a48c],
  container: [0xc0392b, 0x2e6da4, 0x2f8f5b, 0xd68a1c, 0x7b4fa0, 0xb8b8b8, 0x1f5f6f, 0xa83f2a, 0xe0c341],
  leaves: [0x3f7a2e, 0x4d8a34, 0x356b28, 0x5b8f3a, 0x2f5f2a, 0x6a9a3a],
};

/* =====================================================================
   WORLD: chunked instance batches + colliders (spatial hash)
   ===================================================================== */
export const batches = new Map();
export const _m4 = new THREE.Matrix4(), _q4 = new THREE.Quaternion(), _pv = new V3(), _sv = new V3();
export const chunkKeyOf = (x, z) => Math.floor(x / CFG.chunk) + ',' + Math.floor(z / CFG.chunk);
export function inst(kind, x, y, z, sx, sy, sz, rotY, color) {
  const ck = chunkKeyOf(x, z), key = kind + '|' + ck;
  let b = batches.get(key); if (!b) { b = { kind, ck, m: [], c: [] }; batches.set(key, b); }
  _q4.setFromAxisAngle(UP, rotY || 0); _m4.compose(_pv.set(x, y, z), _q4, _sv.set(sx, sy, sz));
  const e = _m4.elements; for (let i = 0; i < 16; i++) b.m.push(e[i]);
  b.c.push(color ?? 0xffffff);
}

export const COL_CELL = 24; const colGrid = new Map(); let colCount = 0; let qStamp = 0;
export const colliderCount = () => colCount;
export const cellKey = (ix, iz) => (ix + 1000) * 4096 + (iz + 1000);
export function addCollider(minX, minY, minZ, maxX, maxY, maxZ, cam = true) {
  const c = { minX, minY, minZ, maxX, maxY, maxZ, cam, q: 0 }; colCount++;
  for (let ix = Math.floor(minX / COL_CELL); ix <= Math.floor(maxX / COL_CELL); ix++)
    for (let iz = Math.floor(minZ / COL_CELL); iz <= Math.floor(maxZ / COL_CELL); iz++) {
      const k = cellKey(ix, iz); let a = colGrid.get(k); if (!a) colGrid.set(k, a = []); a.push(c);
    }
  return c;
}
export function queryColliders(minX, minZ, maxX, maxZ) {
  const out = []; qStamp++;
  for (let ix = Math.floor(minX / COL_CELL); ix <= Math.floor(maxX / COL_CELL); ix++)
    for (let iz = Math.floor(minZ / COL_CELL); iz <= Math.floor(maxZ / COL_CELL); iz++) {
      const a = colGrid.get(cellKey(ix, iz)); if (!a) continue;
      for (const c of a) { if (c.q === qStamp) continue; c.q = qStamp;
        if (c.maxX >= minX && c.minX <= maxX && c.maxZ >= minZ && c.minZ <= maxZ) out.push(c); }
    }
  return out;
}
// axis-aligned solid: instance + collider. y is the base.
export function solid(kind, x, y, z, sx, sy, sz, color, rot90 = false, cam = true) {
  inst(kind, x, y, z, sx, sy, sz, rot90 ? Math.PI / 2 : 0, color);
  const hx = (rot90 ? sz : sx) / 2, hz = (rot90 ? sx : sz) / 2;
  return addCollider(x - hx, y, z - hz, x + hx, y + sy, z + hz, cam);
}
export const footprints = [];   // for the minimap
export function building(kind, x, z, w, d, h, color, y = CFG.curb) {
  solid(kind, x, y, z, w, h, d, color);
  footprints.push([x - w / 2, z - d / 2, w, d, kind]);
}

/* =====================================================================
   SHARED STATE + EVENTS
   ===================================================================== */
// Global game state (saved) and run flags. Modules mutate fields; never reassign S.
export const S = { started: false, paused: true, hadLock: false, money: 500, unlocked: [], missions: {}, radio: 0, hornTime: -99, timeScale: 1,
  weapon: 'fist', weapons: { fist: { owned: true }, pistol: { owned: true, mag: 12, reserve: 36 }, smg: { owned: false, mag: 0, reserve: 0 }, shotgun: { owned: false, mag: 0, reserve: 0 } } };
// Camera orbit state, shared by input (mouse/stick) and camera.js.
export const cam = { yaw: 0, pitch: 0.22, dist: 4.6, cur: 4.6, focus: new V3(), lookTimer: 0, shake: 0, vDist: 0 };
const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
export function emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); }
