'use strict';
/**
 * Back-office, rubrique Diffusions : diffusions vidéo du planning, vidéos reçues (Google Drive), état du code
 * d'accès de chaque client. Lecture du planning et passage Drive à la demande.
 */
const express = require('express');
const config = require('./config');
const mailer = require('./mailer');
const audit = require('./admin/audit');
const diffusions = require('./diffusions');
const driveSync = require('./driveSync');
const { requireTeam } = require('./admin/session');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function setup() {
  return {
    planning: Boolean(config.planning.exportUrl && config.planning.exportKey),
    planningEveryMin: config.planning.syncMinutes,
    drive: driveSync.enabled(),
    driveRootUrl: config.drive.rootFolderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(config.drive.rootFolderId)}` : null,
    alertsTo: config.mail.teamAlertEmail || null,
    mailProblem: mailer.problem(),
    redirectTo: config.mail.redirectTo || null,
    sendHour: config.mail.accessSendFromHour,
  };
}

router.get('/admin/diffusions', requireTeam, wrap(async (req, res) => {
  res.json({ diffusions: await diffusions.list(), lastSync: diffusions.lastSync(), lastDrive: driveSync.lastResult(), setup: setup() });
}));

/** Relit le planning tout de suite (sans attendre le passage automatique). */
router.post('/admin/diffusions/sync', requireTeam, wrap(async (req, res) => {
  const r = await diffusions.runSync();
  await audit.record(req, 'planning_relu', { detail: r.ok ? { creees: r.created, mises_a_jour: r.updated, clients: r.clientsCreated } : { erreur: r.error } });
  if (!r.ok) return res.status(503).json({ error: r.error });
  res.json({ lastSync: r });
}));

/** Crée les dossiers Drive manquants et importe une vidéo déposée, tout de suite. */
router.post('/admin/diffusions/drive', requireTeam, wrap(async (req, res) => {
  if (!driveSync.enabled()) return res.status(503).json({ error: 'Google Drive n’est pas encore branché (GOOGLE_SERVICE_ACCOUNT_JSON, DRIVE_ROOT_FOLDER_ID).' });
  const r = await driveSync.tick({ force: true });
  if (r && !r.ok) return res.status(502).json({ error: r.error });
  res.json({ lastDrive: r });
}));

module.exports = router;
