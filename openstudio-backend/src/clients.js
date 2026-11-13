'use strict';
/**
 * Clients et vidéos de leur package.
 * Chaque client a un espace (jeton d'accès) et une liste de vidéos qui dépend de son package :
 * un client peut n'avoir qu'un passage BFM Business, un autre un passage BFM + une immersion, etc.
 * TODO : remplacer le jeton par l'authentification des comptes quand elle existera.
 */
const crypto = require('crypto');
const db = require('./db');
const { newAccessToken, tokensMatch } = require('./auth');

const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v));

async function create({ name, company, email, logoKey }) {
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO clients (id, name, company, email, access_token, logo_key)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, name, company || null, email || null, newAccessToken(), logoKey || null]
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
  return client && tokensMatch(client.access_token, token) ? client : null;
}

async function findByName(name) {
  const { rows } = await db.query('SELECT * FROM clients WHERE name = $1 ORDER BY created_at LIMIT 1', [name]);
  return rows[0] || null;
}

async function update(id, fields) {
  const allowed = { name: 'name', company: 'company', email: 'email', logoKey: 'logo_key' };
  const sets = [];
  const params = [id];
  for (const [k, col] of Object.entries(allowed)) {
    if (fields[k] !== undefined) {
      params.push(fields[k]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return get(id);
  const { rows } = await db.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0] || null;
}

async function list() {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.company, c.email, c.logo_key, c.created_at,
            COUNT(v.id) FILTER (WHERE v.active) AS videos
     FROM clients c LEFT JOIN client_videos v ON v.client_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC`
  );
  return rows;
}

async function addVideo(clientId, { programmeId, title, sourceKey, broadcastDate }) {
  const { rows } = await db.query(
    `INSERT INTO client_videos (id, client_id, programme_id, title, source_key, broadcast_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [crypto.randomUUID(), clientId, programmeId, title, sourceKey, broadcastDate || null]
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

module.exports = { create, get, findByName, fromRequest, update, list, addVideo, setVideoActive, listVideos, getVideo };
