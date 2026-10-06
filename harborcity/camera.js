// camera.js — over-the-shoulder camera on foot, chase camera in vehicles, collision, shake
import { CFG, V3, clamp, lerp, lerpAngle, camera, cam } from './core.js';
import { baseGround, rayWorld } from './world.js';
import { sky, stars, water } from './env.js';
import { player } from './player.js';
import { combat } from './combat.js';

/* =====================================================================
   CAMERA
   ===================================================================== */
const _pivot = new V3();
export function updateCamera(dt) {
  const v = player.vehicle;
  let fovT = 65;
  if (v) {
    const T = v.T, speed = v.speed;
    // auto-recentre behind the vehicle unless the player has looked around recently
    cam.lookTimer -= dt;
    if (cam.lookTimer <= 0 && speed > 1) {
      const k = 1 - Math.exp(-(2 + speed * 0.08) * dt);
      cam.yaw = lerpAngle(cam.yaw, v.heading + Math.PI, k); cam.pitch = lerp(cam.pitch, 0.2, k);
    }
    const ty = v.pos.y + T.hgt * 0.7 + 0.5;
    cam.focus.x = v.pos.x; cam.focus.z = v.pos.z;
    cam.focus.y = Math.abs(ty - cam.focus.y) > 4 ? ty : lerp(cam.focus.y, ty, 1 - Math.exp(-8 * dt));
    _pivot.copy(cam.focus);
    place(dt, T.camDist + cam.vDist + speed * 0.04);
    fovT = 65 + Math.min(16, speed * 0.3);
  } else {
    const p = player.pos;
    cam.focus.x = p.x; cam.focus.z = p.z;
    const ty = p.y + 1.6; cam.focus.y = Math.abs(ty - cam.focus.y) > 4 ? ty : lerp(cam.focus.y, ty, 1 - Math.exp(-12 * dt));
    const rX = Math.cos(cam.yaw), rZ = -Math.sin(cam.yaw);
    const a = combat.aim, shW = lerp(0.55, 0.85, a);   // aiming: tighter over-the-shoulder view
    const sh = clamp(rayWorld(cam.focus, rX, 0, rZ, shW + 0.25) - 0.25, 0, shW);
    _pivot.set(cam.focus.x + rX * sh, cam.focus.y + a * 0.1, cam.focus.z + rZ * sh);
    const moving = Math.hypot(player.vel.x, player.vel.z) > 6;
    place(dt, lerp(cam.dist + (moving ? 0.7 : 0), 2.1, a));
    fovT = lerp(65 + (moving ? 6 : 0), 50, a);
  }
  if (cam.shake > 0.002) {
    const s = cam.shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s; camera.position.z += (Math.random() - 0.5) * s;
    cam.shake *= Math.exp(-6 * dt);
  } else cam.shake = 0;
  if (Math.abs(camera.fov - fovT) > 0.05) { camera.fov = lerp(camera.fov, fovT, 1 - Math.exp(-4 * dt)); camera.updateProjectionMatrix(); }
  sky.position.copy(camera.position); stars.position.copy(camera.position);
  water.position.x = Math.round(camera.position.x / 50) * 50; water.position.z = Math.round(camera.position.z / 50) * 50;
}
function place(dt, want) {
  const cp = Math.cos(cam.pitch), dx = Math.sin(cam.yaw) * cp, dy = Math.sin(cam.pitch), dz = Math.cos(cam.yaw) * cp;
  const hit = rayWorld(_pivot, dx, dy, dz, want + 0.3) - 0.3;
  if (hit < cam.cur) cam.cur = Math.max(0.35, hit); else cam.cur = lerp(cam.cur, Math.min(hit, want), 1 - Math.exp(-3 * dt));
  camera.position.set(_pivot.x + dx * cam.cur, _pivot.y + dy * cam.cur, _pivot.z + dz * cam.cur);
  const gy = Math.max(baseGround(camera.position.x, camera.position.z), CFG.waterY) + 0.3;
  if (camera.position.y < gy) camera.position.y = gy;
  camera.lookAt(_pivot);
}
