'use strict';
/**
 * Back-office, rubrique Clients : liste, fiche, création, import CSV et lien d'accès.
 * Les routes des vidéos du package restent dans routes.js (lot 3).
 */
const express = require('express');
const db = require('./db');
const config = require('./config');
const clients = require('./clients');
const mailer = require('./mailer');
const audit = require('./admin/audit');
const access = require('./admin/client-access');
const importer = require('./admin/client-import');
const { requireTeam } = require('./admin/session');
const mapping = require('./opusclip.config');

const router = express.Router();
const json = express.json({ limit: '50kb' });
const bigJson = express.json({ limit: '2mb' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clean = (v, max = 300) => (v === undefined ? undefined : (String(v ?? '').trim().slice(0, max) || null));

function publicClient(c) {
  return {
    id: c.id,
    name: c.name,
    company: c.company,
    email: c.email,
    broadcastDate: access.isoDay(c.broadcast_date),
    packageLabel: c.package_label,
    notes: c.notes,
    logoKey: c.logo_key,
    createdAt: c.created_at,
    videos: c.videos === undefined ? undefined : Number(c.videos),
    access: access.accessStatus(c),
  };
}

function mailState() {
  return {
    ready: !mailer.problem(),
    problem: mailer.problem(),
    redirectTo: config.mail.redirectTo || null,
    sendHour: config.mail.accessSendFromHour,
    clientSiteConfigured: Boolean(config.clientSiteUrl),
  };
}

/** Champs saisis dans le back-office, vérifiés. Renvoie { fields } ou { error }. */
function readFields(body, { creating }) {
  const f = {
    name: clean(body.name, 200),
    company: clean(body.company, 200),
    email: body.email === undefined ? undefined : (clean(body.email, 200) || '').toLowerCase() || null,
    packageLabel: clean(body.packageLabel, 200),
    notes: clean(body.notes, 2000),
  };
  if (body.broadcastDate !== undefined) {
    const d = importer.parseDate(body.broadcastDate);
    if (d === false) return { error: 'Date de diffusion illisible (format attendu : JJ/MM/AAAA).' };
    f.broadcastDate = d;
  }
  if (creating && !f.name) return { error: 'Nom du client requis.' };
  if (!creating && body.name !== undefined && !f.name) return { error: 'Le nom du client ne peut pas être vide.' };
  if (f.email && !isEmail(f.email)) return { error: 'Adresse e-mail invalide.' };
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return { fields: f };
}

async function emailTaken(email, exceptId = null) {
  if (!email) return false;
  const { rows } = await db.query('SELECT id FROM clients WHERE lower(email) = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)', [email, exceptId]);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ Liste et création */

router.get('/admin/clients', requireTeam, wrap(async (req, res) => {
  res.json({ clients: (await clients.list()).map(publicClient), mail: mailState() });
}));

router.post('/admin/clients', requireTeam, json, wrap(async (req, res) => {
  const { fields, error } = readFields(req.body || {}, { creating: true });
  if (error) return res.status(400).json({ error });
  if (await emailTaken(fields.email)) return res.status(409).json({ error: 'Un client existe déjà avec cette adresse e-mail.' });
  const c = await clients.create(fields);
  await audit.record(req, 'client_cree', { targetType: 'client', targetId: c.id, detail: { name: c.name, company: c.company } });
  res.status(201).json({ client: publicClient(c) });
}));

/* ------------------------------------------------------------------ Import CSV */

async function existingEmails() {
  const { rows } = await db.query("SELECT lower(email) AS email FROM clients WHERE email IS NOT NULL AND email <> ''");
  return new Set(rows.map((r) => r.email));
}

router.post('/admin/clients/import/preview', requireTeam, bigJson, wrap(async (req, res) => {
  const result = importer.analyse((req.body || {}).csv, { existingEmails: await existingEmails() });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

router.post('/admin/clients/import', requireTeam, bigJson, wrap(async (req, res) => {
  const result = importer.analyse((req.body || {}).csv, { existingEmails: await existingEmails() });
  if (result.error) return res.status(400).json({ error: result.error });
  const created = [];
  for (const r of result.rows) {
    if (r.problems.length) continue;
    created.push(await clients.create(r.client));
  }
  await audit.record(req, 'clients_importes', { detail: { crees: created.length, ignores: result.rejected } });
  res.status(201).json({ created: created.length, rejected: result.rejected });
}));

/* ------------------------------------------------------------------ Fiche client */

router.get('/admin/clients/:id', requireTeam, wrap(async (req, res) => {
  const c = await clients.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  const videos = await clients.listVideos(c.id);
  res.json({
    client: { ...publicClient(c), videos: videos.length },
    videos: videos.map((v) => ({
      id: v.id,
      title: v.title,
      programmeId: v.programme_id,
      programmeTitle: (mapping.programmes[v.programme_id] || {}).title || v.programme_id,
      broadcastDate: access.isoDay(v.broadcast_date),
      durationSec: v.duration_sec,
      createdAt: v.created_at,
    })),
    programmes: Object.entries(mapping.programmes).map(([id, p]) => ({ id, title: p.title })),
    history: await audit.list({ targetType: 'client', targetId: c.id, limit: 50 }),
    mail: mailState(),
  });
}));

router.post('/admin/clients/:id', requireTeam, json, wrap(async (req, res) => {
  const current = await clients.get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Client introuvable' });
  const { fields, error } = readFields(req.body || {}, { creating: false });
  if (error) return res.status(400).json({ error });
  if (fields.email && (await emailTaken(fields.email, current.id))) {
    return res.status(409).json({ error: 'Un autre client utilise déjà cette adresse e-mail.' });
  }
  // logoKey et sector restent modifiables comme avant (envoi technique)
  if (req.body && req.body.logoKey !== undefined) fields.logoKey = clean(req.body.logoKey, 500);
  if (req.body && req.body.sector !== undefined) fields.sector = clean(req.body.sector, 200);
  const changed = Object.keys(fields).filter((k) => String(fields[k] ?? '') !== String(
    { name: current.name, company: current.company, email: current.email, packageLabel: current.package_label, notes: current.notes,
      broadcastDate: access.isoDay(current.broadcast_date), logoKey: current.logo_key, sector: current.sector }[k] ?? ''
  ));
  if (!changed.length) return res.json({ client: publicClient(current) });
  const c = await clients.update(current.id, Object.fromEntries(changed.map((k) => [k, fields[k]])));
  await audit.record(req, 'client_modifie', { targetType: 'client', targetId: c.id, detail: { champs: changed } });
  res.json({ client: publicClient(c) });
}));

/* ------------------------------------------------------------------ Lien d'accès */

/** Envoie tout de suite un nouveau lien par e-mail (l'ancien cesse de fonctionner). */
router.post('/admin/clients/:id/access/send', requireTeam, wrap(async (req, res) => {
  const c = await clients.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  if (!c.email) return res.status(409).json({ error: 'Renseignez d’abord l’adresse e-mail du client.' });
  if (!config.clientSiteUrl) return res.status(503).json({ error: 'Adresse de l’espace client non configurée (CLIENT_SITE_URL).' });
  try {
    const r = await access.sendByEmail(c, { req });
    res.json({ client: publicClient(r.client), redirectedTo: r.redirectedTo || null });
  } catch (e) {
    res.status(502).json({ error: `L’e-mail n’est pas parti : ${e.message}` });
  }
}));

/** Crée un lien à transmettre soi-même (affiché une seule fois). */
router.post('/admin/clients/:id/access/link', requireTeam, wrap(async (req, res) => {
  const c = await clients.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  if (!config.clientSiteUrl) return res.status(503).json({ error: 'Adresse de l’espace client non configurée (CLIENT_SITE_URL).' });
  const r = await access.issue(c.id, 'manuel');
  await audit.record(req, 'acces_lien_cree', { targetType: 'client', targetId: c.id });
  res.json({ client: publicClient(r.client), link: r.link });
}));

router.post('/admin/clients/:id/access/revoke', requireTeam, wrap(async (req, res) => {
  const c = await access.revoke(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  await audit.record(req, 'acces_coupe', { targetType: 'client', targetId: c.id });
  res.json({ client: publicClient(c) });
}));

module.exports = router;
module.exports.publicClient = publicClient;
