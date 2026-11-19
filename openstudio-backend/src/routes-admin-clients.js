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
    triggerDate: c.trigger_date !== undefined ? access.isoDay(c.trigger_date) : undefined,
    marketing: {
      optin: c.marketing_optin === undefined ? null : c.marketing_optin,
      at: c.marketing_optin_at || null,
      source: c.marketing_optin_source || null,
    },
    access: access.accessStatus(c),
  };
}

/** Fiche à jour, avec le nombre de vidéos et la date qui déclenche l'envoi du lien. */
async function fresh(id) {
  return publicClient(await access.withAccessInfo(await clients.get(id)));
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
    marketingOptinSource: clean(body.marketingOptinSource, 200),
  };
  if (body.marketingOptin !== undefined) {
    const v = body.marketingOptin;
    f.marketingOptin = v === true || v === 'oui' ? true : v === false || v === 'non' ? false : null;
  }
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
  res.status(201).json({ client: await fresh(c.id) });
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
  const videos = await clients.listAllVideos(c.id);
  const [emails, contents, montage, publications] = await Promise.all([
    db.query(
      `SELECT id, kind, to_email, redirected_to, subject, status, error, automatic, created_at
       FROM client_emails WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`, [c.id]),
    db.query(
      `SELECT o.id, o.type, o.status, o.options->>'programmeId' AS programme_id, o.estimated_credits, o.error,
              o.created_at, o.ready_at,
              (SELECT COUNT(*)::int FROM deliverables d WHERE d.order_id = o.id) AS files
       FROM orders o WHERE o.client_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [c.id]),
    db.query(
      `SELECT id, offer_title, status, amount_ttc_cents, paid_at, created_at
       FROM montage_requests WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`, [c.id]),
    db.query(
      `SELECT id, video_title, platforms, status, scheduled_at, created_at
       FROM publications WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`, [c.id]),
  ]);
  const programmeTitle = (id) => (mapping.programmes[id] || {}).title || id;
  res.json({
    client: await fresh(c.id),
    emails: emails.rows,
    contents: contents.rows.map((o) => ({ ...o, programme: o.programme_id ? programmeTitle(o.programme_id) : null })),
    payments: montage.rows,
    publications: publications.rows,
    videos: videos.map((v) => ({
      id: v.id,
      active: v.active,
      title: v.title,
      programmeId: v.programme_id,
      programmeTitle: programmeTitle(v.programme_id),
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
      broadcastDate: access.isoDay(current.broadcast_date), logoKey: current.logo_key, sector: current.sector,
      marketingOptin: current.marketing_optin, marketingOptinSource: current.marketing_optin_source }[k] ?? ''
  ));
  if (!changed.length) return res.json({ client: await fresh(current.id) });
  const c = await clients.update(current.id, Object.fromEntries(changed.map((k) => [k, fields[k]])));
  const detail = { champs: changed };
  if (changed.includes('marketingOptin')) detail.marketing = fields.marketingOptin === true ? 'oui' : fields.marketingOptin === false ? 'non' : 'non renseigné';
  await audit.record(req, 'client_modifie', { targetType: 'client', targetId: c.id, detail });
  res.json({ client: await fresh(c.id) });
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
    res.json({ client: await fresh(c.id), redirectedTo: r.redirectedTo || null });
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
  res.json({ client: await fresh(c.id), link: r.link });
}));

router.post('/admin/clients/:id/access/revoke', requireTeam, wrap(async (req, res) => {
  const c = await access.revoke(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  await audit.record(req, 'acces_coupe', { targetType: 'client', targetId: c.id });
  res.json({ client: await fresh(c.id) });
}));

module.exports = router;
module.exports.publicClient = publicClient;
