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
 * code : revoked | sent | manual | failed | scheduled | no_email | no_video | no_date
 * c.videos (nombre de vidéos actives) et c.trigger_date (date de diffusion de la première vidéo) sont
 * fournis par clients.list() ou withAccessInfo().
 */
function accessStatus(c, now = new Date()) {
  if (c.access_revoked_at) return { code: 'revoked', label: 'Accès coupé', at: c.access_revoked_at };
  if (c.access_email_sent_at && c.access_issued_via === 'email') {
    return { code: 'sent', label: 'Code envoyé par e-mail', at: c.access_email_sent_at };
  }
  const hasAccess = c.access_token_hash || c.access_code_hash || c.has_access;
  if (hasAccess && c.access_issued_at) {
    return { code: 'manual', label: 'Code remis à la main', at: c.access_issued_at };
  }
  if (hasAccess) return { code: 'manual', label: 'Lien existant (avant le back-office)', at: null };
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
 * Crée un nouveau code d'accès : l'ancien code et l'ancien lien cessent de fonctionner pour se
 * connecter. Les navigateurs déjà connectés le restent (sauf accès coupé).
 */
async function issue(clientId, via) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newAccessCode();
    try {
      const { rows } = await db.query(
        `UPDATE clients SET access_token = NULL, access_token_hash = NULL, access_code_hash = $2,
           access_issued_at = now(), access_issued_via = $3, access_revoked_at = NULL
         WHERE id = $1 RETURNING *`,
        [clientId, sha256(code), via]
      );
      if (!rows[0]) throw new Error('Client introuvable');
      return { client: rows[0], code, link: loginUrlFor(code) };
    } catch (e) {
      if (!/clients_access_code|duplicate key/i.test(e.message)) throw e; // code déjà attribué : on en tire un autre
    }
  }
  throw new Error('Impossible de générer un code unique, réessayez.');
}

/** Coupe l'accès : plus de code, plus de lien, tous les navigateurs du client sont déconnectés. */
async function revoke(clientId) {
  const { rows } = await db.query(
    `UPDATE clients SET access_token = NULL, access_token_hash = NULL, access_code_hash = NULL, access_revoked_at = now()
     WHERE id = $1 RETURNING *`,
    [clientId]
  );
  if (rows[0]) await db.query('DELETE FROM client_sessions WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ E-mail */

function frenchDate(day) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function accessEmail(client, link, code) {
  const hello = client.name ? `Bonjour ${client.name},` : 'Bonjour,';
  const text = [
    hello,
    '',
    `Votre espace OpenStudio est prêt${client.company ? ` pour ${client.company}` : ''}. Vous y retrouvez la vidéo de votre passage à l’antenne, et vous pouvez en tirer vous-même des capsules pour vos réseaux sociaux et votre site.`,
    '',
    `Votre code d’accès personnel : ${code}`,
    '',
    'Pour vous connecter, ouvrez ce lien (le code est déjà rempli) :',
    link,
    '',
    'Ce code vous est réservé : ne le transmettez pas. Si vous le perdez, répondez simplement à cet e-mail.',
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
      code: code || '',
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
    await logEmail(client, { status: 'echec', subject: 'Votre espace OpenStudio est prêt', error: unavailable, automatic });
    throw new Error(unavailable);
  }
  // État du lien actuel, rétabli si l'envoi échoue (le client garde alors son accès existant)
  const { rows: before } = await db.query(
    'SELECT access_token, access_token_hash, access_code_hash, access_issued_at, access_issued_via, access_revoked_at FROM clients WHERE id = $1',
    [client.id]
  );
  const { link, code } = await issue(client.id, 'email');
  const message = accessEmail(client, link, code);
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
    // Le nouveau code n'a pas été transmis : on rétablit l'accès précédent (ou aucun accès)
    const p = before[0] || {};
    await db.query(
      `UPDATE clients SET access_token = $2, access_token_hash = $3, access_issued_at = $4, access_issued_via = $5,
         access_revoked_at = $6, access_code_hash = $7 WHERE id = $1`,
      [client.id, p.access_token || null, p.access_token_hash || null, p.access_issued_at || null,
        p.access_issued_via || null, p.access_revoked_at || null, p.access_code_hash || null]
    );
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
       AND access_email_sent_at IS NULL AND access_revoked_at IS NULL AND access_token_hash IS NULL AND access_code_hash IS NULL
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

module.exports = { accessStatus, withAccessInfo, issue, revoke, sendByEmail, runScheduled, dueClients, linkFor, loginUrlFor, parisParts, isoDay, accessEmail, MAX_AUTO_ATTEMPTS };
