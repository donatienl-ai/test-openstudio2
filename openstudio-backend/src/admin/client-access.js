'use strict';
/**
 * Lien d'accès personnel de chaque client.
 *
 * - Le lien (…/?client=<id>&clientToken=<jeton>) n'est jamais conservé : seule son empreinte l'est.
 * - Le jour de la diffusion, à partir de 8 h (heure de Paris), il est créé et envoyé par e-mail.
 * - L'équipe peut l'envoyer plus tôt, créer un lien à transmettre elle-même, ou couper l'accès.
 * - Créer un nouveau lien rend l'ancien inutilisable.
 */
const db = require('../db');
const config = require('../config');
const mailer = require('../mailer');
const audit = require('./audit');
const { newAccessToken } = require('../auth');
const { sha256 } = require('../clients');

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
 * Où en est l'accès du client. code : revoked | sent | manual | failed | scheduled | no_email | no_date
 */
function accessStatus(c, now = new Date()) {
  if (c.access_revoked_at) return { code: 'revoked', label: 'Accès coupé', at: c.access_revoked_at };
  if (c.access_email_sent_at && c.access_issued_via === 'email') {
    return { code: 'sent', label: 'Lien envoyé par e-mail', at: c.access_email_sent_at };
  }
  if ((c.access_token_hash || c.has_access) && c.access_issued_at) {
    return { code: 'manual', label: 'Lien remis à la main', at: c.access_issued_at };
  }
  if (c.access_token_hash || c.has_access) return { code: 'manual', label: 'Lien existant (avant le back-office)', at: null };
  if (c.access_email_error && c.email) {
    const automatic = Boolean(c.broadcast_date);
    return {
      code: 'failed',
      label: !automatic ? 'Échec d’envoi'
        : c.access_email_attempts >= MAX_AUTO_ATTEMPTS ? 'Échec d’envoi (abandonné)' : 'Échec d’envoi, nouvel essai prévu',
      error: c.access_email_error,
    };
  }
  if (!c.email) return { code: 'no_email', label: 'E-mail à renseigner' };
  if (!c.broadcast_date) return { code: 'no_date', label: 'Date de diffusion à renseigner' };
  const day = isoDay(c.broadcast_date);
  const { day: today } = parisParts(now);
  return {
    code: 'scheduled',
    label: day <= today ? 'Envoi imminent' : 'Envoi programmé',
    day,
    hour: config.mail.accessSendFromHour,
  };
}

/* ------------------------------------------------------------------ Liens */

function linkFor(clientId, token) {
  const base = config.clientSiteUrl || 'https://ADRESSE-DE-L-ESPACE-CLIENT';
  return `${base}/?client=${encodeURIComponent(clientId)}&clientToken=${encodeURIComponent(token)}`;
}

/** Crée un nouveau lien (l'ancien cesse de fonctionner). */
async function issue(clientId, via) {
  const token = newAccessToken();
  const { rows } = await db.query(
    `UPDATE clients SET access_token = NULL, access_token_hash = $2, access_issued_at = now(),
       access_issued_via = $3, access_revoked_at = NULL
     WHERE id = $1 RETURNING *`,
    [clientId, sha256(token), via]
  );
  if (!rows[0]) throw new Error('Client introuvable');
  return { client: rows[0], token, link: linkFor(clientId, token) };
}

async function revoke(clientId) {
  const { rows } = await db.query(
    `UPDATE clients SET access_token = NULL, access_token_hash = NULL, access_revoked_at = now()
     WHERE id = $1 RETURNING *`,
    [clientId]
  );
  return rows[0] || null;
}

/* ------------------------------------------------------------------ E-mail */

function frenchDate(day) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function accessEmail(client, link) {
  const hello = client.name ? `Bonjour ${client.name},` : 'Bonjour,';
  const text = [
    hello,
    '',
    `Votre espace OpenStudio est prêt${client.company ? ` pour ${client.company}` : ''}. Vous y retrouvez la vidéo de votre passage à l’antenne, et vous pouvez en tirer vous-même des capsules pour vos réseaux sociaux et votre site.`,
    '',
    'Votre lien d’accès personnel :',
    link,
    '',
    'Ce lien vous est réservé : ne le transférez pas. Si vous le perdez, répondez simplement à cet e-mail.',
    '',
    'L’équipe OpenMedias',
  ].join('\n');
  return {
    to: { email: client.email, name: client.name || undefined },
    subject: 'Votre espace OpenStudio est prêt',
    text,
    templateId: config.mail.templateClientAccess || null,
    variables: {
      nom: client.name || '',
      entreprise: client.company || '',
      lien: link,
      date_diffusion: frenchDate(isoDay(client.broadcast_date)),
    },
    customId: `acces-client-${client.id}`,
  };
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
    throw new Error(unavailable);
  }
  // État du lien actuel, rétabli si l'envoi échoue (le client garde alors son accès existant)
  const { rows: before } = await db.query(
    'SELECT access_token, access_token_hash, access_issued_at, access_issued_via, access_revoked_at FROM clients WHERE id = $1',
    [client.id]
  );
  const { link } = await issue(client.id, 'email');
  try {
    const r = await send(accessEmail(client, link));
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
    // Le nouveau lien n'a pas été transmis : on rétablit l'accès précédent (ou aucun accès)
    const p = before[0] || {};
    await db.query(
      `UPDATE clients SET access_token = $2, access_token_hash = $3, access_issued_at = $4, access_issued_via = $5,
         access_revoked_at = $6 WHERE id = $1`,
      [client.id, p.access_token || null, p.access_token_hash || null, p.access_issued_at || null,
        p.access_issued_via || null, p.access_revoked_at || null]
    );
    await recordFailure(client.id, e.message);
    await audit.record(req, 'acces_echec_envoi', { targetType: 'client', targetId: client.id, detail: { email: client.email, erreur: e.message } });
    throw e;
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

/** Clients dont le lien doit partir aujourd'hui (ou avant, s'il n'est pas encore parti). */
async function dueClients(today) {
  const { rows } = await db.query(
    `SELECT * FROM clients
     WHERE broadcast_date IS NOT NULL AND broadcast_date <= $1::date
       AND email IS NOT NULL AND email <> ''
       AND access_email_sent_at IS NULL AND access_revoked_at IS NULL AND access_token_hash IS NULL
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

module.exports = { accessStatus, issue, revoke, sendByEmail, runScheduled, dueClients, linkFor, parisParts, isoDay, accessEmail, MAX_AUTO_ATTEMPTS };
