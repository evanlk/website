// main.js — boot, key bindings, main loop
import { S, cam, renderer, scene, camera, timeU, emit, on, clamp } from './core.js';
import { generateWorld, updateChunkVisibility, groundAt, parkingSpots, baseGround } from './world.js';
import { env, updateEnv, setWeather, WEATHERS } from './env.js';
import { input, keys, bind, pollInput, forceInput } from './input.js';
import { player, updatePlayer, animateCharacter, tryEnterExit, enterVehicle, findLedge } from './player.js';
import { vehicles, updateVehicles, updateSpawns, spawnVehicle } from './vehicles.js';
import { updateCamera } from './camera.js';
import { updateParticles, splash, emitP, smoke } from './particles.js';
import * as sfx from './audio.js';
import { bigText, toast, clockStr, toggleDebug, toggleHelp, radioName, buildMapCanvas, updateHUD, helpEl, fps } from './ui.js';
import { showTitle, showPause, hideOverlay, setHandlers, setLoading, applySettings, openPhone, openMap, updateWaypoint, overlayOpen, dynamicResolution, currentResolution } from './menus.js';
import { saveGame, loadGame } from './save.js';
import { buildRoadGraph, buildLightProps, buildSidewalkGraph, updateLights, nodes, edges, pnodes } from './nav.js';
import { updateTraffic, drivers } from './traffic.js';
import { updatePeds, peds } from './peds.js';
import { updateCombat, selectWeapon, cycleWeapon, reload, ORDER, combat, WEAPONS } from './combat.js';
import { updatePolice, wanted, units, clearWanted, despawnAllPolice, buildStations, placePickups, hospitals, stations, nearest, addCrime } from './police.js';
import { respawnPlayer, damagePlayer } from './player.js';
import { buildMissions, updateMissions, interactable, advanceDialogue, MS, startMission, MISSIONS, ACTIVITIES, cancelMission } from './missions.js';
import { buildShops, shopInteractable, updateShops, applyOutfit } from './shops.js';
import { menuKey } from './menu.js';
import { CFG, SAVE_KEY } from './core.js';

/* =====================================================================
   MAIN: key bindings
   ===================================================================== */
// E: talk / start missions / open shops; Space, Enter and E advance dialogue; arrows/Enter/Esc drive menus
bind('KeyE', () => { if (S.menu) { menuKey('KeyE'); return; } if (MS.dlg) { advanceDialogue(); return; } if (player.vehicle || S.paused) return; const a = interactable() || shopInteractable(); a?.go(); });
for (const k of ['Space', 'Enter']) bind(k, () => { if (MS.dlg && !S.menu) advanceDialogue(); });
for (const k of ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Enter', 'Space', 'Escape', 'Backspace']) bind(k, () => menuKey(k));
bind('Tab', openPhone); bind('KeyM', () => { if (!S.paused && !S.menu) openMap(); });
bind('KeyT', () => { env.time = (env.time + 1) % 24; toast('Time: ' + clockStr()); });
bind('KeyY', () => setWeather(WEATHERS[(WEATHERS.indexOf(env.weather) + 1) % 3]));
bind('KeyH', toggleHelp);
bind('F3', toggleDebug); bind('Backquote', toggleDebug);
bind('KeyF', () => { if (!S.paused) tryEnterExit(); });
const cycleRadio = d => { if (!player.vehicle) return; const n = sfx.STATIONS.length; S.radio = ((S.radio + 1 + d) % (n + 1) + n + 1) % (n + 1) - 1; sfx.setRadio(S.radio); toast(radioName(S.radio), 1.8); };
bind('KeyR', () => { if (player.vehicle) cycleRadio(1); else reload(); }); bind('KeyQ', () => cycleRadio(-1));
bind('Reload', reload);
ORDER.forEach((k, i) => bind('Digit' + (i + 1), () => selectWeapon(k)));
bind('WeaponNext', () => cycleWeapon(1)); bind('WeaponPrev', () => cycleWeapon(-1));
bind('WheelDown', () => { if (player.vehicle) cam.vDist = clamp(cam.vDist + 0.8, -3, 8); else cam.dist = clamp(cam.dist + 0.5, 2.5, 9); });
bind('WheelUp', () => { if (player.vehicle) cam.vDist = clamp(cam.vDist - 0.8, -3, 8); else cam.dist = clamp(cam.dist - 0.5, 2.5, 9); });
bind('Locked', () => { if (!S.paused) return; S.paused = false; hideOverlay(); sfx.resumeAudio(); emit('mapClosed'); });
bind('Unlocked', () => pause());
bind('Pause', () => S.paused ? resumeGame() : pause());
bind('Start', () => startGame());
on('enterVehicle', v => { sfx.setRadio(v.dead ? -1 : S.radio); if (S.radio >= 0) toast(radioName(S.radio), 1.8); });
on('exitVehicle', () => { sfx.setRadio(-1); sfx.setEngine(false, 0, 0, 50); sfx.setSkid(0); sfx.setHorn(false); });
on('splash', (x, y, z, a) => { splash(x, y, z, 20, a); sfx.splashSfx(a); });
on('wantedChanged', l => { if (l > 0) sfx.setSiren(0); });
let bigT = 0;
const card = (title, sub, secs = 3.5) => { bigText(title, sub); bigT = secs; };
on('missionPassed', (m, reward, note) => card(m.race ? 'RACE WON' : m.activity ? 'SHIFT OVER' : 'MISSION COMPLETE', note || (reward ? `${m.title}  ·  +$${reward.toLocaleString('en-US')}` : m.title)));
on('missionFailed', (m, reason) => card(m.race ? 'RACE LOST' : 'MISSION FAILED', reason));
on('missionStart', m => toast(m.title, 2.5));
on('stuntJump', (dist, first) => first ? card('STUNT JUMP!', `${dist.toFixed(0)} m  ·  +$500`, 2.5) : toast(`Jump: ${dist.toFixed(0)} m (already completed)`, 2));
on('save', loud => saveGame(!loud));
// slow motion on big crashes in the player's vehicle
let slowT = 0;
on('vehicleImpact', (v, speed) => { if (v === player.vehicle && speed > 17 && S.timeScale === 1 && !respawnKind) { S.timeScale = 0.3; slowT = 0.9; cam.shake = Math.max(cam.shake, 0.8); } });

// death → hospital, arrest → police station (slow motion while the title card shows)
let respawnT = 0, respawnKind = null;
on('playerDied', () => { if (respawnKind) return; respawnKind = 'hospital'; respawnT = 4; S.timeScale = 0.35; bigText('HOSPITALIZED', 'Patched up — the bill is on its way'); });
on('playerBusted', () => { if (respawnKind) return; respawnKind = 'police'; respawnT = 3.5; S.timeScale = 0.5; player.knock = 99; bigText('ARRESTED', 'Bail will be deducted'); });
function doRespawn() {
  const s = nearest(respawnKind === 'hospital' ? hospitals : stations, player.pos);
  const fee = Math.min(S.money, Math.round(100 + S.money * 0.1));
  S.money -= fee; despawnAllPolice(); clearWanted(true);
  respawnPlayer(s.x, s.z, s.facing);
  if (respawnKind === 'police') for (const k of ['pistol', 'smg', 'shotgun']) S.weapons[k].reserve = Math.floor(S.weapons[k].reserve / 2);   // half your ammo is confiscated
  toast(`${respawnKind === 'hospital' ? 'Hospital bill' : 'Bail'}: -$${fee}`, 3.5);
  S.timeScale = 1; bigText(''); respawnKind = null; saveGame();
}

function pause() { if (!S.started || S.paused || S.menu) return; S.paused = true; showPause(); saveGame(); sfx.suspendAudio(); document.exitPointerLock?.(); }
function startGame() {
  sfx.initAudio();
  if (!S.started) { S.started = true; document.body.classList.add('playing'); helpEl.style.opacity = 1; setTimeout(() => helpEl.style.opacity = 0, 15000); }
  resumeGame();
}
function resumeGame() {
  S.paused = false; hideOverlay(); sfx.resumeAudio(); emit('mapClosed');
  try { const r = renderer.domElement.requestPointerLock?.(); r?.catch?.(() => {}); } catch (e) {}
}
setHandlers({ start: startGame, resume: resumeGame, save: () => saveGame(), pauseForMap: () => pause() });
addEventListener('pagehide', () => { if (S.started) saveGame(); });

/* =====================================================================
   MAIN: simulation step + render loop
   ===================================================================== */
let spawnTimer = 0, autosaveTimer = 30, hornWas = false;
// lightweight profiler (exponential moving average, ms) — shown in the F3 debug panel
export const prof = {}; window.__prof = prof;
function T(name, fn) { const t0 = performance.now(); fn(); prof[name] = (prof[name] ?? 0) * 0.95 + (performance.now() - t0) * 0.05; }
// rain hitting the ground near the camera and splashes around a swimming player
function ambientFx(dt) {
  if (env.rain > 0.1 && settingsQualityAllowsFx()) {
    for (let n = env.rain * dt * 90; n > 0; n--) { if (n < 1 && Math.random() > n) break;
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 16, x = camera.position.x + Math.cos(a) * r, z = camera.position.z + Math.sin(a) * r, y = Math.max(baseGround(x, z), CFG.waterY);
      emitP(smoke, x, y + 0.03, z, 0, 0.6, 0, 0.25, 0.08, 0.3, [0.8, 0.85, 0.95, 0.5], [0.8, 0.85, 0.95, 0], 2, 3); }
  }
  if (player.swimming && Math.hypot(player.vel.x, player.vel.z) > 0.8 && Math.random() < dt * 6) splash(player.pos.x, CFG.waterY, player.pos.z, 2, 0.4);
}
const settingsQualityAllowsFx = () => (window.__q ?? 'high') !== 'low';
function vehicleAudio() {
  const v = player.vehicle;
  if (v && !v.dead) {
    const T = v.T, ratio = Math.min(1, Math.abs(v.vF) / T.maxSpeed), g = ratio * 5, gi = Math.min(4, Math.floor(g));
    let rpm = gi === 0 ? 0.12 + g * 0.75 : 0.35 + (g - gi) * 0.6;
    if (!v.grounded || (T.kind === 'boat' && !v.inWater)) rpm = Math.min(1, rpm + 0.4 * Math.abs(v.throttle));
    sfx.setEngine(true, rpm, Math.abs(v.throttle), T.engine);
    sfx.setSkid(v.grounded && T.kind !== 'boat' ? clamp((v.slip - 4.5) / 8, 0, 1) : 0);
    sfx.setHorn(input.horn && T.kind !== 'boat');
    if (input.horn && !hornWas) emit('playerHorn');
    hornWas = input.horn; if (input.horn) S.hornTime = timeU.value;
  } else { sfx.setEngine(false, 0, 0, 50); sfx.setSkid(0); sfx.setHorn(false); }
  sfx.setRain(env.rain);
}
function simulate(dt) {
  if (S.menu) return;   // shop menus freeze the world
  if (S.cutscene || S.countdown) Object.assign(input, { x: 0, y: 0, jump: false, fire: false, firePressed: false, aim: false, throttle: 0, steer: 0, handbrake: !!S.countdown, sprint: false });
  const v = player.vehicle;
  T('traffic', () => updateTraffic(dt, player.pos));
  T('police', () => updatePolice(dt));
  T('combat', () => updateCombat(dt));
  T('vehicles', () => updateVehicles(dt, v, v ? { throttle: input.throttle, steer: input.steer, handbrake: input.handbrake } : null));
  T('player', () => updatePlayer(dt));
  T('peds', () => updatePeds(dt, player.pos));
  updateLights(false, dt);
  T('missions', () => { updateMissions(dt); updateShops(); updateWaypoint(); });
  ambientFx(dt);
  if ((spawnTimer -= dt) <= 0) { spawnTimer = 0.5; updateSpawns(player.pos, player.lastVehicle); }
  if ((autosaveTimer -= dt) <= 0) { autosaveTimer = 30; saveGame(); }
}
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.05, (now - last) / 1000); last = now;
  const dt = realDt * S.timeScale;
  if (S.started && !S.paused) dynamicResolution(realDt);
  if (respawnT > 0 && (respawnT -= realDt) <= 0) doRespawn();
  if (bigT > 0 && (bigT -= realDt) <= 0 && !respawnKind) bigText('');
  if (slowT > 0 && (slowT -= realDt) <= 0 && !respawnKind && S.timeScale < 1) S.timeScale = 1;
  timeU.value += dt;
  pollInput(dt);
  if (!S.paused) simulate(dt);
  T('env', () => updateEnv(S.paused ? 0 : dt, player.pos));
  animateCharacter(dt);
  updateCamera(dt);
  T('particles', () => updateParticles(S.paused ? 0 : dt));
  vehicleAudio();
  updateChunkVisibility();
  T('render', () => renderer.render(scene, camera));
  T('hud', () => updateHUD(dt));
}

/* =====================================================================
   MAIN: boot
   ===================================================================== */
function boot() {
  const t0 = performance.now();
  applySettings();
  generateWorld(() => { buildRoadGraph(); buildLightProps(); buildSidewalkGraph(); buildStations(); });
  placePickups();
  buildMissions(); buildShops();
  buildMapCanvas();
  cam.yaw = player.facing + Math.PI;
  const loaded = loadGame();
  applyOutfit();
  player.pos.y = groundAt(player.pos.x, player.pos.z, player.pos.y + 0.3);
  cam.focus.copy(player.pos).y += 1.6;
  updateSpawns(player.pos, null, true);
  updateEnv(0, player.pos);
  renderer.compile(scene, camera);
  console.log(`[harborcity] generated in ${(performance.now() - t0).toFixed(0)}ms, parking spots ${parkingSpots.length}, vehicles ${vehicles.length}, road nodes ${nodes.length}, edges ${edges.length}, sidewalk nodes ${pnodes.length}`);
  showTitle(loaded);
  if (sessionStorage.getItem('harborcity.autostart')) { sessionStorage.removeItem('harborcity.autostart'); startGame(); }
  requestAnimationFrame(frame);
}
// debug handle for testing in the console
window.HC = { currentResolution, prof, openPhone, openMap, MS, startMission, MISSIONS, ACTIVITIES, cancelMission, player, cam, env, S, input, forceInput, keys, vehicles, drivers, peds, nodes, edges, wanted, units, addCrime, clearWanted, damagePlayer, combat, selectWeapon, hospitals, stations, spawnVehicle, enterVehicle, findLedge, saveGame, setWeather, renderer, scene, camera,
  get fps() { return fps; },
  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) { if (respawnT > 0 && (respawnT -= dt) <= 0) doRespawn(); timeU.value += dt; pollInput(dt); simulate(dt); updateEnv(dt, player.pos); animateCharacter(dt); updateCamera(dt); updateParticles(dt); } } };
setTimeout(boot, 30);
