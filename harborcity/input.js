// input.js — keyboard, mouse (pointer lock / drag), gamepad; key bindings via bind()
import { S, cam, canvas, clamp } from './core.js';

/* =====================================================================
   INPUT: state + bindings
   ===================================================================== */
export const keys = new Set();
export const input = { x: 0, y: 0, sprint: false, jump: false, throttle: 0, steer: 0, handbrake: false, horn: false, aim: false, fire: false, firePressed: false };
export const sens = { mouse: 0.0022, pad: 2.6, invertY: false };
export const forceInput = {};   // debug/testing: fields here override polled input
const handlers = {};
export function bind(code, fn) { (handlers[code] ||= []).push(fn); }
export function fire(code) { for (const fn of handlers[code] || []) fn(); }
let jumpQueued = false, dragLook = false, fireQueued = false;
const mouse = { fire: false, aim: false };
const gpPrev = [];

addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3', 'Tab'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'Space') jumpQueued = true;
  if (S.started) fire(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('mousemove', e => {
  if (document.pointerLockElement === canvas || dragLook) {
    cam.yaw -= e.movementX * sens.mouse; cam.pitch = clamp(cam.pitch + e.movementY * sens.mouse * (sens.invertY ? -1 : 1), -0.5, 1.25);
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 1) cam.lookTimer = 1.6;
  }
});
canvas.addEventListener('mousedown', e => {
  if (!S.started) return;
  if (document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); if (e.button === 0) dragLook = true; if (e.button !== 2) return; }
  if (e.button === 0) { mouse.fire = true; fireQueued = true; }   // left: fire / punch
  if (e.button === 2) mouse.aim = true;                            // right: aim
});
addEventListener('mouseup', e => { if (e.button === 0) { mouse.fire = false; dragLook = false; } if (e.button === 2) mouse.aim = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('wheel', e => fire(e.deltaY > 0 ? 'WheelDown' : 'WheelUp'), { passive: true });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) { S.hadLock = true; fire('Locked'); }
  else if (S.started && S.hadLock) fire('Unlocked');
});

/* =====================================================================
   INPUT: per-frame polling (keyboard + gamepad merged)
   ===================================================================== */
export function pollInput(dt) {
  const k = c => keys.has(c);
  let x = 0, y = 0;
  if (k('KeyW') || k('ArrowUp')) y += 1;
  if (k('KeyS') || k('ArrowDown')) y -= 1;
  if (k('KeyA') || k('ArrowLeft')) x -= 1;
  if (k('KeyD') || k('ArrowRight')) x += 1;
  let sprint = k('ShiftLeft') || k('ShiftRight'), jump = jumpQueued; jumpQueued = false;
  let throttle = y, steer = x, handbrake = k('Space'), horn = k('KeyE');
  let aim = mouse.aim, fireHeld = mouse.fire, firePressed = fireQueued; fireQueued = false;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    const dz = v => Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
    const val = i => gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0;
    const btn = i => val(i) > 0.4;
    const prev = gpPrev[gp.index] || [];
    const press = i => btn(i) && !prev[i];
    const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
    x += lx; y -= ly; steer += lx;
    throttle += val(7) - val(6);
    aim ||= btn(6); fireHeld ||= btn(7); if (press(7)) firePressed = true;
    if (press(2)) fire('Reload');
    if (press(12)) fire('WeaponNext');
    if (press(13)) fire('WeaponPrev');
    if (rx || ry) { cam.yaw -= rx * sens.pad * dt; cam.pitch = clamp(cam.pitch + ry * 1.8 * dt * (sens.invertY ? -1 : 1), -0.5, 1.25); cam.lookTimer = 1.2; }
    if (press(0)) jump = true;
    sprint ||= btn(1) || btn(10);
    handbrake ||= btn(5) || btn(0);
    horn ||= btn(10);
    if (press(3)) fire('KeyF');
    if (press(15)) fire('KeyR');
    if (press(14)) fire('KeyQ');
    if (press(9)) fire('Pause');
    if (press(11)) fire('Tab');                                   // R3: phone
    if (press(8)) fire('KeyE');                                   // Back/Select: interact
    if (press(0)) fire('Enter'); if (press(1)) fire('Escape');   // A confirms / B backs out (dialogue, menus)
    if (press(12)) fire('ArrowUp'); if (press(13)) fire('ArrowDown');
    if (press(0) && !S.started) fire('Start');
    gpPrev[gp.index] = gp.buttons.map((_, i) => btn(i));
  }
  const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
  Object.assign(input, { x, y, sprint, jump, throttle: clamp(throttle, -1, 1), steer: clamp(steer, -1, 1), handbrake, horn, aim, fire: fireHeld, firePressed }, forceInput);
  if (forceInput.firePressed) forceInput.firePressed = false;
}
