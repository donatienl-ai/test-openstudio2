'use strict';
/**
 * Barème des crédits et packs de recharge. Valeurs validées par OpenMedias (novembre 2026),
 * modifiables ensuite depuis le back-office (super admin) : la version en base l'emporte.
 */
const db = require('../db');

const DEFAULTS = Object.freeze({
  included: 1000, // crédits offerts à la création du compte
  validityDays: 30, // validité après la diffusion, puis après chaque recharge
  prices: {
    capsules: 300, // projet de capsules (15, 30, 45 ou 60 s, tous formats) : 3 propositions
    teaser: 300, // teaser de 15 s (tous formats) : 1 montage élaboré
    subtitlesPer5Min: 300, // interview sous-titrée, par tranche de 5 min entamée
    translationPer5Min: 300, // traduction des sous-titres, par langue et par tranche de 5 min entamée
  },
  packs: [
    { id: 'demarrage', label: 'Complément de démarrage', credits: 200, priceHT: 59, once: true },
    { id: 'pack-1', label: 'Pack 1 production', credits: 300, priceHT: 69 },
    { id: 'pack-3', label: 'Pack 3 productions', credits: 900, priceHT: 179 },
    { id: 'pack-5', label: 'Pack 5 productions', credits: 1500, priceHT: 279 },
    { id: 'pack-10', label: 'Pack 10 productions', credits: 3000, priceHT: 499 },
  ],
});

const KEY = 'credits';
let cache = null;
let cacheAt = 0;

const int = (v, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Contrôle un barème envoyé par le back-office ; renvoie { value } ou { error }. */
function validate(input) {
  const i = input || {};
  const included = int(i.included, 0, 100000);
  const validityDays = int(i.validityDays, 1, 365);
  if (included == null) return { error: 'Crédits offerts : nombre entier entre 0 et 100 000.' };
  if (validityDays == null) return { error: 'Validité : nombre de jours entre 1 et 365.' };
  const p = i.prices || {};
  const prices = {};
  for (const k of Object.keys(DEFAULTS.prices)) {
    prices[k] = int(p[k], 0, 100000);
    if (prices[k] == null) return { error: 'Chaque coût en crédits doit être un nombre entier (0 à 100 000).' };
  }
  if (!Array.isArray(i.packs) || !i.packs.length || i.packs.length > 12) return { error: 'Indiquez entre 1 et 12 packs de recharge.' };
  const ids = new Set();
  const packs = [];
  for (const raw of i.packs) {
    const id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
    const label = String(raw.label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const credits = int(raw.credits, 1, 100000);
    const priceHT = Number(raw.priceHT);
    if (!id || ids.has(id)) return { error: 'Chaque pack doit avoir un identifiant unique.' };
    if (!label) return { error: 'Chaque pack doit avoir un nom.' };
    if (credits == null) return { error: `Pack « ${label} » : nombre de crédits invalide.` };
    if (!Number.isFinite(priceHT) || priceHT < 1 || priceHT > 100000 || Math.round(priceHT * 100) !== priceHT * 100) {
      return { error: `Pack « ${label} » : prix HT invalide.` };
    }
    ids.add(id);
    packs.push({ id, label, credits, priceHT, ...(raw.once ? { once: true } : {}) });
  }
  return { value: { included, validityDays, prices, packs } };
}

async function get({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 30_000) return cache;
  let value = null;
  try {
    const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
    if (rows[0]) {
      const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      const checked = validate(v);
      value = checked.value || null;
    }
  } catch (e) {
    console.error('[crédits] lecture du barème', e.message);
  }
  cache = value || JSON.parse(JSON.stringify(DEFAULTS));
  cacheAt = Date.now();
  return cache;
}

async function save(input, actor) {
  const r = validate(input);
  if (r.error) return r;
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify(r.value), actor || null]
  );
  cache = null;
  return { value: await get({ fresh: true }) };
}

module.exports = { DEFAULTS, validate, get, save };
