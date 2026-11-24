'use strict';
/**
 * Liste de tous les e-mails automatiques de la plateforme, et leur activation (back-office → E-mails).
 * Un e-mail en pause n'est pas envoyé par les automatismes. Les envois volontaires depuis le back-office
 * (aperçu, « Envoyer le code au client ») restent possibles.
 */
const db = require('../db');

const KEY = 'emails';
const TYPES = [
  { id: 'acces', audience: 'client', label: 'Envoi 1 · Code d’accès (jour de la diffusion)', when: 'Le jour de la diffusion, à partir de 8 h, dès que la vidéo et l’e-mail du client sont renseignés.', paused: 'Les codes ne partent plus automatiquement. À la réactivation, les clients dont la diffusion est passée reçoivent leur code (rattrapage).' },
  { id: 'code_oublie', audience: 'client', label: 'Code oublié', when: 'Quand un client clique sur « Code oublié ? » sur la page de connexion.', paused: 'Les clients qui ont perdu leur code ne le reçoivent plus : ils devront contacter l’équipe.' },
  { id: 'recharge', audience: 'client', label: 'Confirmation de recharge de crédits', when: 'Après le paiement d’une recharge de crédits.', paused: 'Pas d’e-mail de confirmation ; les crédits sont quand même ajoutés.' },
  { id: 'diffusions', audience: 'equipe', alert: true, label: 'Alerte · Diffusions incomplètes', when: 'Récapitulatif à J-2 (vendredi si week-end) et le jour de la diffusion, quand la vidéo ou l’e-mail du client manque.', paused: 'Pas de récapitulatif ; la rubrique Diffusions montre toujours ce qui manque.' },
  { id: 'compta', audience: 'equipe', alert: true, label: 'Alerte · Montage payé (compta)', when: 'À chaque montage sur mesure payé : prestation, montants, client, facture.', paused: 'Pas d’e-mail à la compta. À la réactivation, les montages payés depuis moins de 7 jours sont envoyés.' },
  { id: 'erreurs', audience: 'equipe', alert: true, label: 'Alerte · Commande en erreur', when: 'Quand une création automatique (capsules, teaser, sous-titres) échoue.', paused: 'Pas d’e-mail ; les commandes en erreur restent visibles dans Commandes.' },
];
const IDS = TYPES.map((t) => t.id);

let cache = null;
let cacheAt = 0;

async function stored() {
  if (cache && Date.now() - cacheAt < 15_000) return cache;
  let v = { disabled: [] };
  try {
    const { rows } = await db.query('SELECT value, updated_at, updated_by FROM app_settings WHERE key = $1', [KEY]);
    if (rows[0]) {
      const val = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      v = { disabled: (Array.isArray(val.disabled) ? val.disabled : []).filter((id) => IDS.includes(id)), updatedAt: rows[0].updated_at, updatedBy: rows[0].updated_by };
    }
  } catch (e) {
    console.error('[e-mails] lecture des réglages', e.message);
  }
  cache = v;
  cacheAt = Date.now();
  return v;
}

/** L'e-mail automatique `id` est-il actif ? (actif par défaut) */
async function isEnabled(id) {
  return !(await stored()).disabled.includes(id);
}

async function list() {
  const s = await stored();
  const alerts = require('../admin/alerts');
  const out = [];
  for (const t of TYPES) {
    out.push({ ...t, enabled: !s.disabled.includes(t.id), ...(t.alert ? { recipients: await alerts.recipients(t.id) } : {}) });
  }
  return { emails: out, updatedAt: s.updatedAt || null, updatedBy: s.updatedBy || null };
}

/** Enregistre la liste des e-mails en pause. */
async function save(disabled, actor) {
  if (!Array.isArray(disabled)) return { error: 'Format inattendu.' };
  const unknown = disabled.find((id) => !IDS.includes(id));
  if (unknown) return { error: `E-mail inconnu : ${unknown}` };
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify({ disabled: [...new Set(disabled)] }), actor || null]
  );
  cache = null;
  return { value: await list() };
}

module.exports = { TYPES, IDS, isEnabled, list, save };
