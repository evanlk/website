// env.js — sky, water, rain, day/night cycle, weather, street-light pool
import * as THREE from 'three';
import { CFG, Q, V3, lerp, smooth, rand, rr, renderer, scene, camera, hemi, sun, nightU, timeU, M, emit } from './core.js';
import { lampHeads, radioBeacon } from './world.js';

/* =====================================================================
   ENVIRONMENT: sky, water, day/night, weather, street lights
   ===================================================================== */
export const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uSunDir: { value: new V3() },
    uSunCol: { value: new THREE.Color() }, uNight: nightU, uOver: { value: 0 } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform vec3 uTop, uHor, uSunDir, uSunCol; uniform float uNight, uOver; varying vec3 vDir;
    void main(){ vec3 d = normalize(vDir); float h = max(d.y, 0.0);
      vec3 col = mix(uHor, uTop, pow(h, 0.5));
      float s = max(dot(d, uSunDir), 0.0);
      col += uSunCol * (pow(s, 900.0) * 10.0 + pow(s, 10.0) * 0.25) * (1.0 - uOver);
      float m = max(dot(d, -uSunDir), 0.0);
      col += vec3(0.8, 0.85, 1.0) * smoothstep(0.9993, 0.9996, m) * uNight * (1.0 - uOver) * 1.5;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);

export const stars = (() => {
  const p = []; for (let i = 0; i < 1600; i++) { const v = new V3(rand() * 2 - 1, rand() * 0.95 + 0.05, rand() * 2 - 1).normalize().multiplyScalar(1400); p.push(v.x, v.y, v.z); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  const s = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  s.frustumCulled = false; scene.add(s); return s;
})();

export const water = (() => {
  const mat = new THREE.MeshStandardMaterial({ color: 0x1f5b76, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.9 });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTime = timeU;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vWXZ;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vWXZ; uniform float uTime;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float w1 = sin(vWXZ.x * 0.31 + uTime * 1.2) + sin(vWXZ.y * 0.43 - uTime * 0.9);
        float w2 = sin((vWXZ.x + vWXZ.y) * 0.9 + uTime * 2.2) * 0.6 + sin((vWXZ.x - vWXZ.y) * 1.7 - uTime * 2.7) * 0.3;
        normal = normalize(normal + vec3(w1 * 0.035 + w2 * 0.03, (w2 - w1) * 0.03, 0.0));`);
  };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), mat);
  m.position.y = CFG.waterY; m.receiveShadow = true; scene.add(m); return m;
})();

export const rain = (() => {
  const N = 6000, pos = new Float32Array(N * 6), end = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { const x = Math.random() * 80, y = Math.random() * 40, z = Math.random() * 80;
    pos.set([x, y, z, x, y, z], i * 6); end[i * 2 + 1] = 1; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
    uniforms: { uTime: timeU, uCam: { value: new V3() }, uOp: { value: 0 } },
    vertexShader: `attribute float aEnd; uniform float uTime; uniform vec3 uCam;
      void main(){ vec3 p = position;
        vec3 w = vec3(uCam.x + mod(p.x - uCam.x, 80.0) - 40.0, uCam.y + mod(p.y - uTime * 26.0, 40.0) - 18.0, uCam.z + mod(p.z - uCam.z, 80.0) - 40.0);
        w += vec3(0.12, 0.75, 0.05) * aEnd;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
    fragmentShader: `uniform float uOp; void main(){ gl_FragColor = vec4(0.72, 0.78, 0.88, uOp * 0.45); }` });
  const l = new THREE.LineSegments(g, mat); l.frustumCulled = false; l.visible = false; scene.add(l); return l;
})();

export const lampLights = Array.from({ length: Q.lampLights }, () => { const l = new THREE.PointLight(0xffc27a, 0, 30, 1.6); scene.add(l); return l; });
export const env = { time: 9, weather: 'clear', weatherTimer: 300, rain: 0, fog: 0, night: 0, sunDir: new V3(), lightTimer: 0 };
export const WEATHERS = ['clear', 'rain', 'fog'];
export const C = (h) => new THREE.Color(h);
export const SKY = {
  night: { top: C(0x040914), hor: C(0x142037), sun: C(0x9fb4ff), sunI: 0.35, hemi: 0.32 },
  dusk:  { top: C(0x2b3f72), hor: C(0xf09a5c), sun: C(0xffa560), sunI: 1.2, hemi: 0.6 },
  day:   { top: C(0x3c7fd8), hor: C(0xadd0ec), sun: C(0xfff3df), sunI: 2.7, hemi: 1.05 },
  rain:  C(0x5d6772), fog: C(0xa3abb1),
};
export const _c1 = new THREE.Color(), _c3 = new THREE.Color(), _moonDir = new V3();
export function setWeather(w, announce = true) {
  env.weather = w; env.weatherTimer = rr(240, 480);
  if (announce) emit('toast', w === 'clear' ? 'Weather: Clear skies' : w === 'rain' ? 'Weather: Rain moving in' : 'Weather: Fog rolling in');
}
export function updateEnv(dt, p) {   // p = focus position (player or their vehicle)
  env.time = (env.time + dt * 24 / (CFG.dayLengthMin * 60)) % 24;
  env.weatherTimer -= dt;
  if (env.weatherTimer <= 0) { const r = rand(); setWeather(r < 0.6 ? 'clear' : r < 0.85 ? 'rain' : 'fog'); }
  const k = 1 - Math.exp(-dt / 5);
  env.rain += ((env.weather === 'rain' ? 1 : 0) - env.rain) * k;
  env.fog += ((env.weather === 'fog' ? 1 : 0) - env.fog) * k;

  const a = (env.time - 6) / 24 * Math.PI * 2;
  env.sunDir.set(Math.cos(a), Math.sin(a), 0.35).normalize();
  const e = env.sunDir.y, tN = smooth(-0.18, 0.04, e), tD = smooth(0.0, 0.35, e);
  const mixK = (key) => key === 'sunI' || key === 'hemi' ? lerp(lerp(SKY.night[key], SKY.dusk[key], tN), SKY.day[key], tD)
    : _c3.copy(SKY.night[key]).lerp(SKY.dusk[key], tN).lerp(SKY.day[key], tD).clone();
  const top = mixK('top'), hor = mixK('hor'), sunCol = mixK('sun');
  const over = Math.max(env.rain, env.fog);
  const grey = _c1.copy(SKY.rain).lerp(SKY.fog, env.fog / Math.max(0.001, env.rain + env.fog)).multiplyScalar(lerp(0.12, 1, smooth(-0.15, 0.2, e)));
  top.lerp(grey, over * 0.85); hor.lerp(grey, over * 0.8);
  env.night = 1 - smooth(-0.1, 0.12, e);
  nightU.value = env.night;

  sky.material.uniforms.uTop.value.copy(top); sky.material.uniforms.uHor.value.copy(hor);
  sky.material.uniforms.uSunDir.value.copy(env.sunDir); sky.material.uniforms.uSunCol.value.copy(sunCol);
  sky.material.uniforms.uOver.value = over;
  scene.fog.color.copy(hor);
  scene.fog.near = lerp(lerp(180, 30, env.rain), 4, env.fog);
  scene.fog.far = lerp(lerp(Q.farDist, 430, env.rain), 170, env.fog);
  renderer.setClearColor(hor);

  const sunUp = e > -0.04;
  const ld = sunUp ? env.sunDir : _moonDir.set(-env.sunDir.x, -env.sunDir.y, env.sunDir.z).normalize();
  sun.color.copy(sunCol);
  sun.intensity = (sunUp ? mixK('sunI') * smooth(-0.04, 0.06, e) : SKY.night.sunI * smooth(0.04, -0.08, e)) * (1 - over * 0.7);
  hemi.intensity = mixK('hemi') * (1 - over * 0.25);
  hemi.color.copy(hor).lerp(_c1.set(0xffffff), 0.3);
  const texel = 180 / Q.shadowSize;
  sun.target.position.set(Math.round(p.x / texel) * texel, p.y, Math.round(p.z / texel) * texel);
  sun.position.copy(sun.target.position).addScaledVector(ld, 300);
  sun.castShadow = Q.shadows !== false && sun.intensity > 0.05;

  stars.material.opacity = env.night * (1 - over);
  M.lampHead.emissiveIntensity = 0.05 + env.night * 3;
  M.glow.opacity = env.night * 0.5; M.glow.visible = env.night > 0.02;
  M.asphalt.roughness = lerp(0.92, 0.32, env.rain); M.asphalt.color.setScalar(1 - 0.35 * env.rain);
  M.slab.roughness = lerp(0.9, 0.45, env.rain); M.lot.roughness = M.slab.roughness;
  rain.visible = env.rain > 0.02; rain.material.uniforms.uOp.value = env.rain;
  rain.material.uniforms.uCam.value.copy(camera.position);
  if (radioBeacon) radioBeacon.visible = (timeU.value % 1.6) < 0.5;

  env.lightTimer -= dt;
  if (env.lightTimer <= 0) {
    env.lightTimer = 0.3;
    if (env.night > 0.05) {
      const near = lampHeads.map(v => [v, v.distanceToSquared(p)]).sort((x, y) => x[1] - y[1]);
      lampLights.forEach((l, i) => { if (near[i]) l.position.copy(near[i][0]); });
    }
  }
  lampLights.forEach(l => l.intensity = Q.lampsOn === false ? 0 : env.night * 55);
}

