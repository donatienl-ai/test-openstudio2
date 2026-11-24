'use strict';
/**
 * Mode test des e-mails : adresses qui reçoivent TOUS les e-mails à la place des vrais destinataires
 * (objet préfixé [TEST] et « pour <destinataire réel> »). Réglable dans le back-office (page E-mails),
 * sinon MAIL_REDIRECT_TO (une ou plusieurs adresses séparées par des virgules).
 * La liste en vigueur est recopiée dans config.mail.redirectTo, lu par tous les envois.
 */
const config = require('../config');
const db = require('../db');

const KEY = 'mail_redirect';
const MAX = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ENV = (process.env.MAIL_REDIRECT_TO || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s));

let state = { list: ENV, fromEnv: true, updatedAt: null, updatedBy: null };

function apply() {
  config.mail.redirectTo = state.list.join(', ');
}

/** Lit la liste enregistrée (au démarrage du serveur). */
async function load() {
  try {
    const { rows } = await db.query('SELECT value, updated_at, updated_by FROM app_settings WHERE key = $1', [KEY]);
    if (rows[0]) {
      const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      if (Array.isArray(v.list)) state = { list: v.list, fromEnv: false, updatedAt: rows[0].updated_at, updatedBy: rows[0].updated_by };
    }
  } catch (e) {
    console.error('[e-mails] lecture des adresses de test', e.message);
  }
  apply();
  return get();
}

function get() {
  return {
    list: state.list,
    fromEnv: state.fromEnv,
    realSendingAllowed: Boolean(config.mail.allowRealRecipients),
    mode: state.list.length ? 'test' : config.mail.allowRealRecipients ? 'reel' : 'bloque',
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

async function save(input, actor) {
  if (!Array.isArray(input)) return { error: 'Format inattendu.' };
  const list = [...new Set(input.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const bad = list.find((e) => !EMAIL.test(e) || e.length > 200);
  if (bad) return { error: `Adresse e-mail invalide : ${bad}` };
  if (list.length > MAX) return { error: `${MAX} adresses au maximum.` };
  if (!list.length && !config.mail.allowRealRecipients) {
    return { error: 'Gardez au moins une adresse : l’envoi aux vrais destinataires n’est pas autorisé sur ce serveur, plus aucun e-mail ne partirait.' };
  }
  const { rows } = await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by RETURNING updated_at`,
    [KEY, JSON.stringify({ list }), actor || null]
  );
  state = { list, fromEnv: false, updatedAt: rows[0].updated_at, updatedBy: actor || null };
  apply();
  return { value: get() };
}

module.exports = { load, get, save };
