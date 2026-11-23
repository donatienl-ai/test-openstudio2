'use strict';
/**
 * Destinataires des alertes envoyées à l'équipe, modifiables dans le back-office (rubrique « Alertes »).
 * Tant qu'une alerte n'a pas été réglée dans le back-office, les variables d'environnement servent
 * (TEAM_ALERT_EMAIL, ACCOUNTING_EMAIL : une ou plusieurs adresses séparées par des virgules).
 */
const db = require('../db');

const KEY = 'alerts';
const MAX = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const env = (name) => String(process.env[name] || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s));
const TYPES = {
  diffusions: { label: 'Diffusions incomplètes', description: 'Vidéo ou e-mail du client manquant : récapitulatif à J-2 (vendredi si week-end) et le jour de la diffusion.', fallback: () => env('TEAM_ALERT_EMAIL') },
  compta: { label: 'Montage payé (compta)', description: 'À chaque montage sur mesure payé : prestation, montants HT et TTC, client, facture.', fallback: () => (env('ACCOUNTING_EMAIL').length ? env('ACCOUNTING_EMAIL') : env('TEAM_ALERT_EMAIL')) },
  erreurs: { label: 'Commande en erreur', description: 'Quand une création automatique (capsules, teaser, sous-titres) échoue : le client a été remboursé, la commande est à relancer.', fallback: () => env('TEAM_ALERT_EMAIL') },
};

let cache = null;
let cacheAt = 0;

async function stored() {
  if (cache && Date.now() - cacheAt < 30_000) return cache;
  let v = {};
  try {
    const { rows } = await db.query('SELECT value, updated_at, updated_by FROM app_settings WHERE key = $1', [KEY]);
    if (rows[0]) v = { ...(typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value), _updatedAt: rows[0].updated_at, _updatedBy: rows[0].updated_by };
  } catch (e) {
    console.error('[alertes] lecture des destinataires', e.message);
  }
  cache = v;
  cacheAt = Date.now();
  return v;
}

/** Destinataires d'une alerte (adresses en minuscules, sans doublon). */
async function recipients(type) {
  const s = await stored();
  return Array.isArray(s[type]) ? s[type] : TYPES[type].fallback();
}

/** Tous les réglages, pour la page du back-office. */
async function list() {
  const s = await stored();
  return {
    types: Object.entries(TYPES).map(([id, t]) => ({
      id, label: t.label, description: t.description,
      recipients: Array.isArray(s[id]) ? s[id] : t.fallback(),
      fromEnv: !Array.isArray(s[id]),
    })),
    updatedAt: s._updatedAt || null,
    updatedBy: s._updatedBy || null,
  };
}

function validate(input) {
  const out = {};
  for (const id of Object.keys(TYPES)) {
    const raw = input && input[id];
    if (raw == null) continue;
    if (!Array.isArray(raw)) return { error: 'Format inattendu.' };
    const list = [...new Set(raw.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
    const bad = list.find((e) => !EMAIL.test(e) || e.length > 200);
    if (bad) return { error: `Adresse e-mail invalide : ${bad}` };
    if (list.length > MAX) return { error: `${MAX} destinataires au maximum par alerte.` };
    out[id] = list;
  }
  return { value: out };
}

async function save(input, actor) {
  const r = validate(input);
  if (r.error) return r;
  const current = await stored();
  const value = {};
  for (const id of Object.keys(TYPES)) if (Array.isArray(r.value[id]) || Array.isArray(current[id])) value[id] = r.value[id] || current[id];
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify(value), actor || null]
  );
  cache = null;
  return { value: await list() };
}

module.exports = { TYPES, recipients, list, save, validate };
