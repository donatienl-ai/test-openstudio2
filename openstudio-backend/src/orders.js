'use strict';
/**
 * Accès aux commandes. Toutes les transitions d'état sont ATOMIQUES (UPDATE … WHERE status = …),
 * ce qui garantit l'idempotence : un même événement reçu deux fois ne produit qu'un effet.
 *
 * Cycle de vie :
 *   draft → validated → paid → submitting → processing → opus_done → postprocessing → ready
 *   (sous-titres avec fichier fourni : paid → submitting → opus_done directement, sans OpusClip)
 *                                                    ↘ error (à toute étape)      dry_run (mode test)
 */
const crypto = require('crypto');
const db = require('./db');
const { newAccessToken } = require('./auth');

const { VIDEO_TYPES } = require('./opusclip/payload');

async function create({ type, options, client, clientId }) {
  const id = crypto.randomUUID();
  const token = newAccessToken();
  const { rows } = await db.query(
    `INSERT INTO orders (id, access_token, type, status, options, client, client_id)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6) RETURNING *`,
    [id, token, type, JSON.stringify(options), JSON.stringify(client || {}), clientId || null]
  );
  await db.logEvent(id, 'created', { type });
  return rows[0];
}

async function get(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getByProjectId(projectId) {
  const { rows } = await db.query('SELECT * FROM orders WHERE opus_project_id = $1', [String(projectId)]);
  return rows[0] || null;
}

/** draft → validated (une seule fois). */
async function markValidated(id, normalizedOptions, subtitleMode) {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'validated', options = $2, subtitle_mode = $3, updated_at = now()
     WHERE id = $1 AND status = 'draft' RETURNING *`,
    [id, JSON.stringify(normalizedOptions), subtitleMode]
  );
  if (rows[0]) await db.logEvent(id, 'validated');
  return rows[0] || null;
}

/** validated + non payée → paid. Idempotent : renvoie null si déjà payée. */
async function markPaid(id, paymentRef) {
  const { rows } = await db.query(
    `UPDATE orders SET payment_status = 'paid', payment_ref = $2, status = 'paid', updated_at = now()
     WHERE id = $1 AND status = 'validated' AND payment_status <> 'paid' RETURNING *`,
    [id, paymentRef]
  );
  if (rows[0]) await db.logEvent(id, 'paid', { paymentRef });
  return rows[0] || null;
}

/** Réserve atomiquement la prochaine commande dans l'état `from` et la passe à `to`. */
async function claimNext(from, to, extraWhere = '') {
  const { rows } = await db.query(
    `UPDATE orders SET status = $2, updated_at = now()
     WHERE id = (
       SELECT id FROM orders WHERE status = $1 ${extraWhere}
       ORDER BY updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [from, to]
  );
  return rows[0] || null;
}

/** Réserve une commande « processing » dont la dernière vérification est trop ancienne. */
async function claimDuePoll(intervalSec) {
  const { rows } = await db.query(
    `UPDATE orders SET last_polled_at = now()
     WHERE id = (
       SELECT id FROM orders
       WHERE status = 'processing'
         AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => $1))
       ORDER BY last_polled_at ASC NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [intervalSec]
  );
  return rows[0] || null;
}

async function setProcessing(id, projectId, payload, estimatedCredits) {
  await db.query(
    `UPDATE orders SET status = 'processing', opus_project_id = $2, opus_payload = $3,
       estimated_credits = $4, submitted_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, projectId, JSON.stringify(payload), estimatedCredits]
  );
  await db.logEvent(id, 'submitted', { projectId });
}

/** Enregistre l'identifiant de projet dès sa création (protection contre une double soumission). */
async function saveProjectId(id, projectId) {
  await db.query('UPDATE orders SET opus_project_id = $2, updated_at = now() WHERE id = $1', [id, projectId]);
}

/** processing → opus_done (webhook ou polling). Idempotent. */
async function markOpusDone(id, source) {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'opus_done', updated_at = now(),
       webhook_received_at = CASE WHEN $2 = 'webhook' THEN now() ELSE webhook_received_at END
     WHERE id = $1 AND status = 'processing' RETURNING *`,
    [id, source]
  );
  if (rows[0]) await db.logEvent(id, 'opus_done', { source });
  return rows[0] || null;
}

async function setStatus(id, status, fields = {}) {
  const sets = ['status = $2', 'updated_at = now()'];
  const params = [id, status];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  await db.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, params);
  await db.logEvent(id, status, fields.error ? { error: fields.error } : null);
}

async function fail(id, message) {
  console.error(`[order ${id}] ERREUR : ${message}`);
  await setStatus(id, 'error', { error: String(message).slice(0, 2000) });
}

async function setPollClipCount(id, count) {
  await db.query('UPDATE orders SET poll_clip_count = $2 WHERE id = $1', [id, count]);
}

/** Remet en file les commandes restées bloquées dans un état transitoire (redémarrage du service). */
async function recoverStuck(minutes = 30) {
  await db.query(
    `UPDATE orders SET status = CASE WHEN opus_project_id IS NULL THEN 'paid' ELSE 'processing' END, updated_at = now()
     WHERE status = 'submitting' AND updated_at < now() - make_interval(mins => $1)`,
    [minutes]
  );
  await db.query(
    `UPDATE orders SET status = 'opus_done', updated_at = now()
     WHERE status = 'postprocessing' AND updated_at < now() - make_interval(mins => $1)`,
    [minutes * 4]
  );
}

// --- Livrables ---

async function addDeliverable(d) {
  await db.query(
    `INSERT INTO deliverables (id, order_id, storage_key, file_name, title, duration_ms, size_bytes, opus_clip_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (order_id, opus_clip_id) DO NOTHING`,
    [crypto.randomUUID(), d.orderId, d.storageKey, d.fileName, d.title, d.durationMs, d.sizeBytes, d.opusClipId, d.expiresAt]
  );
}

async function listDeliverables(orderId) {
  const { rows } = await db.query(
    'SELECT * FROM deliverables WHERE order_id = $1 AND purged = false ORDER BY file_name ASC',
    [orderId]
  );
  return rows;
}

async function existingClipIds(orderId) {
  const { rows } = await db.query('SELECT opus_clip_id FROM deliverables WHERE order_id = $1', [orderId]);
  return new Set(rows.map((r) => r.opus_clip_id));
}

async function listForClient(clientId) {
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 200',
    [clientId]
  );
  return rows;
}

async function listEvents(orderId) {
  const { rows } = await db.query(
    'SELECT kind, detail, created_at FROM order_events WHERE order_id = $1 ORDER BY id ASC',
    [orderId]
  );
  return rows;
}

// --- Crédits ---

async function creditsUsed() {
  const { rows } = await db.query('SELECT COALESCE(SUM(credits), 0) AS used FROM credit_ledger');
  return Number(rows[0].used);
}

async function recordCredits(orderId, credits, note) {
  await db.query('INSERT INTO credit_ledger (order_id, credits, note) VALUES ($1, $2, $3)', [orderId, credits, note]);
}

module.exports = {
  VIDEO_TYPES,
  create,
  get,
  getByProjectId,
  markValidated,
  markPaid,
  claimNext,
  claimDuePoll,
  setProcessing,
  saveProjectId,
  markOpusDone,
  setStatus,
  fail,
  setPollClipCount,
  recoverStuck,
  addDeliverable,
  listDeliverables,
  existingClipIds,
  listEvents,
  listForClient,
  creditsUsed,
  recordCredits,
};
