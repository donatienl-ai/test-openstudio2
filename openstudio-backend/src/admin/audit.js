'use strict';
/** Journal d'audit : qui a fait quoi, quand, sur quoi. Une écriture qui échoue ne bloque jamais l'action. */
const db = require('../db');

/** Libellé de l'auteur d'une requête admin. */
function actorOf(req) {
  if (req && req.adminUser) return { id: req.adminUser.id, label: req.adminUser.name };
  if (req && req.adminViaLegacyToken) return { id: null, label: 'jeton technique' };
  if (req && req.auditActorLabel) return { id: null, label: req.auditActorLabel };
  return { id: null, label: 'système' };
}

async function record(req, action, { targetType = null, targetId = null, detail = null } = {}) {
  const actor = actorOf(req);
  try {
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_label, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actor.id, actor.label, action, targetType, targetId ? String(targetId) : null,
        detail ? JSON.stringify(detail) : null, (req && req.ip) || null]
    );
  } catch (e) {
    console.error('[audit] écriture impossible', action, e.message);
  }
}

async function list({ limit = 100, before = null, targetType = null, targetId = null } = {}) {
  const params = [];
  const where = [];
  if (before) { params.push(before); where.push(`id < $${params.length}`); }
  if (targetType) { params.push(targetType); where.push(`target_type = $${params.length}`); }
  if (targetId) { params.push(String(targetId)); where.push(`target_id = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const { rows } = await db.query(
    `SELECT id, at, actor_label, action, target_type, target_id, detail
     FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

module.exports = { record, list, actorOf };
