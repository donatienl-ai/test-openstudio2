'use strict';
/**
 * Clients et vidéos de leur package.
 * Chaque client a un espace (lien d'accès personnel) et une liste de vidéos qui dépend de son package :
 * un client peut n'avoir qu'un passage BFM Business, un autre un passage BFM + une immersion, etc.
 * Le lien d'accès n'est conservé que sous forme d'empreinte (access_token_hash) : voir admin/client-access.js.
 */
const crypto = require('crypto');
const db = require('./db');
const { newAccessToken, tokensMatch } = require('./auth');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v));

/**
 * Crée un client. Par défaut, aucun lien d'accès n'existe encore : il est créé et envoyé le jour de
 * la diffusion (ou à la main depuis le back-office). keepPlainToken : client de test uniquement,
 * dont le lien est réécrit dans les logs à chaque démarrage.
 */
async function create({ name, company, email, logoKey, broadcastDate, packageLabel, notes, marketingOptin, marketingOptinSource, keepPlainToken = false }) {
  const id = crypto.randomUUID();
  const token = keepPlainToken ? newAccessToken() : null;
  const { rows } = await db.query(
    `INSERT INTO clients (id, name, company, email, access_token, access_token_hash, logo_key,
                          broadcast_date, package_label, notes, access_issued_at, access_issued_via,
                          marketing_optin, marketing_optin_at, marketing_optin_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [id, name, company || null, email || null, token, token ? sha256(token) : null, logoKey || null,
      broadcastDate || null, packageLabel || null, notes || null, token ? new Date().toISOString() : null, token ? 'manuel' : null,
      typeof marketingOptin === 'boolean' ? marketingOptin : null, typeof marketingOptin === 'boolean' ? new Date().toISOString() : null,
      marketingOptinSource || null]
  );
  return rows[0];
}

async function get(id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Identifie le client à partir de l'en-tête X-Client-Id + X-Client-Token. */
async function fromRequest(req) {
  const id = req.get('x-client-id') || req.query.client;
  const token = req.get('x-client-token') || req.query.clientToken;
  if (!id || !token) return null;
  const client = await get(id);
  if (!client || client.access_revoked_at) return null;
  // Lien d'accès (…?client=…&clientToken=…) ou session ouverte avec le code d'accès
  let ok = Boolean(client.access_token_hash) && tokensMatch(client.access_token_hash, sha256(token));
  if (!ok && String(token).startsWith('cst_')) {
    const { rows } = await db.query(
      'SELECT 1 FROM client_sessions WHERE token_hash = $1 AND client_id = $2 AND expires_at > now()',
      [sha256(token), client.id]
    );
    ok = rows.length > 0;
  }
  if (!ok) return null;
  recordVisit(client.id);
  return client;
}

async function findByName(name) {
  const { rows } = await db.query('SELECT * FROM clients WHERE name = $1 ORDER BY created_at LIMIT 1', [name]);
  return rows[0] || null;
}

async function update(id, fields) {
  const allowed = {
    name: 'name', company: 'company', email: 'email', logoKey: 'logo_key', sector: 'sector',
    broadcastDate: 'broadcast_date', packageLabel: 'package_label', notes: 'notes',
    marketingOptin: 'marketing_optin', marketingOptinSource: 'marketing_optin_source',
  };
  const sets = [];
  const params = [id];
  for (const [k, col] of Object.entries(allowed)) {
    if (fields[k] !== undefined) {
      params.push(fields[k]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return get(id);
  // Consentement marketing : on date chaque changement de réponse
  if (fields.marketingOptin !== undefined) sets.push('marketing_optin_at = now()');
  // Nouvelle adresse ou nouvelle date : l'envoi automatique repart de zéro
  if (fields.email !== undefined || fields.broadcastDate !== undefined) {
    sets.push('access_email_attempts = 0', 'access_email_error = NULL');
  }
  const { rows } = await db.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0] || null;
}

async function list() {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.company, c.email, c.logo_key, c.created_at, c.broadcast_date, c.package_label,
            (c.access_token_hash IS NOT NULL OR c.access_code_hash IS NOT NULL) AS has_access, c.access_issued_at, c.access_issued_via,
            c.access_revoked_at, c.access_email_sent_at, c.access_email_error, c.access_email_attempts,
            c.marketing_optin,
            COUNT(v.id) FILTER (WHERE v.active)::int AS videos,
            MIN(COALESCE(v.broadcast_date, c.broadcast_date)) FILTER (WHERE v.active) AS trigger_date
     FROM clients c LEFT JOIN client_videos v ON v.client_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC`
  );
  return rows;
}

async function addVideo(clientId, { programmeId, title, sourceKey, broadcastDate, durationSec }) {
  const { rows } = await db.query(
    `INSERT INTO client_videos (id, client_id, programme_id, title, source_key, broadcast_date, duration_sec)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [crypto.randomUUID(), clientId, programmeId, title, sourceKey, broadcastDate || null, durationSec || null]
  );
  return rows[0];
}

async function setVideoActive(clientId, videoId, active) {
  await db.query('UPDATE client_videos SET active = $3 WHERE id = $2 AND client_id = $1', [clientId, videoId, active]);
}

async function listVideos(clientId) {
  const { rows } = await db.query(
    'SELECT * FROM client_videos WHERE client_id = $1 AND active = true ORDER BY broadcast_date DESC NULLS LAST, created_at DESC',
    [clientId]
  );
  return rows;
}

/** Toutes les vidéos du client, retirées comprises (historique des émissions dans le back-office). */
async function listAllVideos(clientId) {
  const { rows } = await db.query(
    'SELECT * FROM client_videos WHERE client_id = $1 ORDER BY active DESC, broadcast_date DESC NULLS LAST, created_at DESC',
    [clientId]
  );
  return rows;
}

/** Vidéo du client (null si elle n'existe pas, est désactivée ou appartient à un autre client). */
async function getVideo(clientId, videoId) {
  if (!isUuid(videoId) || !clientId) return null;
  const { rows } = await db.query(
    'SELECT * FROM client_videos WHERE id = $1 AND client_id = $2 AND active = true',
    [videoId, clientId]
  );
  return rows[0] || null;
}

/** Client dont l'e-mail correspond, s'il n'y en a qu'un (sinon null). */
async function findByEmail(email) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail || !mail.includes('@')) return null;
  const { rows } = await db.query('SELECT * FROM clients WHERE lower(email) = $1 LIMIT 2', [mail]);
  return rows.length === 1 ? rows[0] : null;
}

/* ------------------------------------------------------------------ Code d'accès */

// Sans lettres ni chiffres ambigus (O/0, I/1, L) : le code se lit et se recopie sans erreur
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Nouveau code au format OM-XXXX-XX (6 caractères aléatoires, environ 900 millions de combinaisons). */
function newAccessCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `OM-${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}`;
}

/** « om 4827 ev », « OM4827EV »… → « OM-4827-EV » ; null si le format est impossible. */
function normalizeCode(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^OM[A-Z0-9]{6}$/.test(s)) return null;
  return `OM-${s.slice(2, 6)}-${s.slice(6, 8)}`;
}

/** Client correspondant à un code (accès non coupé), ou null. */
async function findByCode(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  const { rows } = await db.query(
    'SELECT * FROM clients WHERE access_code_hash = $1 AND access_revoked_at IS NULL',
    [sha256(c)]
  );
  return rows[0] || null;
}

/** Ouvre une session pour ce navigateur (180 jours). Renvoie le jeton à garder côté client. */
async function openSession(clientId, userAgent) {
  const token = `cst_${crypto.randomBytes(32).toString('base64url')}`;
  await db.query(
    `INSERT INTO client_sessions (token_hash, client_id, expires_at, user_agent)
     VALUES ($1, $2, now() + interval '180 days', $3)`,
    [sha256(token), clientId, String(userAgent || '').slice(0, 300)]
  );
  return token;
}

async function closeSession(token) {
  if (String(token || '').startsWith('cst_')) await db.query('DELETE FROM client_sessions WHERE token_hash = $1', [sha256(token)]);
}

const lastVisitWrite = new Map();
/** Note la venue du client dans son espace (jour de Paris). Sans effet sur la requête en cas d'erreur. */
function recordVisit(clientId, { now = Date.now(), force = false } = {}) {
  const last = lastVisitWrite.get(clientId) || 0;
  if (!force && now - last < 10 * 60 * 1000) return Promise.resolve(false);
  lastVisitWrite.set(clientId, now);
  return db.query(
    `WITH v AS (
       INSERT INTO client_visits (client_id, day) VALUES ($1, (now() AT TIME ZONE 'Europe/Paris')::date)
       ON CONFLICT (client_id, day) DO UPDATE SET last_at = now(), hits = client_visits.hits + 1
       RETURNING client_id)
     UPDATE clients SET last_seen_at = now(), first_seen_at = COALESCE(first_seen_at, now())
     WHERE id = (SELECT client_id FROM v)`,
    [clientId]
  ).then(() => true, (e) => { console.error('[visites]', e.message); return false; });
}

module.exports = { recordVisit, findByEmail, newAccessCode, normalizeCode, findByCode, openSession, closeSession, create, get, findByName, fromRequest, update, list, addVideo, setVideoActive, listVideos, listAllVideos, getVideo, sha256 };
