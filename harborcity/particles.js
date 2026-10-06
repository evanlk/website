// particles.js — pooled point-sprite particles: smoke (alpha blended) and fire/sparks (additive)
import * as THREE from 'three';
import { scene, camera, renderer, texGlow, rand } from './core.js';

/* =====================================================================
   PARTICLES: systems
   ===================================================================== */
function makeSystem(N, additive) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 4), size = new Float32Array(N);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uMap: { value: texGlow }, uScale: { value: 500 } },
    vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
      void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(0.2, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D uMap; varying vec4 vC;
      void main(){ float a = texture2D(uMap, gl_PointCoord).a; if (a * vC.a < 0.004) discard; gl_FragColor = vec4(vC.rgb, vC.a * a);
        #include <colorspace_fragment>
      }`,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = additive ? 3 : 2; scene.add(pts);
  return { N, pts, pos, col, size, vel: new Float32Array(N * 3), life: new Float32Array(N), max: new Float32Array(N),
    s0: new Float32Array(N), s1: new Float32Array(N), c0: new Float32Array(N * 4), c1: new Float32Array(N * 4),
    drag: new Float32Array(N), grav: new Float32Array(N), cursor: 0, alive: 0 };
}
export const smoke = makeSystem(1400, false);
export const fire = makeSystem(1600, true);

// life in seconds, sizes in metres, colours [r,g,b,a] at birth -> death
export function emitP(sys, x, y, z, vx, vy, vz, life, s0, s1, c0, c1, drag = 1, grav = 0) {
  const i = sys.cursor; sys.cursor = (i + 1) % sys.N;
  sys.pos[i * 3] = x; sys.pos[i * 3 + 1] = y; sys.pos[i * 3 + 2] = z;
  sys.vel[i * 3] = vx; sys.vel[i * 3 + 1] = vy; sys.vel[i * 3 + 2] = vz;
  sys.life[i] = life; sys.max[i] = life; sys.s0[i] = s0; sys.s1[i] = s1; sys.drag[i] = drag; sys.grav[i] = grav;
  sys.c0.set(c0, i * 4); sys.c1.set(c1, i * 4);
}

function step(sys, dt) {
  const { N, pos, col, size, vel, life, max, s0, s1, c0, c1, drag, grav } = sys;
  let alive = 0;
  for (let i = 0; i < N; i++) {
    if (life[i] <= 0) { if (size[i] !== 0) { size[i] = 0; col[i * 4 + 3] = 0; } continue; }
    alive++;
    life[i] -= dt; const t = 1 - Math.max(0, life[i]) / max[i], k = Math.exp(-drag[i] * dt);
    vel[i * 3] *= k; vel[i * 3 + 1] = vel[i * 3 + 1] * k - grav[i] * dt; vel[i * 3 + 2] *= k;
    pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    size[i] = s0[i] + (s1[i] - s0[i]) * t;
    for (let c = 0; c < 4; c++) col[i * 4 + c] = c0[i * 4 + c] + (c1[i * 4 + c] - c0[i * 4 + c]) * t;
    if (life[i] <= 0) { size[i] = 0; col[i * 4 + 3] = 0; }
  }
  sys.alive = alive;
  const g = sys.pts.geometry;
  g.attributes.position.needsUpdate = g.attributes.aColor.needsUpdate = g.attributes.aSize.needsUpdate = true;
}

const flash = new THREE.PointLight(0xffa040, 0, 45, 1.4); scene.add(flash);
let flashT = 0;
export function updateParticles(dt) {
  const scale = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
  smoke.pts.material.uniforms.uScale.value = fire.pts.material.uniforms.uScale.value = scale;
  step(smoke, dt); step(fire, dt);
  if (flashT > 0) { flashT -= dt; flash.intensity = Math.max(0, flashT) * 2400; } else flash.intensity = 0;
}

/* =====================================================================
   PARTICLES: effect presets
   ===================================================================== */
const R = (a) => (rand() - 0.5) * 2 * a;
export function engineSmoke(x, y, z, dark) {
  const g = dark ? 0.12 : 0.55;
  emitP(smoke, x + R(.3), y, z + R(.3), R(.4), 1.6 + rand(), R(.4), 1.6 + rand(), 0.5, 2.6, [g, g, g, 0.55], [g, g, g, 0], 0.6, -0.4);
}
export function fireLick(x, y, z) {
  emitP(fire, x + R(.5), y, z + R(.5), R(.4), 2 + rand() * 1.5, R(.4), 0.45 + rand() * 0.3, 1.1, 0.3, [1, 0.55, 0.15, 0.9], [0.9, 0.15, 0.02, 0], 0.8, -1);
}
export function tireSmoke(x, y, z, amt) {
  emitP(smoke, x + R(.2), y + 0.2, z + R(.2), R(.8), 0.5 + rand() * 0.6, R(.8), 1.2 + rand() * 0.8, 0.6, 3.2, [0.85, 0.85, 0.85, 0.35 * amt], [0.9, 0.9, 0.9, 0], 1.2, -0.2);
}
export function sparks(x, y, z, n) {
  for (let i = 0; i < n; i++) emitP(fire, x, y, z, R(5), rand() * 4, R(5), 0.25 + rand() * 0.35, 0.18, 0.05, [1, 0.85, 0.4, 1], [1, 0.4, 0.1, 0], 1.5, 12);
}
export function splash(x, y, z, n, power = 1) {
  for (let i = 0; i < n; i++) emitP(smoke, x + R(1), y, z + R(1), R(2.5) * power, (2 + rand() * 4) * power, R(2.5) * power, 0.7 + rand() * 0.5, 0.5, 1.6, [0.92, 0.96, 1, 0.75], [0.9, 0.95, 1, 0], 0.8, 9);
}
export function wake(x, y, z, amt) {
  emitP(smoke, x + R(.4), y + 0.05, z + R(.4), R(.6), 0.3 + rand() * 0.4, R(.6), 0.7 + rand() * 0.5, 0.4, 1.4, [0.95, 0.97, 1, 0.35 * amt], [0.95, 0.97, 1, 0], 1.2, 2);
}
export function explosionFX(x, y, z) {
  for (let i = 0; i < 70; i++) { const a = rand() * Math.PI * 2, s = 4 + rand() * 9;
    emitP(fire, x, y + 0.6, z, Math.cos(a) * s, 2 + rand() * 9, Math.sin(a) * s, 0.5 + rand() * 0.6, 2.4, 0.8, [1, 0.7, 0.25, 1], [0.8, 0.12, 0.02, 0], 2.6, -1); }
  for (let i = 0; i < 40; i++) { const a = rand() * Math.PI * 2, s = 2 + rand() * 5;
    emitP(smoke, x + R(1.5), y + 1 + rand() * 2, z + R(1.5), Math.cos(a) * s, 3 + rand() * 5, Math.sin(a) * s, 2.5 + rand() * 2, 2.5, 7, [0.1, 0.09, 0.08, 0.85], [0.25, 0.24, 0.23, 0], 1.1, -0.3); }
  sparks(x, y + 1, z, 40);
  flash.position.set(x, y + 2, z); flashT = 0.35;
}
