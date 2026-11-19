'use strict';
/**
 * Diffusions vidéo du planning (une ligne par diffusion, reliée à la fiche client) : accès à la base,
 * lecture du planning et liste de la rubrique « Diffusions » du back-office.
 * Logique de synchronisation : src/planningSync.js ; état affiché : src/diffusionStatus.js.
 */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const clients = require('./clients');
const access = require('./admin/client-access');
const credits = require('./credits/service');
const audit = require('./admin/audit');
const { syncDiffusions, fetchPlanning } = require('./planningSync');
const { rowStatus } = require('./diffusionStatus');

const COLS = `id, planning_id, client_id, sf_opportunity_id, entreprise, media, sous_media, format,
  to_char(date_diffusion, 'YYYY-MM-DD') AS date_diffusion, planning_statut, state, contact_name, contact_email,
  contact_source, video_id`;

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
    contactSource: r.contact_source,
    videoId: r.video_id,
  };
}

/** Accès base utilisé par syncDiffusions. */
const store = {
  async findDiffusion(planningId) {
    const { rows } = await db.query(`SELECT ${COLS} FROM diffusions WHERE planning_id = $1`, [planningId]);
    return fromRow(rows[0]) || null;
  },
  async insertDiffusion(f) {
    await db.query(
      `INSERT INTO diffusions (id, planning_id, client_id, sf_opportunity_id, entreprise, media, sous_media, format,
         date_diffusion, planning_statut, state, contact_name, contact_email, contact_source, planning_updated_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (planning_id) DO NOTHING`,
      [crypto.randomUUID(), f.planningId, f.clientId, f.sfOpportunityId, f.entreprise, f.media, f.sousMedia, f.format,
        f.dateDiffusion, f.planningStatut, f.state, f.contactName, f.contactEmail, f.contactSource, f.planningUpdatedAt]
    );
  },
  async updateDiffusion(planningId, f) {
    await db.query(
      `UPDATE diffusions SET sf_opportunity_id = $2, entreprise = $3, media = $4, sous_media = $5, format = $6,
         date_diffusion = $7, planning_statut = $8, state = $9, contact_name = $10, contact_email = $11,
         contact_source = $12, planning_updated_at = $13, synced_at = now(), updated_at = now()
       WHERE planning_id = $1`,
      [planningId, f.sfOpportunityId, f.entreprise, f.media, f.sousMedia, f.format, f.dateDiffusion, f.planningStatut,
        f.state, f.contactName, f.contactEmail, f.contactSource, f.planningUpdatedAt]
    );
    // Vidéo déjà importée : elle suit la date (report) et l'état (retirée si annulée ou date à fixer)
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
  /** Nouvelle fiche client, comme une création dans le back-office : code d'accès et crédits offerts. */
  async createClient({ name, company, companyKey, email, broadcastDate, packageLabel, sector }) {
    const taken = email ? await clients.findByEmail(email) : null; // une adresse = un seul client
    const c = await clients.create({ name, company, email: taken ? null : email, broadcastDate, packageLabel });
    await db.query('UPDATE clients SET company_key = $2, sector = COALESCE(sector, $3) WHERE id = $1', [c.id, companyKey, sector]);
    await access.ensureCode(c.id);
    await credits.grantIncluded(c.id, 'création du compte');
    await audit.record({ auditActorLabel: 'planning de diffusion' }, 'client_cree', { targetType: 'client', targetId: c.id, detail: { name: c.name, company: c.company } });
    return c;
  },
  /** Complète l'e-mail d'un client qui n'en a pas (jamais écrasé, jamais l'adresse d'un autre client). */
  async fillClientEmail(clientId, email) {
    await db.query(
      `UPDATE clients SET email = $2 WHERE id = $1 AND (email IS NULL OR email = '')
         AND NOT EXISTS (SELECT 1 FROM clients o WHERE lower(o.email) = lower($2) AND o.id <> $1)`,
      [clientId, email]
    );
  },
  /**
   * Date de diffusion de la fiche = sa première diffusion active, tant que le code n'est pas parti
   * (c'est elle qui programme l'envoi du code et la fin de validité des crédits).
   */
  async refreshClient(clientId) {
    await db.query(
      `UPDATE clients c SET broadcast_date = m.first_day
       FROM (SELECT MIN(date_diffusion) AS first_day FROM diffusions WHERE client_id = $1 AND state = 'active') m
       WHERE c.id = $1 AND c.access_email_sent_at IS NULL AND m.first_day IS NOT NULL
         AND c.broadcast_date IS DISTINCT FROM m.first_day`,
      [clientId]
    );
  },
};

let lastSync = null;
let running = false;
let lastRun = 0;

/** Lit le planning et met à jour les diffusions. Renvoie le compte rendu (affiché dans la rubrique). */
async function runSync() {
  const { exportUrl, exportKey } = config.planning;
  if (!exportUrl || !exportKey) return { ok: false, error: 'Lecture du planning non configurée (PLANNING_EXPORT_URL, PLANNING_EXPORT_KEY).' };
  if (running) return { ok: false, error: 'Lecture du planning déjà en cours' };
  running = true;
  lastRun = Date.now();
  const at = new Date().toISOString();
  try {
    const rows = await fetchPlanning({ url: exportUrl, key: exportKey });
    const report = await syncDiffusions(rows, store);
    lastSync = { ok: true, at, received: rows.length, ...report, changes: report.changes.slice(0, 50) };
    if (report.created || report.updated) {
      console.log(`[planning] ${rows.length} diffusions lues : ${report.created} créée(s), ${report.updated} mise(s) à jour, ${report.clientsCreated} client(s) créé(s)`);
    }
  } catch (e) {
    lastSync = { ok: false, at, error: e.message };
    console.error('[planning] lecture :', e.message);
  } finally {
    running = false;
  }
  return lastSync;
}

/** Passage automatique (worker) : toutes les PLANNING_SYNC_MIN minutes. */
function tick() {
  if (!config.planning.exportUrl || !config.planning.exportKey) return;
  if (Date.now() - lastRun < config.planning.syncMinutes * 60 * 1000) return;
  runSync();
}

/** Lignes de la rubrique « Diffusions » : diffusion + fiche client + état de l'accès. */
async function list({ today = access.parisParts().day } = {}) {
  const { rows } = await db.query(
    `SELECT d.id, d.planning_id, d.client_id, d.sf_opportunity_id, d.entreprise, d.media, d.sous_media, d.format,
            to_char(d.date_diffusion, 'YYYY-MM-DD') AS date_diffusion, d.planning_statut, d.state, d.contact_name,
            d.contact_email, d.contact_source, d.drive_folder_id,
            -- vidéo importée depuis Drive, ou déposée à la main sur la fiche client pour la même date
            COALESCE(d.video_id, (SELECT v.id FROM client_videos v WHERE v.client_id = d.client_id AND v.active = true
                                    AND v.broadcast_date = d.date_diffusion ORDER BY v.created_at LIMIT 1)) AS video_id, d.video_imported_at, d.video_import_error,
            to_char(d.alert_before_on, 'YYYY-MM-DD') AS alert_before_on, to_char(d.alert_dayj_on, 'YYYY-MM-DD') AS alert_dayj_on,
            c.name AS client_name, c.company AS client_company, c.email AS client_email,
            c.access_email_sent_at, c.access_email_error, c.access_revoked_at
     FROM diffusions d JOIN clients c ON c.id = d.client_id
     WHERE d.state <> 'cancelled' OR d.date_diffusion >= $1::date - 30
     ORDER BY d.date_diffusion ASC NULLS LAST, d.entreprise ASC`,
    [today]
  );
  return rows.map((r) => {
    const d = {
      ...fromRow(r),
      driveFolderId: r.drive_folder_id || null,
      driveUrl: r.drive_folder_id ? `https://drive.google.com/drive/folders/${encodeURIComponent(r.drive_folder_id)}` : null,
      videoImportedAt: r.video_imported_at || null,
      videoImportError: r.video_import_error || null,
      alertBeforeOn: r.alert_before_on || null,
      alertDayJOn: r.alert_dayj_on || null,
      client: { id: r.client_id, name: r.client_name, company: r.client_company, email: r.client_email },
      accessSentAt: r.access_email_sent_at || null,
      accessError: r.access_email_error || null,
      accessRevokedAt: r.access_revoked_at || null,
    };
    return { ...d, status: rowStatus(d, { today, sendHour: config.mail.accessSendFromHour }) };
  });
}

module.exports = { store, runSync, tick, list, lastSync: () => lastSync };
