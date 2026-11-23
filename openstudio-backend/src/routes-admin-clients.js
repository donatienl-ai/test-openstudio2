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
const credits = require('./credits/service');
const tracking = require('./payments/tracking');
const importer = require('./admin/client-import');
const { requireTeam } = require('./admin/session');
const mapping = require('./opusclip.config');
const stripe = require('./montage/stripe');
const storage = require('./storage');
const branding = require('./media/branding');
const crypto = require('crypto');
const path = require('path');

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
  };
  // Le consentement marketing est donné par le client lui-même, dans son espace : pas modifiable ici.
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
  await access.ensureCode(c.id);
  await credits.grantIncluded(c.id, 'création du compte');
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
    const c = await clients.create(r.client);
    await access.ensureCode(c.id);
    await credits.grantIncluded(c.id, 'création du compte');
    created.push(c);
  }
  await audit.record(req, 'clients_importes', { detail: { crees: created.length, ignores: result.rejected } });
  res.status(201).json({ created: created.length, rejected: result.rejected });
}));

/* ------------------------------------------------------------------ Fiche client */

async function withEvents(payments) {
  const ev = await tracking.eventsFor(payments.map((p) => p.id));
  return payments.map((p) => ({ ...p, events: ev[p.id] || [] }));
}

// Paiements du client : montages sur mesure et recharges de crédits
const PAY_ALL = `(SELECT id, 'montage' AS kind, offer_title, status, amount_ttc_cents, paid_at, created_at, stripe_session_id,
           last_payment_error, payment_failed_at, payment_failures, failure_origin, abandoned_at, client_id, contact->>'company' AS company
    FROM montage_requests
    UNION ALL
    SELECT id, 'recharge', pack_label || ' (' || credits || ' crédits)', status, amount_ttc_cents, paid_at, created_at, stripe_session_id,
           last_payment_error, payment_failed_at, payment_failures, failure_origin, abandoned_at, client_id, NULL
    FROM credit_purchases)`;

router.get('/admin/clients/:id', requireTeam, wrap(async (req, res) => {
  let c = await clients.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  if (!access.readableCode(c)) { await access.ensureCode(c.id); c = await clients.get(c.id); }
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
      `SELECT id, kind, offer_title, status, amount_ttc_cents, paid_at, created_at, stripe_session_id IS NOT NULL AS has_invoice,
              last_payment_error, payment_failed_at, payment_failures, failure_origin, abandoned_at
       FROM ${PAY_ALL} p WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`, [c.id]),
    db.query(
      `SELECT id, video_title, platforms, status, scheduled_at, created_at
       FROM publications WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`, [c.id]),
  ]);
  const programmeTitle = (id) => (mapping.programmes[id] || {}).title || id;
  res.json({
    client: await fresh(c.id),
    accessCode: access.readableCode(c),
    logos: await logosView(c),
    emails: emails.rows,
    contents: contents.rows.map((o) => ({ ...o, programme: o.programme_id ? programmeTitle(o.programme_id) : null })),
    payments: await withEvents(montage.rows),
    credits: await credits.account(c.id, { historyLimit: 200 }),
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
      broadcastDate: access.isoDay(current.broadcast_date), logoKey: current.logo_key, sector: current.sector }[k] ?? ''
  ));
  if (!changed.length) return res.json({ client: await fresh(current.id) });
  const c = await clients.update(current.id, Object.fromEntries(changed.map((k) => [k, fields[k]])));
  await audit.record(req, 'client_modifie', { targetType: 'client', targetId: c.id, detail: { champs: changed } });
  res.json({ client: await fresh(c.id) });
}));

/* ------------------------------------------------------------------ Tableau de bord (accueil) */

router.get('/admin/dashboard', requireTeam, wrap(async (req, res) => {
  const today = "(now() AT TIME ZONE 'Europe/Paris')::date";
  const [pay, failures, orphans, acc, series, mails] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'paid' AND paid_at > now() - interval '30 days')::int AS paid,
              COALESCE(SUM(amount_ttc_cents) FILTER (WHERE status = 'paid' AND paid_at > now() - interval '30 days'), 0)::int AS paid_cents,
              COUNT(*) FILTER (WHERE status = 'awaiting_payment')::int AS awaiting,
              COUNT(*) FILTER (WHERE status = 'to_quote')::int AS to_quote,
              COUNT(*) FILTER (WHERE status <> 'paid' AND payment_failed_at > now() - interval '30 days')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'abandoned' AND abandoned_at > now() - interval '30 days')::int AS abandoned,
              COUNT(*) FILTER (WHERE kind = 'recharge' AND status = 'paid' AND paid_at > now() - interval '30 days')::int AS recharges
       FROM ${PAY_ALL} p`),
    db.query(
      // À relancer : montages sur mesure non payés (refus ou abandon) des 7 derniers jours ; les recharges ne sont pas relancées
      `SELECT m.id, 'montage' AS kind, m.offer_title, m.last_payment_error, m.failure_origin, m.payment_failed_at, m.payment_failures, m.status,
              m.abandoned_at, GREATEST(m.payment_failed_at, m.abandoned_at) AS at,
              m.contact->>'company' AS company, m.contact->>'name' AS contact_name, m.contact->>'email' AS contact_email, m.contact->>'phone' AS contact_phone,
              c.id AS client_id, c.name AS client_name
       FROM montage_requests m LEFT JOIN clients c ON c.id = m.client_id
       WHERE m.status IN ('awaiting_payment', 'abandoned', 'error')
         AND GREATEST(m.payment_failed_at, m.abandoned_at) > now() - interval '7 days'
       ORDER BY at DESC LIMIT 30`),
    db.query("SELECT COUNT(*)::int AS n FROM montage_requests WHERE client_id IS NULL AND status = 'paid'"),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE (access_token_hash IS NOT NULL OR access_code_hash IS NOT NULL) AND access_revoked_at IS NULL)::int AS active,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE first_seen_at IS NOT NULL)::int AS ever_connected
       FROM clients`),
    db.query(
      `SELECT d.day::date AS day,
              COUNT(v.client_id)::int AS connected,
              COUNT(v.client_id) FILTER (WHERE EXISTS (
                SELECT 1 FROM client_visits p WHERE p.client_id = v.client_id AND p.day < v.day))::int AS returning
       FROM generate_series(${today} - 6, ${today}, interval '1 day') AS d(day)
       LEFT JOIN client_visits v ON v.day = d.day::date
       GROUP BY d.day ORDER BY d.day`),
    db.query("SELECT COUNT(*)::int AS n FROM client_emails WHERE status = 'echec' AND created_at > now() - interval '7 days'"),
  ]);
  const days = series.rows.map((r) => ({ day: access.isoDay(r.day), connected: r.connected, returning: r.returning }));
  const todayRow = days[days.length - 1] || { connected: 0, returning: 0 };
  res.json({
    payments: { ...pay.rows[0], unattached: orphans.rows[0].n, failures: failures.rows },
    accounts: {
      active: acc.rows[0].active,
      total: acc.rows[0].total,
      everConnected: acc.rows[0].ever_connected,
      connectedToday: todayRow.connected,
      returningToday: todayRow.returning,
      days,
    },
    accessEmailFailures7d: mails.rows[0].n,
  });
}));

/* ------------------------------------------------------------------ Factures */

/** Facture (ou reçu) d'un paiement du client, à ouvrir depuis la fiche. */
router.get('/admin/clients/:id/payments/:paymentId/invoice', requireTeam, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT stripe_session_id, status FROM ${PAY_ALL} p WHERE id::text = $1 AND client_id::text = $2`,
    [req.params.paymentId, req.params.id]
  );
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Paiement introuvable.' });
  if (p.status !== 'paid' || !p.stripe_session_id) return res.status(409).json({ error: 'Ce paiement n’a pas de facture : il n’a pas été réglé en ligne.' });
  if (!config.stripe || !config.stripe.secretKey) return res.status(503).json({ error: 'Stripe n’est pas configuré sur le serveur.' });
  let inv;
  try {
    inv = await stripe.invoiceForSession(p.stripe_session_id);
  } catch (e) {
    return res.status(502).json({ error: `Stripe : ${e.message}` });
  }
  if (!inv) return res.status(404).json({ error: 'Stripe n’a ni facture ni reçu pour ce paiement.' });
  res.json(inv);
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

router.post('/admin/clients/:id/access/restore', requireTeam, wrap(async (req, res) => {
  const c = await access.restore(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  await audit.record(req, 'acces_retabli', { targetType: 'client', targetId: c.id });
  res.json({ client: await fresh(c.id) });
}));

router.post('/admin/clients/:id/access/revoke', requireTeam, wrap(async (req, res) => {
  const c = await access.revoke(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  await audit.record(req, 'acces_coupe', { targetType: 'client', targetId: c.id });
  res.json({ client: await fresh(c.id) });
}));

/* ------------------------------------------------------------------ Logos des vidéos */

const LOGO_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const LOGO_COLUMNS = { company: ['logo_key', 'logo_position'], media: ['media_logo_key', 'media_logo_position'] };
const preview = (key) => (key ? storage.presignDownload(key, path.basename(key), 'inline', 3600).catch(() => null) : null);

/** Logos du client (aperçus signés) + logo OpenMedias de l'écran de fin. */
async function logosView(c) {
  const set = await branding.clientLogos(c);
  const om = await branding.get();
  return {
    company: { url: await preview(set.company.key), position: set.company.position },
    media: {
      url: await preview(set.media.key), position: set.media.position, source: set.media.source,
      programmeId: set.media.programmeId, programmeTitle: set.media.programmeTitle,
    },
    openmedias: { url: await preview(om.openmediasLogoKey), custom: Boolean(om.openmediasLogoKey) },
    positions: branding.POSITIONS,
    bumpers: mapping.bumpers ? { kinds: mapping.bumpers.kinds, introSec: mapping.bumpers.introSec, outroSec: mapping.bumpers.outroSec } : null,
  };
}

function logoUpload(prefix, { fileName, contentType }) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!LOGO_EXTS.includes(ext)) return { error: 'Format accepté : PNG (de préférence avec fond transparent), JPG ou WebP.' };
  const ct = String(contentType || '');
  if (!/^image\/(png|jpeg|webp)$/.test(ct)) return { error: 'Ce fichier n’est pas une image PNG, JPG ou WebP.' };
  const key = `${prefix}/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  return { key, ct };
}

/** Adresse d'envoi direct d'un logo (navigateur → stockage). */
router.post('/admin/clients/:id/logos/upload', requireTeam, json, wrap(async (req, res) => {
  const c = await clients.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  const kind = (req.body || {}).kind;
  if (!LOGO_COLUMNS[kind]) return res.status(400).json({ error: 'Logo inconnu' });
  const r = logoUpload(`clients/${c.id}/logos/${kind}`, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ key: r.key, uploadUrl: await storage.presignUpload(r.key, r.ct, 3600), method: 'PUT', headers: { 'Content-Type': r.ct } });
}));

/** Enregistre un logo déposé, le retire (key: null) ou change sa position. */
router.post('/admin/clients/:id/logos', requireTeam, json, wrap(async (req, res) => {
  const c = await clients.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  const { kind, key, position } = req.body || {};
  const cols = LOGO_COLUMNS[kind];
  if (!cols) return res.status(400).json({ error: 'Logo inconnu' });
  const sets = []; const params = [c.id]; const detail = { logo: kind === 'company' ? 'entreprise' : 'média' };
  if (key !== undefined) {
    if (key !== null && !String(key).startsWith(`clients/${c.id}/logos/${kind}/`)) return res.status(400).json({ error: 'Fichier de logo invalide' });
    if (key && !((await storage.head(key).catch(() => null)) || {}).exists) return res.status(400).json({ error: 'Le logo n’a pas été reçu : recommencez l’envoi.' });
    params.push(key); sets.push(`${cols[0]} = $${params.length}`); detail.action = key ? 'remplacé' : 'retiré';
  }
  if (position !== undefined) {
    if (!branding.POSITIONS.includes(position)) return res.status(400).json({ error: 'Position inconnue' });
    params.push(position); sets.push(`${cols[1]} = $${params.length}`); detail.position = position;
  }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  await db.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $1`, params);
  await audit.record(req, 'logo_modifie', { targetType: 'client', targetId: c.id, detail });
  res.json({ logos: await logosView(await clients.get(c.id)) });
}));

/** Logos des émissions (communs à tous les clients de l'émission). */
router.get('/admin/programme-logos', requireTeam, wrap(async (req, res) => {
  const progs = await branding.programmeLogos();
  res.json({ programmes: await Promise.all(Object.values(progs).map(async (p) => ({ id: p.id, title: p.title, url: await preview(p.key), uploaded: p.uploaded }))) });
}));

router.post('/admin/programme-logos/upload', requireTeam, json, wrap(async (req, res) => {
  const id = (req.body || {}).programmeId;
  if (!mapping.programmes[id]) return res.status(400).json({ error: 'Émission inconnue' });
  const r = logoUpload(`branding/emissions/${id}`, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ key: r.key, uploadUrl: await storage.presignUpload(r.key, r.ct, 3600), method: 'PUT', headers: { 'Content-Type': r.ct } });
}));

router.post('/admin/programme-logos', requireTeam, json, wrap(async (req, res) => {
  const { programmeId: id, key = null } = req.body || {};
  if (!mapping.programmes[id]) return res.status(400).json({ error: 'Émission inconnue' });
  if (key !== null && !String(key).startsWith(`branding/emissions/${id}/`)) return res.status(400).json({ error: 'Fichier de logo invalide' });
  if (key && !((await storage.head(key).catch(() => null)) || {}).exists) return res.status(400).json({ error: 'Le logo n’a pas été reçu : recommencez l’envoi.' });
  await branding.setProgrammeLogo(id, key, req.adminUser ? req.adminUser.name : null);
  await audit.record(req, 'logo_emission_modifie', { detail: { emission: mapping.programmes[id].title, action: key ? 'remplacé' : 'retiré' } });
  res.json({ ok: true });
}));

/** Logo OpenMedias de l'écran de fin (commun à tous les clients). */
router.post('/admin/branding/openmedias-logo/upload', requireTeam, json, wrap(async (req, res) => {
  const r = logoUpload('branding/openmedias', req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ key: r.key, uploadUrl: await storage.presignUpload(r.key, r.ct, 3600), method: 'PUT', headers: { 'Content-Type': r.ct } });
}));

router.post('/admin/branding/openmedias-logo', requireTeam, json, wrap(async (req, res) => {
  const key = (req.body || {}).key ?? null;
  if (key !== null && !String(key).startsWith('branding/openmedias/')) return res.status(400).json({ error: 'Fichier de logo invalide' });
  if (key && !((await storage.head(key).catch(() => null)) || {}).exists) return res.status(400).json({ error: 'Le logo n’a pas été reçu : recommencez l’envoi.' });
  await branding.setOpenmediasLogo(key, req.adminUser ? req.adminUser.name : null);
  await audit.record(req, 'logo_openmedias_modifie', { detail: { action: key ? 'remplacé' : 'logo par défaut' } });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ Crédits */

router.post('/admin/clients/:id/credits/adjust', requireTeam, json, wrap(async (req, res) => {
  const c = await clients.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  const { credits: delta, reason } = req.body || {};
  let row;
  try {
    row = await credits.adjust(c.id, Number(delta), reason, req.adminUser ? req.adminUser.name : 'équipe');
  } catch (e) {
    if (e instanceof credits.CreditError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  await audit.record(req, 'credits_ajustes', { targetType: 'client', targetId: c.id, detail: { credits: Number(delta), motif: row.label, solde: row.balance_after } });
  res.json({ credits: await credits.account(c.id, { historyLimit: 200 }) });
}));

router.get('/admin/credit-settings', requireTeam, wrap(async (req, res) => {
  res.json({ settings: await credits.settings.get({ fresh: true }), defaults: credits.settings.DEFAULTS, vatRate: config.stripe.vatRate });
}));

// Tarifs : modifiables par toute l'équipe ; les recharges sont reportées dans le catalogue Stripe
router.post('/admin/credit-settings', requireTeam, json, wrap(async (req, res) => {
  const before = await credits.settings.get({ fresh: true });
  const r = await credits.settings.save(req.body || {}, req.adminUser ? req.adminUser.name : null);
  if (r.error) return res.status(400).json({ error: r.error });
  const stripeSync = await require('./credits/stripe-catalog').sync(r.value.packs);
  await audit.record(req, 'bareme_credits_modifie', { detail: { avant: before, apres: r.value, stripe: stripeSync.error ? `échec : ${stripeSync.error}` : stripeSync.changes } });
  res.json({ settings: r.value, stripe: stripeSync });
}));

/** Remet le catalogue Stripe en accord avec les tarifs (bouton « Synchroniser avec Stripe »). */
router.post('/admin/credit-settings/stripe-sync', requireTeam, wrap(async (req, res) => {
  const s = await credits.settings.get({ fresh: true });
  const r = await require('./credits/stripe-catalog').sync(s.packs);
  await audit.record(req, 'tarifs_stripe_synchronises', { detail: { stripe: r.error ? `échec : ${r.error}` : r.changes } });
  res.json({ stripe: r });
}));

module.exports = router;
module.exports.publicClient = publicClient;
