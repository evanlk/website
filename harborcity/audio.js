// audio.js — Web Audio synthesis: engine, tyres, horn, impacts, explosions, ambience, procedural radio
import { mulberry32 } from './core.js';

/* =====================================================================
   AUDIO: context, buses, shared noise
   ===================================================================== */
let ctx = null, master, sfxBus, musicBus, noiseBuf;
export const audioSettings = { volume: 0.8, music: 0.55 };
const loops = {};

export function initAudio() {
  if (ctx) { ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 5;
  master = gain(audioSettings.volume); comp.connect(master); master.connect(ctx.destination);
  sfxBus = gain(1); sfxBus.connect(comp);
  // radio goes through a "car speaker" band-limit
  musicBus = gain(audioSettings.music);
  const hp = filter('highpass', 80), lp = filter('lowpass', 7500);
  musicBus.connect(hp); hp.connect(lp); lp.connect(comp);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  buildLoops();
  setInterval(radioTick, 30);
}
export const suspendAudio = () => ctx?.suspend();
export const resumeAudio = () => ctx?.resume();

function gain(v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }
function filter(type, f, q = 0.7) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
function osc(type, f) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; }
function noise(loop = false) { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = loop; if (!loop) s.playbackRate.value = 0.8 + Math.random() * 0.4; return s; }
const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };
const target = (param, v, tc = 0.05) => param.setTargetAtTime(v, ctx.currentTime, tc);

/* =====================================================================
   AUDIO: continuous loops (engine, tyre skid, horn, rain)
   ===================================================================== */
function buildLoops() {
  // engine: saw + sub square + filtered noise, through a resonant low-pass
  const o1 = osc('sawtooth', 50), o2 = osc('square', 25), nz = noise(true);
  const lp = filter('lowpass', 300, 3), g = gain(0), o2g = gain(0.5), nb = filter('bandpass', 180, 1), ng = gain(0.35);
  o1.connect(lp); chain(o2, o2g, lp); chain(nz, nb, ng, lp); chain(lp, g, sfxBus);
  o1.start(); o2.start(); nz.start();
  loops.engine = { o1, o2, lp, g };
  // tyre skid
  const sn = noise(true), sb = filter('bandpass', 2100, 4), sg = gain(0); chain(sn, sb, sg, sfxBus); sn.start();
  loops.skid = sg;
  // horn: two detuned squares
  const h1 = osc('square', 392), h2 = osc('square', 494), hl = filter('lowpass', 1600), hg = gain(0);
  h1.connect(hl); h2.connect(hl); chain(hl, hg, sfxBus); h1.start(); h2.start();
  loops.horn = hg;
  // rain ambience
  const rn = noise(true), rl = filter('lowpass', 2600), rh = filter('highpass', 400), rg = gain(0); chain(rn, rl, rh, rg, sfxBus); rn.start();
  loops.rain = rg;
  // police siren: two-tone wail driven by an LFO
  const so = osc('sawtooth', 900), lfo = osc('sine', 0.35), lfoG = gain(340), sl = filter('lowpass', 2400), sirG = gain(0);
  lfo.connect(lfoG); lfoG.connect(so.frequency); chain(so, sl, sirG, sfxBus); so.start(); lfo.start();
  loops.siren = sirG;
}
export const setSiren = v => ctx && target(loops.siren.gain, v * 0.07, 0.1);
export function setEngine(on, rpm, throttle, base) {
  if (!ctx) return; const e = loops.engine, f = base * (0.55 + rpm * 2.5);
  target(e.o1.frequency, f, 0.04); target(e.o2.frequency, f * 0.5, 0.04);
  target(e.lp.frequency, 220 + 2200 * (0.35 * rpm + 0.65 * throttle), 0.06);
  target(e.g.gain, on ? 0.05 + 0.07 * throttle + 0.04 * rpm : 0, 0.08);
}
export const setSkid = a => ctx && target(loops.skid.gain, a * 0.11, 0.05);
export const setHorn = on => ctx && target(loops.horn.gain, on ? 0.09 : 0, 0.015);
export const setRain = a => ctx && target(loops.rain.gain, a * 0.06, 0.5);

/* =====================================================================
   AUDIO: one-shots
   ===================================================================== */
export function crash(intensity) {
  if (!ctx || intensity <= 0.02) return; const t = ctx.currentTime;
  const n = noise(), lp = filter('lowpass', 900 + intensity * 2500), g = gain(0);
  g.gain.setValueAtTime(Math.min(0.9, intensity), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + intensity * 0.35);
  chain(n, lp, g, sfxBus); n.start(t); n.stop(t + 0.8);
  const o = osc('sine', 90), og = gain(0); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
  og.gain.setValueAtTime(intensity * 0.8, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.3); chain(o, og, sfxBus); o.start(t); o.stop(t + 0.35);
}
export function explosion(vol) {
  if (!ctx || vol <= 0.01) return; const t = ctx.currentTime;
  const n = noise(), lp = filter('lowpass', 3500), g = gain(0);
  lp.frequency.setValueAtTime(3500, t); lp.frequency.exponentialRampToValueAtTime(150, t + 2);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 2.4); chain(n, lp, g, sfxBus); n.start(t); n.stop(t + 2.5);
  const o = osc('sine', 60), og = gain(0); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(22, t + 0.9);
  og.gain.setValueAtTime(vol * 1.2, t); og.gain.exponentialRampToValueAtTime(0.001, t + 1.1); chain(o, og, sfxBus); o.start(t); o.stop(t + 1.2);
}
export function splashSfx(vol) {
  if (!ctx) return; const t = ctx.currentTime, n = noise(), bp = filter('bandpass', 700, 0.8), g = gain(0);
  g.gain.setValueAtTime(vol * 0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7); chain(n, bp, g, sfxBus); n.start(t); n.stop(t + 0.8);
}
export function honk(vol, pitch = 1) {
  if (!ctx || vol <= 0.01) return; const t = ctx.currentTime, dur = 0.25 + Math.random() * 0.3;
  const lp = filter('lowpass', 1500), g = gain(0); g.gain.setValueAtTime(vol * 0.12, t); g.gain.setValueAtTime(vol * 0.12, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
  for (const f of [370, 466]) { const o = osc('square', f * pitch); o.connect(lp); o.start(t); o.stop(t + dur + 0.06); }
  chain(lp, g, sfxBus);
}
// weapons: noise crack + low thump, shaped per weapon
const GUN = { pistol: [0.16, 900, 3800, 0.55], smg: [0.09, 1100, 4200, 0.4], shotgun: [0.38, 300, 2400, 0.85], cop: [0.15, 800, 3400, 0.5] };
export function gunshot(kind, vol = 1) {
  if (!ctx || vol <= 0.01) return; const [dur, hp, lpf, v] = GUN[kind] || GUN.pistol, t = ctx.currentTime;
  const n = noise(), h = filter('highpass', hp), l = filter('lowpass', lpf), g = gain(0);
  g.gain.setValueAtTime(v * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); chain(n, h, l, g, sfxBus); n.start(t); n.stop(t + dur + 0.05);
  const o = osc('sine', 140), og = gain(0); o.frequency.setValueAtTime(kind === 'shotgun' ? 110 : 160, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
  og.gain.setValueAtTime(v * vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12); chain(o, og, sfxBus); o.start(t); o.stop(t + 0.15);
}
function click(f, v, d = 0.03) { if (!ctx) return; const t = ctx.currentTime, o = osc('square', f), g = gain(0); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); chain(o, g, sfxBus); o.start(t); o.stop(t + d + 0.02); }
export const emptyClick = () => click(1800, 0.08);
export function reloadSfx() { if (!ctx) return; click(900, 0.1); setTimeout(() => click(600, 0.12, 0.05), 350); setTimeout(() => click(1200, 0.1), 800); }
export function punch(hit) {
  if (!ctx) return; const t = ctx.currentTime, n = noise(), l = filter('lowpass', hit ? 700 : 2500), g = gain(0);
  g.gain.setValueAtTime(hit ? 0.6 : 0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + (hit ? 0.15 : 0.2)); chain(n, l, g, sfxBus); n.start(t); n.stop(t + 0.25);
}
export function hurt() { if (!ctx) return; const t = ctx.currentTime, o = osc('triangle', 220), g = gain(0); o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.18);
  g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2); chain(o, g, sfxBus); o.start(t); o.stop(t + 0.22); }
export function pickupSfx() { if (!ctx) return; click(880, 0.08, 0.08); setTimeout(() => click(1320, 0.08, 0.1), 90); }
export function door() {
  if (!ctx) return; const t = ctx.currentTime, n = noise(), lp = filter('lowpass', 500), g = gain(0);
  g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); chain(n, lp, g, sfxBus); n.start(t); n.stop(t + 0.15);
}
function staticBurst() {
  const t = ctx.currentTime, n = noise(), bp = filter('bandpass', 2500, 0.6), g = gain(0);
  g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22); chain(n, bp, g, musicBus); n.start(t); n.stop(t + 0.25);
}

/* =====================================================================
   AUDIO: procedural radio — instruments
   ===================================================================== */
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
function envGain(t, a, peak, d) {
  const g = gain(0); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); g.connect(musicBus); return g;
}
function kick(t, v = 1, chip = false) {
  const o = osc('sine', 150); o.frequency.setValueAtTime(chip ? 220 : 150, t); o.frequency.exponentialRampToValueAtTime(42, t + (chip ? 0.06 : 0.12));
  o.connect(envGain(t, 0.002, 0.9 * v, chip ? 0.12 : 0.32)); o.start(t); o.stop(t + 0.4);
}
function snare(t, v = 1) {
  const n = noise(), hp = filter('highpass', 1400); chain(n, hp, envGain(t, 0.001, 0.45 * v, 0.17)); n.start(t); n.stop(t + 0.25);
  const o = osc('triangle', 185); o.connect(envGain(t, 0.001, 0.3 * v, 0.08)); o.start(t); o.stop(t + 0.12);
}
function clap(t, v = 1) {
  for (let i = 0; i < 3; i++) { const n = noise(), bp = filter('bandpass', 1300, 1.2); chain(n, bp, envGain(t + i * 0.012, 0.001, 0.4 * v, i === 2 ? 0.16 : 0.02)); n.start(t + i * 0.012); n.stop(t + 0.25); }
}
function hat(t, v = 0.3, open = false) {
  const n = noise(), hp = filter('highpass', 7800); chain(n, hp, envGain(t, 0.001, v, open ? 0.22 : 0.04)); n.start(t); n.stop(t + 0.3);
}
function tone(t, midi, dur, v, type = 'sawtooth', cutoff = 1500, attack = 0.005, detune = 0) {
  const o = osc(type, mtof(midi)); o.detune.value = detune; const lp = filter('lowpass', cutoff);
  chain(o, lp, envGain(t, attack, v, Math.max(0.05, dur))); o.start(t); o.stop(t + attack + dur + 0.05);
}
function pad(t, notes, dur, v) {
  for (const m of notes) for (const dt of [-9, 9]) {
    const o = osc('sawtooth', mtof(m)); o.detune.value = dt; const lp = filter('lowpass', 1000);
    const g = gain(0); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.5); g.gain.setValueAtTime(v, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.3); g.connect(musicBus); chain(o, lp, g); o.start(t); o.stop(t + dur + 0.4);
  }
}
function keys(t, notes, v) {
  for (const m of notes) { const o = osc('sine', mtof(m)), o2 = osc('sine', mtof(m) * 2.005), g2 = gain(0.25);
    const e = envGain(t, 0.006, v, 1.6); o.connect(e); o2.connect(g2); g2.connect(e); o.start(t); o2.start(t); o.stop(t + 1.7); o2.stop(t + 1.7); }
}
function crackle(t) {
  const n = noise(), hp = filter('highpass', 3000); chain(n, hp, envGain(t, 0.0005, 0.05 + Math.random() * 0.08, 0.008)); n.start(t); n.stop(t + 0.02);
}

/* =====================================================================
   AUDIO: procedural radio — stations
   ===================================================================== */
const MINOR = [0, 2, 3, 5, 7, 8, 10], MAJOR = [0, 2, 4, 5, 7, 9, 11];
const deg = (root, sc, d) => root + sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
const triad = (root, sc, d, seventh = false) => [0, 2, 4, ...(seventh ? [6] : [])].map(i => deg(root, sc, d + i));
// Melody: 4 bars of 16 steps, second half echoes the first with a new ending, so it sounds composed rather than random.
function makeMelody(seed, density, range) {
  const r = mulberry32(seed), m = new Array(64).fill(null);
  for (let i = 0; i < 32; i++) if (r() < density * (i % 4 === 0 ? 1.6 : i % 2 === 0 ? 1 : 0.55)) m[i] = Math.floor(r() * range);
  for (let i = 32; i < 64; i++) m[i] = i < 56 ? m[i - 32] : (r() < density ? Math.floor(r() * range) : null);
  return m;
}
export const STATIONS = [
  { name: 'Harbor FM', genre: 'Sunset Synth', bpm: 100, swing: 0, mel: makeMelody(11, 0.35, 8),
    play(s, t, spb, bar) { const ch = [0, 5, 2, 6][bar % 4], root = 45, sc = MINOR;
      if (s % 8 === 0) kick(t); if (s === 4 || s === 12) snare(t, 0.7); if (s % 2 === 0) hat(t, 0.08, s === 14);
      if (s % 2 === 0) tone(t, deg(root, sc, ch) + (s % 4 === 2 ? 12 : 0), spb * 1.6, 0.16, 'sawtooth', 520);
      if (s === 0) pad(t, triad(root + 12, sc, ch), spb * 16, 0.035);
      tone(t, deg(root + 24, sc, ch + [0, 2, 4, 7][s % 4]), spb * 0.8, 0.028, 'square', 2200);
      const n = this.mel[(bar % 4) * 16 + s]; if (n !== null && bar % 8 >= 4) tone(t, deg(root + 24, sc, n), spb * 2.5, 0.06, 'triangle', 3000, 0.01); } },
  { name: 'Pulse 101', genre: 'Club House', bpm: 124, swing: 0, mel: makeMelody(23, 0.3, 7),
    play(s, t, spb, bar) { const ch = [0, 0, 5, 4][bar % 4], root = 41, sc = MINOR;
      if (s % 4 === 0) kick(t); if (s === 4 || s === 12) clap(t, 0.8); if (s % 4 === 2) hat(t, 0.13, true); else hat(t, 0.035);
      if (s % 4 === 2) tone(t, deg(root, sc, ch) + 12, spb * 1.4, 0.2, 'sawtooth', 650);
      if ([0, 3, 6, 10].includes(s)) for (const m of triad(root + 24, sc, ch)) tone(t, m, spb * 0.6, 0.04, 'square', 1700);
      const n = this.mel[(bar % 4) * 16 + s]; if (n !== null && bar % 8 >= 2) tone(t, deg(root + 36, sc, n), spb * 0.9, 0.04, 'sawtooth', 2600); } },
  { name: 'Low Tide Radio', genre: 'Lo-fi Beats', bpm: 80, swing: 0.2, mel: makeMelody(37, 0.22, 9),
    play(s, t, spb, bar) { const ch = [1, 4, 0, 5][bar % 4], root = 48, sc = MAJOR;
      if (s === 0 || s === 7 || s === 10) kick(t, 0.8); if (s === 4 || s === 12) snare(t, 0.45); if (s % 2 === 0) hat(t, 0.05);
      if (s === 0 || s === 8) keys(t, triad(root + 12, sc, ch, true), 0.05);
      if (s === 0 || s === 10) tone(t, deg(root - 12, sc, ch), spb * 5, 0.32, 'sine', 400, 0.01);
      const n = this.mel[(bar % 4) * 16 + s]; if (n !== null) tone(t, deg(root + 24, sc, [0, 2, 4, 7, 9, 11, 14, 16, 18][n]), spb * 3, 0.045, 'triangle', 1800, 0.02);
      if (Math.random() < 0.35) crackle(t + Math.random() * spb); } },
  { name: 'Neon Arcade', genre: 'Chiptune', bpm: 140, swing: 0, mel: makeMelody(59, 0.6, 10),
    play(s, t, spb, bar) { const ch = [0, 3, 5, 4][bar % 4], root = 52, sc = MINOR;
      if (s % 4 === 0) kick(t, 0.8, true); if (s === 4 || s === 12) snare(t, 0.4); if (s % 2 === 1) hat(t, 0.04);
      if (s % 2 === 0) tone(t, deg(root - 12, sc, ch) + (s % 4 ? 12 : 0), spb * 1.5, 0.18, 'triangle', 4000);
      const n = this.mel[(bar % 4) * 16 + s]; if (n !== null) tone(t, deg(root + 12, sc, ch + n), spb * 0.85, 0.05, 'square', 5000);
      tone(t, deg(root + 24, sc, ch + [0, 2, 4][s % 3]), spb * 0.4, 0.016, 'square', 5000); } },
];

// Stations are "live": the playhead is derived from the audio clock, so tuning back in resumes mid-song.
let radioIdx = -1, rStep = 0, rNext = 0;
export function setRadio(i) {
  if (!ctx) return;
  radioIdx = i; if (i < 0) return;
  const spb = 60 / STATIONS[i].bpm / 4, now = ctx.currentTime + 0.06;
  rStep = Math.ceil(now / spb); rNext = rStep * spb; staticBurst();
}
function radioTick() {
  if (!ctx || radioIdx < 0 || ctx.state !== 'running') return;
  const st = STATIONS[radioIdx], spb = 60 / st.bpm / 4;
  while (rNext < ctx.currentTime + 0.15) {
    const s = rStep % 16, bar = Math.floor(rStep / 16);
    st.play(s, rNext + (s % 2 ? st.swing * spb : 0), spb, bar);
    rStep++; rNext += spb;
  }
}
export const setMusicVolume = v => { audioSettings.music = v; if (musicBus) musicBus.gain.value = v; };
export const setMasterVolume = v => { audioSettings.volume = v; if (master) master.gain.value = v; };
export const audioDebug = () => ({ state: ctx?.state, time: ctx?.currentTime, radioIdx, rStep });
