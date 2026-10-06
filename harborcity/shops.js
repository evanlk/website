// shops.js — car dealer, gun shop, clothing store, safehouses (save / sleep / owned vehicles)
import { S, emit, fmtMoney } from './core.js';
import { player, setOutfit } from './player.js';
import { spawnVehicle, TYPES, vehicles } from './vehicles.js';
import { WEAPONS, giveWeapon } from './combat.js';
import { spot, GIVERS, beaconAt } from './missions.js';
import { openMenu, refreshMenu, closeMenu } from './menu.js';
import { env } from './env.js';
import * as sfx from './audio.js';

/* =====================================================================
   SHOPS: catalogue
   ===================================================================== */
const CARS = { sedan: 2000, moto: 3500, truck: 4000, boat: 6000, sports: 9000 };
export const OUTFITS = {
  default: { name: 'Road jacket (teal)', price: 0, shirt: 0x2f7f86, pants: 0x2d3142, shoes: 0xeeeeee, hair: 0x2b1d14 },
  racer:   { name: 'Racing red', price: 150, shirt: 0xb32428, pants: 0x1b1b1b, shoes: 0xf2f2f2 },
  coast:   { name: 'Coastline casual', price: 250, shirt: 0xf3e3a6, pants: 0x3e6e8e, shoes: 0x8b6a48 },
  night:   { name: 'Night shift (all black)', price: 400, shirt: 0x1d1e22, pants: 0x121316, shoes: 0x1d1e22 },
  dock:    { name: 'Dockworker hi-vis', price: 300, shirt: 0xf2a33a, pants: 0x2c3e50, shoes: 0x5d4037 },
  stunt:   { name: 'Stunt suit (white & gold)', price: 900, shirt: 0xf2f2ee, pants: 0xd4a017, shoes: 0xd4a017 },
};
const P = () => S.progress;
export const SHOPS = [];
const money = (n, msg) => { if (S.money < n) { emit('toast', "You can't afford that."); sfx.emptyClick(); return false; } S.money -= n; sfx.pickupSfx(); if (msg) emit('toast', msg, 2.2); return true; };

export function buildShops() {
  const loft = spot(-150, -450);
  SHOPS.push(
    { id: 'cars', name: 'Coastline Motors', sub: 'Vehicles are delivered to the curb outside.', at: spot(350, 150), menu: carMenu },
    { id: 'guns', name: 'Bayside Arms', sub: 'Weapons, ammunition and body armour.', at: spot(-250, 250), menu: gunMenu },
    { id: 'clothes', name: 'Threadline Outfitters', sub: 'Look the part.', at: spot(150, -350), menu: clothesMenu },
    { id: 'garage', name: 'Calloway Garage (safehouse)', sub: 'Save, rest, and take out your vehicles.', at: GIVERS.garage, requires: () => P().done.m1, menu: safeMenu },
    { id: 'loft', name: 'Harbor Heights Loft', sub: 'A second safehouse uptown.', at: loft, menu: loftMenu },
  );
  for (const s of SHOPS) s.mark = beaconAt(s.id === 'garage' || s.id === 'loft' ? 'safe' : 'shop', s.at.x, s.at.z);
  applyOutfit();
}
export function applyOutfit() { setOutfit(OUTFITS.default); setOutfit(OUTFITS[P().outfit] || OUTFITS.default); }

/* =====================================================================
   SHOPS: menus
   ===================================================================== */
function deliver(type, at) {
  const c = type === 'boat' ? { x: 311, z: 770, h: Math.PI } : at.car;
  const v = spawnVehicle(type, c.x, c.z, c.h); v.keep = false;
  emit('toast', type === 'boat' ? 'Your boat is waiting at the Saltline pier.' : `${TYPES[type].name} delivered outside.`, 2.5);
  return v;
}
function carMenu(shop) {
  const items = () => Object.entries(CARS).map(([t, price]) => ({ t, label: TYPES[t].name, right: P().cars.includes(t) ? 'Owned — deliver' : fmtMoney(price) }));
  openMenu(shop.name, shop.sub, items(), it => {
    if (P().cars.includes(it.t)) { closeMenu(); deliver(it.t, shop.at); return; }
    if (money(CARS[it.t], `Bought: ${TYPES[it.t].name}`)) { P().cars.push(it.t); deliver(it.t, shop.at); refreshMenu(items()); emit('save'); }
  });
}
function gunMenu(shop) {
  const W = S.weapons;
  const items = () => [
    { k: 'smg', label: 'SMG', right: W.smg.owned ? 'Owned' : '$2,500', price: 2500, disabled: W.smg.owned },
    { k: 'shotgun', label: 'Shotgun', right: W.shotgun.owned ? 'Owned' : '$3,000', price: 3000, disabled: W.shotgun.owned },
    { k: 'ammo-pistol', label: 'Pistol ammo ×24', right: '$80', price: 80, disabled: !W.pistol.owned },
    { k: 'ammo-smg', label: 'SMG ammo ×60', right: '$150', price: 150, disabled: !W.smg.owned },
    { k: 'ammo-shotgun', label: 'Shotgun shells ×12', right: '$120', price: 120, disabled: !W.shotgun.owned },
    { k: 'armor', label: 'Body armour', right: player.armor >= 100 ? 'Full' : '$400', price: 400, disabled: player.armor >= 100 },
  ];
  openMenu(shop.name, shop.sub, items(), it => {
    if (!money(it.price)) return;
    if (it.k === 'smg' || it.k === 'shotgun') giveWeapon(it.k, it.k === 'smg' ? 60 : 12);
    else if (it.k === 'armor') player.armor = 100;
    else { const w = it.k.slice(5); W[w].reserve = Math.min(WEAPONS[w].maxReserve, W[w].reserve + { pistol: 24, smg: 60, shotgun: 12 }[w]); }
    emit('toast', `Bought: ${it.label}`, 1.8); refreshMenu(items()); emit('save');
  });
}
function clothesMenu(shop) {
  const items = () => Object.entries(OUTFITS).map(([k, o]) => ({ k, label: o.name, right: P().outfit === k ? 'Wearing' : P().outfits.includes(k) ? 'Owned' : fmtMoney(o.price) }));
  openMenu(shop.name, shop.sub, items(), it => {
    const o = OUTFITS[it.k];
    if (!P().outfits.includes(it.k)) { if (!money(o.price)) return; P().outfits.push(it.k); }
    P().outfit = it.k; setOutfit(OUTFITS.default); setOutfit(o); refreshMenu(items()); emit('save');
  });
}
function safeItems() {
  return [{ k: 'save', label: 'Save game' }, { k: 'morning', label: 'Sleep until morning (07:00)' }, { k: 'evening', label: 'Sleep until evening (19:00)' },
    ...P().cars.map(t => ({ k: 'car', t, label: `Take out: ${TYPES[t].name}` }))];
}
function safeMenu(shop) {
  openMenu(shop.name, shop.sub, safeItems(), it => {
    if (it.k === 'save') { emit('save', true); closeMenu(); }
    else if (it.k === 'morning' || it.k === 'evening') { env.time = it.k === 'morning' ? 7 : 19; player.health = 100; emit('save', true); closeMenu(); emit('toast', `You slept until ${it.k === 'morning' ? '07:00' : '19:00'}. Progress saved.`, 3); }
    else { closeMenu(); deliver(it.t, shop.at); }
  });
}
function loftMenu(shop) {
  if (!P().loft) openMenu(shop.name, 'A second safehouse with a view of the bay.', [{ k: 'buy', label: 'Buy the loft', right: '$12,000' }], () => {
    if (money(12000, 'Harbor Heights Loft is yours!')) { P().loft = true; emit('save', true); loftMenu(shop); }
  });
  else safeMenu(shop);
}

/* =====================================================================
   SHOPS: interaction
   ===================================================================== */
export function shopInteractable() {
  if (player.vehicle || player.dead || S.menu) return null;
  for (const s of SHOPS) {
    if (s.requires && !s.requires()) continue;
    if (Math.hypot(player.pos.x - s.at.x, player.pos.z - s.at.z) < 2.5) return { label: s.name, go: () => s.menu(s) };
  }
  return null;
}
export function updateShops() { for (const s of SHOPS) s.mark.visible = !s.requires || !!s.requires(); }
export const shopBlips = () => SHOPS.filter(s => !s.requires || s.requires()).map(s => ({ x: s.at.x, z: s.at.z, color: s.id === 'garage' || s.id === 'loft' ? '#4aa8ff' : '#5fd35b', label: { cars: 'V', guns: 'G', clothes: 'C' }[s.id] || 'S' }));
