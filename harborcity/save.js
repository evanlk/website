// save.js — localStorage save/load
import { SAVE_KEY, S, cam, emit } from './core.js';
import { env, setWeather, WEATHERS } from './env.js';
import { player } from './player.js';

/* =====================================================================
   SAVE
   ===================================================================== */
// ?nosave in the URL disables saving and loading (handy for testing)
const NOSAVE = new URLSearchParams(location.search).has('nosave');
export function saveGame(silent = true) {
  if (NOSAVE) return;
  try {
    const p = player.vehicle ? player.vehicle.pos : player.pos;
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, money: S.money, unlocked: S.unlocked, missions: S.missions, radio: S.radio, progress: S.progress, weapon: S.weapon, weapons: S.weapons, health: player.health, armor: player.armor,
      pos: [p.x, p.y + 0.3, p.z], facing: player.facing, camYaw: cam.yaw, time: env.time, weather: env.weather, savedAt: Date.now() }));
    if (!silent) emit('toast', 'Progress saved');
  } catch (e) { console.warn('save failed', e); }
}
export function loadGame() {
  if (NOSAVE) return false;
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (!s || s.v !== 1) return false;
    S.money = s.money ?? 500; S.unlocked = s.unlocked || []; S.missions = s.missions || {}; S.radio = s.radio ?? 0;
    if (s.progress) Object.assign(S.progress, s.progress);
    if (s.weapons) for (const k in S.weapons) Object.assign(S.weapons[k], s.weapons[k] || {});
    if (S.weapons[s.weapon]?.owned) S.weapon = s.weapon;
    player.health = s.health > 0 ? s.health : 100; player.armor = s.armor ?? 0;
    if (Array.isArray(s.pos) && s.pos.every(Number.isFinite)) player.pos.set(...s.pos);
    player.facing = s.facing ?? player.facing; cam.yaw = s.camYaw ?? player.facing + Math.PI;
    env.time = s.time ?? 9; setWeather(WEATHERS.includes(s.weather) ? s.weather : 'clear', false);
    return true;
  } catch (e) { return false; }
}
