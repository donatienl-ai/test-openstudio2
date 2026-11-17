'use strict';
/**
 * Diffusions des clients (une ligne par diffusion vidéo du planning) et lancement de la synchronisation.
 * Logique de synchronisation : src/planningSync.js ; ici, l'accès à la base.
 */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const clients = require('./clients');
const { syncDiffusions, fetchPlanning } = require('./planningSync');

const SELECT = `SELECT id, planning_id, client_id, sf_opportunity_id, entreprise, media, sous_media, format,
  to_char(date_diffusion, 'YYYY-MM-DD') AS date_diffusion, planning_statut, state, contact_name, contact_email,
  email_override, video_id, drive_folder_id, drive_folder_name, video_imported_at, video_import_error,
  mail_sent_at, planning_updated_at, synced_at, created_at, updated_at
  FROM diffusions`;

function fromRow(r) {
  return r && {
    id: r.id,
    planningId: r.planning_id,
    clientId: r.client_id,
    sfOpportunityId: r.sf_opportunity_id,
    entreprise: r.entreprise,
    media: r.media,
    sousMedia: r.sous_media,
    format: r.format,
    dateDiffusion: r.date_diffusion,
    planningStatut: r.planning_statut,
    state: r.state,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    emailOverride: r.email_override,
    videoId: r.video_id,
    driveFolderId: r.drive_folder_id,
    driveFolderName: r.drive_folder_name || null,
    videoImportedAt: r.video_imported_at || null,
    videoImportError: r.video_import_error || null,
    mailSentAt: r.mail_sent_at,
    planningUpdatedAt: r.planning_updated_at,
    syncedAt: r.synced_at,
  };
}

/** Accès base utilisé par syncDiffusions. */
const store = {
  async findDiffusion(planningId) {
    const { rows } = await db.query(`${SELECT} WHERE planning_id = $1`, [planningId]);
    return fromRow(rows[0]) || null;
  },
  async insertDiffusion(f) {
    await db.query(
      `INSERT INTO diffusions (id, planning_id, client_id, sf_opportunity_id, entreprise, media, sous_media, format,
         date_diffusion, planning_statut, state, contact_name, contact_email, planning_updated_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (planning_id) DO NOTHING`,
      [crypto.randomUUID(), f.planningId, f.clientId, f.sfOpportunityId, f.entreprise, f.media, f.sousMedia, f.format,
        f.dateDiffusion, f.planningStatut, f.state, f.contactName, f.contactEmail, f.planningUpdatedAt]
    );
  },
  async updateDiffusion(planningId, f) {
    await db.query(
      `UPDATE diffusions SET sf_opportunity_id = $2, entreprise = $3, media = $4, sous_media = $5, format = $6,
         date_diffusion = $7, planning_statut = $8, state = $9, contact_name = $10, contact_email = $11,
         planning_updated_at = $12, synced_at = now(), updated_at = now()
       WHERE planning_id = $1`,
      [planningId, f.sfOpportunityId, f.entreprise, f.media, f.sousMedia, f.format, f.dateDiffusion, f.planningStatut,
        f.state, f.contactName, f.contactEmail, f.planningUpdatedAt]
    );
    // Vidéo déjà importée : elle suit la date (report) et l'état (invisible si annulée ou date à fixer)
    await db.query(
      `UPDATE client_videos SET broadcast_date = $2, active = $3
       WHERE id = (SELECT video_id FROM diffusions WHERE planning_id = $1)`,
      [planningId, f.state === 'active' ? f.dateDiffusion : null, f.state === 'active']
    );
  },
  async findClientByKey(key) {
    if (!key) return null;
    const { rows } = await db.query('SELECT * FROM clients WHERE company_key = $1 ORDER BY created_at LIMIT 1', [key]);
    return rows[0] || null;
  },
  async createClient({ name, companyKey, email, sector }) {
    const c = await clients.create({ name, company: name, email });
    await db.query('UPDATE clients SET company_key = $2, sector = COALESCE(sector, $3) WHERE id = $1', [c.id, companyKey, sector]);
    return c;
  },
  async fillClientEmail(clientId, email) {
    await db.query("UPDATE clients SET email = $2 WHERE id = $1 AND (email IS NULL OR email = '')", [clientId, email]);
  },
};

let lastSync = null;
let running = false;

/** Lit le planning et met à jour les diffusions. Renvoie le compte rendu (aussi gardé pour l'écran équipe). */
async function runSync() {
  const { exportUrl, exportKey } = config.planning;
  if (!exportUrl || !exportKey) return { ok: false, error: 'PLANNING_EXPORT_URL ou PLANNING_EXPORT_KEY non configurée' };
  if (running) return { ok: false, error: 'Synchronisation déjà en cours' };
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const rows = await fetchPlanning({ url: exportUrl, key: exportKey });
    const report = await syncDiffusions(rows, store);
    lastSync = { ok: true, startedAt, received: rows.length, ...report };
    if (report.created || report.updated) {
      console.log(`[planning] ${rows.length} diffusions lues : ${report.created} créée(s), ${report.updated} mise(s) à jour, ${report.clientsCreated} client(s) créé(s)`);
    }
  } catch (e) {
    lastSync = { ok: false, startedAt, error: e.message };
    console.error('[planning] synchronisation :', e.message);
  } finally {
    running = false;
  }
  return lastSync;
}

/** Liste pour l'équipe (future page « Diffusions »). */
async function list({ from } = {}) {
  const params = [];
  let where = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))) {
    params.push(from);
    where = ` WHERE d.date_diffusion >= $1 OR d.state = 'date_pending'`;
  }
  const { rows } = await db.query(
    `SELECT d.*, to_char(d.date_diffusion, 'YYYY-MM-DD') AS date_diffusion, c.name AS client_name, c.email AS client_email
     FROM diffusions d JOIN clients c ON c.id = d.client_id${where}
     ORDER BY d.date_diffusion ASC NULLS LAST, d.entreprise ASC`,
    params
  );
  return rows.map((r) => ({ ...fromRow(r), clientName: r.client_name, clientEmail: r.client_email }));
}

module.exports = { store, runSync, list, lastSync: () => lastSync };
