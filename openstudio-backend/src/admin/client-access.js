'use strict';
/**
 * Lien d'accès personnel de chaque client.
 *
 * - Le lien (…/?client=<id>&clientToken=<jeton>) n'est jamais conservé : seule son empreinte l'est.
 * - Le jour de la diffusion de l'émission, à partir de 8 h (heure de Paris), il est créé et envoyé par
 *   e-mail, à condition que la vidéo soit déposée : la date qui compte est celle de la vidéo (à défaut,
 *   celle de la fiche client). Le client n'arrive donc jamais dans un espace vide.
 * - L'équipe peut l'envoyer plus tôt, créer un lien à transmettre elle-même, ou couper l'accès.
 * - Créer un nouveau lien rend l'ancien inutilisable.
 */
const db = require('../db');
const config = require('../config');
const mailer = require('../mailer');
const audit = require('./audit');
const { sha256, newAccessCode } = require('../clients');
const secretbox = require('./secretbox');

/** Code chiffré pour la fiche (null si la clé de chiffrement manque : le code ne sera alors pas réaffichable). */
function sealCode(code) {
  try { return secretbox.seal(code, config.admin.encryptionKey); } catch { return null; }
}
/** Code lisible d'un client, pour la fiche du back-office (null si absent ou illisible). */
function readableCode(c) {
  if (!c || !c.access_code_enc || !c.access_code_hash) return null;
  try { return secretbox.open(c.access_code_enc, config.admin.encryptionKey); } catch { return null; }
}

const MAX_AUTO_ATTEMPTS = 5;
const RETRY_AFTER_MINUTES = 60;

/* ------------------------------------------------------------------ Dates (heure de Paris) */

function parisParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Date « AAAA-MM-JJ » d'une colonne DATE (renvoyée en chaîne ou en objet Date selon le pilote). */
function isoDay(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ Statut affiché */

/**
 * Où en est l'accès du client.
 * code : revoked | sent | failed | scheduled | no_email | no_video | no_date
 * c.videos (nombre de vidéos actives) et c.trigger_date (date de diffusion de la première vidéo) sont
 * fournis par clients.list() ou withAccessInfo().
 */
function accessStatus(c, now = new Date()) {
  if (c.access_revoked_at) return { code: 'revoked', label: 'Accès coupé', at: c.access_revoked_at };
  if (c.access_email_sent_at) {
    return { code: 'sent', label: 'Code envoyé par e-mail', at: c.access_email_sent_at };
  }
  if (c.access_email_error && c.email) {
    const automatic = Boolean(c.trigger_date || c.broadcast_date);
    return {
      code: 'failed',
      label: !automatic ? 'Échec d’envoi'
        : c.access_email_attempts >= MAX_AUTO_ATTEMPTS ? 'Échec d’envoi (abandonné)' : 'Échec d’envoi, nouvel essai prévu',
      error: c.access_email_error,
    };
  }
  if (!c.email) return { code: 'no_email', label: 'E-mail à renseigner' };
  if (c.videos !== undefined && Number(c.videos) === 0) return { code: 'no_video', label: 'En attente de la vidéo' };
  const trigger = c.trigger_date !== undefined ? c.trigger_date : c.broadcast_date;
  if (!trigger) return { code: 'no_date', label: 'Date de diffusion à renseigner' };
  const day = isoDay(trigger);
  const { day: today } = parisParts(now);
  return {
    code: 'scheduled',
    label: day <= today ? 'Envoi imminent' : 'Envoi programmé',
    day,
    hour: config.mail.accessSendFromHour,
  };
}

/** Ajoute à une ligne client le nombre de vidéos actives et la date qui déclenche l'envoi. */
async function withAccessInfo(c) {
  if (!c) return c;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS videos, MIN(COALESCE(v.broadcast_date, c.broadcast_date)) AS trigger_date
     FROM client_videos v JOIN clients c ON c.id = v.client_id
     WHERE v.client_id = $1 AND v.active = true`,
    [c.id]
  );
  return { ...c, videos: rows[0].videos, trigger_date: rows[0].trigger_date };
}

/* ------------------------------------------------------------------ Liens */

function linkFor(clientId, token) {
  const base = config.clientSiteUrl || 'https://ADRESSE-DE-L-ESPACE-CLIENT';
  return `${base}/?client=${encodeURIComponent(clientId)}&clientToken=${encodeURIComponent(token)}`;
}

/** Adresse de connexion, avec le code prérempli. */
function loginUrlFor(code) {
  const base = config.clientSiteUrl || 'https://ADRESSE-DE-L-ESPACE-CLIENT';
  return `${base}/?code=${encodeURIComponent(code)}`;
}

/**
 * Code de connexion du client : créé une fois pour toutes, puis toujours le même.
 * (Un code créé avant l'affichage des codes, donc illisible, est remplacé une fois.)
 */
async function ensureCode(clientId) {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!rows[0]) throw new Error('Client introuvable');
  const existing = readableCode(rows[0]);
  if (existing) return existing;
  return (await issue(clientId, 'auto')).code;
}

/** Donne un code aux clients qui n'en ont pas encore (au démarrage du serveur). */
async function ensureAllCodes() {
  const { rows } = await db.query('SELECT id FROM clients WHERE access_code_hash IS NULL OR access_code_enc IS NULL LIMIT 1000');
  for (const r of rows) await ensureCode(r.id);
  return rows.length;
}

/** Crée le code d'accès d'un client (utilisé par ensureCode). */
async function issue(clientId, via) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newAccessCode();
    try {
      const { rows } = await db.query(
        `UPDATE clients SET access_token = NULL, access_token_hash = NULL, access_code_hash = $2, access_code_enc = $4,
           access_issued_at = now(), access_issued_via = $3, access_revoked_at = NULL
         WHERE id = $1 RETURNING *`,
        [clientId, sha256(code), via, sealCode(code)]
      );
      if (!rows[0]) throw new Error('Client introuvable');
      return { client: rows[0], code, link: loginUrlFor(code) };
    } catch (e) {
      if (!/clients_access_code|duplicate key/i.test(e.message)) throw e; // code déjà attribué : on en tire un autre
    }
  }
  throw new Error('Impossible de générer un code unique, réessayez.');
}

/** Coupe l'accès : le code ne permet plus de se connecter et tous les navigateurs du client sont déconnectés. */
async function revoke(clientId) {
  const { rows } = await db.query('UPDATE clients SET access_revoked_at = now() WHERE id = $1 RETURNING *', [clientId]);
  if (rows[0]) await db.query('DELETE FROM client_sessions WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

/** Rétablit l'accès : le même code fonctionne à nouveau. */
async function restore(clientId) {
  const { rows } = await db.query('UPDATE clients SET access_revoked_at = NULL WHERE id = $1 RETURNING *', [clientId]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ E-mail */

function frenchDate(day) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * E-mail du jour de diffusion, envoyé à l'e-mail du client : code d'accès, raisons d'utiliser OpenStudio et
 * validité des crédits offerts (30 jours après la diffusion). La vidéo n'est pas dans l'e-mail : le client la
 * retrouve dans son espace. creditsUntil : fin de validité des crédits (Date, chaîne ISO ou null).
 */
/**
 * E-mail du jour de diffusion (étape 1 · envoi 1, maquette « pass clair ») : code d'accès, crédits offerts,
 * ce qu'ils permettent. Variante sans « aujourd'hui » si l'équipe l'envoie à la main avant la diffusion.
 * @param {object} extra  { programme, media, credits, prices } (lus par sendByEmail)
 */
function accessEmail(client, link, code, creditsUntil = null, extra = {}) {
  const broadcast = isoDay(client.broadcast_date);
  const today = broadcast === parisParts().day;
  const prices = extra.prices || { capsules: 300, teaser: 300, subtitlesPer5Min: 300 };
  const m = require('../emails/accessDay').accessDayEmail({
    name: client.name, code, link, today, broadcastDay: broadcast || null,
    programme: extra.programme || null, media: extra.media || null,
    credits: extra.credits != null ? extra.credits : 1000, creditsUntil, prices,
  });
  return {
    to: { email: client.email, name: client.name || undefined },
    subject: m.subject,
    text: m.text,
    html: m.html,
    customId: `acces-client-${client.id}`,
  };
}

/** Émission et média de la diffusion du client (planning), pour l'e-mail du jour J. */
async function broadcastInfo(clientId) {
  try {
    const { rows } = await db.query(
      `SELECT media, sous_media FROM diffusions WHERE client_id = $1 AND state <> 'cancelled'
       ORDER BY (date_diffusion = (now() AT TIME ZONE 'Europe/Paris')::date) DESC, date_diffusion DESC NULLS LAST LIMIT 1`, [clientId]);
    if (rows[0]) return { media: rows[0].media || null, programme: rows[0].sous_media || null };
  } catch { /* table absente (tests) */ }
  try {
    const { rows } = await db.query('SELECT programme_id FROM client_videos WHERE client_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1', [clientId]);
    const p = rows[0] && require('../opusclip.config').programmes[rows[0].programme_id];
    if (p) return { media: p.title, programme: null };
  } catch { /* rien */ }
  return {};
}

/** E-mail « code oublié » : le code d'accès (inchangé) et le lien de connexion, rien d'autre. */
function forgotCodeEmail(client, link, code) {
  const text = [
    client.name ? `Bonjour ${client.name},` : 'Bonjour,',
    '',
    `Vous avez demandé à recevoir votre code d’accès OpenStudio${client.company ? ` (${client.company})` : ''}.`,
    '',
    `Votre code d’accès : ${code}`,
    '',
    'Pour vous connecter directement (le code est déjà rempli) :',
    link,
    '',
    'Ce code vous est réservé : ne le transmettez pas en dehors de votre entreprise.',
    'Si vous n’êtes pas à l’origine de cette demande, ignorez simplement cet e-mail : votre code reste inchangé.',
    '',
    'L’équipe OpenMedias',
  ].join('\n');
  return {
    to: { email: client.email, name: client.name || undefined },
    subject: 'Votre code d’accès OpenStudio',
    text,
    customId: `code-oublie-${client.id}`,
  };
}

/**
 * « Code oublié ? » : renvoie le code d'accès à l'adresse enregistrée sur la fiche du client.
 * Ne dit jamais si l'adresse est connue (pas de liste des clients par essais successifs).
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendForgottenCode(email, { req = null, send = mailer.send } = {}) {
  const client = await require('../clients').findByEmail(email);
  if (!client || client.access_revoked_at) return { sent: false, reason: 'inconnu' };
  const unavailable = mailer.problem();
  if (unavailable && send === mailer.send) return { sent: false, reason: unavailable };
  // Le code ne change jamais : s'il existe mais ne peut pas être relu, on n'en crée pas un autre.
  const readable = readableCode(client);
  if (!readable && client.access_code_hash) return { sent: false, reason: 'code illisible (ADMIN_ENCRYPTION_KEY absente ou modifiée)' };
  const code = readable || await ensureCode(client.id);
  const message = forgotCodeEmail(client, loginUrlFor(code), code);
  const r = await send(message);
  await logEmail(client, { status: 'envoye', subject: message.subject, providerId: r && r.messageId, redirectedTo: r && r.redirectedTo });
  await audit.record(req, 'code_oublie_envoye', { targetType: 'client', targetId: client.id, detail: { email: client.email } });
  return { sent: true };
}

/**
 * Crée un nouveau lien et l'envoie par e-mail. En cas d'échec, l'erreur est enregistrée sur la fiche
 * et l'envoi automatique réessaiera plus tard (5 essais au plus).
 */
async function sendByEmail(client, { req = null, automatic = false, send = mailer.send } = {}) {
  if (!client.email) throw new Error('Ce client n’a pas d’adresse e-mail.');
  const unavailable = mailer.problem();
  if (unavailable && send === mailer.send) {
    await recordFailure(client.id, unavailable);
    await logEmail(client, { status: 'echec', subject: 'C’est le jour J : votre espace OpenStudio est ouvert', error: unavailable, automatic });
    throw new Error(unavailable);
  }
  const code = await ensureCode(client.id);
  const creditsUntil = await require('../credits/service').expiryOf(client.id).catch(() => null);
  const tariff = await require('../credits/settings').get().catch(() => null);
  const message = accessEmail(client, loginUrlFor(code), code, creditsUntil, {
    ...(await broadcastInfo(client.id)),
    credits: tariff ? tariff.included : undefined,
    prices: tariff ? tariff.prices : undefined,
  });
  try {
    const r = await send(message);
    await logEmail(client, { status: 'envoye', subject: message.subject, providerId: r && r.messageId, redirectedTo: r && r.redirectedTo, automatic });
    const { rows } = await db.query(
      `UPDATE clients SET access_email_sent_at = now(), access_email_error = NULL,
         access_email_attempts = access_email_attempts + 1, access_email_last_try_at = now()
       WHERE id = $1 RETURNING *`,
      [client.id]
    );
    await audit.record(req, automatic ? 'acces_envoye_auto' : 'acces_envoye', {
      targetType: 'client', targetId: client.id,
      detail: { email: client.email, ...(r && r.redirectedTo ? { redirige_vers: r.redirectedTo } : {}) },
    });
    return { client: rows[0], redirectedTo: r && r.redirectedTo };
  } catch (e) {
    await recordFailure(client.id, e.message);
    await logEmail(client, { status: 'echec', subject: message.subject, error: e.message, redirectedTo: config.mail.redirectTo || null, automatic });
    await audit.record(req, 'acces_echec_envoi', { targetType: 'client', targetId: client.id, detail: { email: client.email, erreur: e.message } });
    throw e;
  }
}

async function logEmail(client, { status, subject, providerId = null, redirectedTo = null, error = null, automatic = false }) {
  try {
    await db.query(
      `INSERT INTO client_emails (client_id, kind, to_email, redirected_to, subject, status, provider_id, error, automatic)
       VALUES ($1, 'acces', $2, $3, $4, $5, $6, $7, $8)`,
      [client.id, client.email, redirectedTo, subject, status, providerId, error ? String(error).slice(0, 500) : null, automatic]
    );
  } catch (e) {
    console.error('[accès client] journal des e-mails', e.message);
  }
}

async function recordFailure(clientId, message) {
  await db.query(
    `UPDATE clients SET access_email_error = $2, access_email_attempts = access_email_attempts + 1,
       access_email_last_try_at = now() WHERE id = $1`,
    [clientId, String(message).slice(0, 500)]
  );
}

/* ------------------------------------------------------------------ Envoi automatique */

/**
 * Clients dont le lien doit partir : une vidéo active est déposée et sa date de diffusion (à défaut,
 * celle de la fiche) est aujourd'hui ou passée.
 */
async function dueClients(today) {
  const { rows } = await db.query(
    `SELECT c.* FROM clients c
     WHERE EXISTS (
         SELECT 1 FROM client_videos v
         WHERE v.client_id = c.id AND v.active = true
           AND COALESCE(v.broadcast_date, c.broadcast_date) <= $1::date)
       AND email IS NOT NULL AND email <> ''
       AND access_email_sent_at IS NULL AND access_revoked_at IS NULL
       AND access_email_attempts < $2
       AND (access_email_last_try_at IS NULL OR access_email_last_try_at < now() - make_interval(mins => $3))
     ORDER BY broadcast_date, created_at
     LIMIT 25`,
    [today, MAX_AUTO_ATTEMPTS, RETRY_AFTER_MINUTES]
  );
  return rows;
}

/** Appelé toutes les 10 minutes : envoie les liens du jour, entre 8 h et 20 h (heure de Paris). */
async function runScheduled({ now = new Date(), send = mailer.send, log = console } = {}) {
  const { day, hour } = parisParts(now);
  if (hour < config.mail.accessSendFromHour || hour >= config.mail.accessSendUntilHour) return { sent: 0, failed: 0, skipped: 'hors horaires' };
  if (send === mailer.send && mailer.problem()) return { sent: 0, failed: 0, skipped: mailer.problem() };
  let sent = 0;
  let failed = 0;
  for (const c of await dueClients(day)) {
    try {
      await sendByEmail(c, { automatic: true, send });
      sent++;
    } catch (e) {
      failed++;
      log.error(`[accès client] envoi impossible pour ${c.id} : ${e.message}`);
    }
  }
  if (sent || failed) log.log(`[accès client] liens envoyés : ${sent}, échecs : ${failed}`);
  return { sent, failed };
}

module.exports = { forgotCodeEmail, sendForgottenCode, readableCode, ensureCode, ensureAllCodes, restore, accessStatus, withAccessInfo, issue, revoke, sendByEmail, runScheduled, dueClients, linkFor, loginUrlFor, parisParts, isoDay, accessEmail, MAX_AUTO_ATTEMPTS };
