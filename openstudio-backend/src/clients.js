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
async function create({ name, company, email, logoKey, broadcastDate, packageLabel, notes, keepPlainToken = false }) {
  const id = crypto.randomUUID();
  const token = keepPlainToken ? newAccessToken() : null;
  const { rows } = await db.query(
    `INSERT INTO clients (id, name, company, email, access_token, access_token_hash, logo_key,
                          broadcast_date, package_label, notes, access_issued_at, access_issued_via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [id, name, company || null, email || null, token, token ? sha256(token) : null, logoKey || null,
      broadcastDate || null, packageLabel || null, notes || null, token ? new Date().toISOString() : null, token ? 'manuel' : null]
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
  if (!client || client.access_revoked_at || !client.access_token_hash) return null;
  return tokensMatch(client.access_token_hash, sha256(token)) ? client : null;
}

async function findByName(name) {
  const { rows } = await db.query('SELECT * FROM clients WHERE name = $1 ORDER BY created_at LIMIT 1', [name]);
  return rows[0] || null;
}

async function update(id, fields) {
  const allowed = {
    name: 'name', company: 'company', email: 'email', logoKey: 'logo_key', sector: 'sector',
    broadcastDate: 'broadcast_date', packageLabel: 'package_label', notes: 'notes',
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
            c.access_token_hash IS NOT NULL AS has_access, c.access_issued_at, c.access_issued_via,
            c.access_revoked_at, c.access_email_sent_at, c.access_email_error, c.access_email_attempts,
            COUNT(v.id) FILTER (WHERE v.active)::int AS videos
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

/** Vidéo du client (null si elle n'existe pas, est désactivée ou appartient à un autre client). */
async function getVideo(clientId, videoId) {
  if (!isUuid(videoId) || !clientId) return null;
  const { rows } = await db.query(
    'SELECT * FROM client_videos WHERE id = $1 AND client_id = $2 AND active = true',
    [videoId, clientId]
  );
  return rows[0] || null;
}

module.exports = { create, get, findByName, fromRequest, update, list, addVideo, setVideoActive, listVideos, getVideo, sha256 };
