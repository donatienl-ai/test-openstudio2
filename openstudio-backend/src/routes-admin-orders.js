'use strict';
/**
 * Back-office, rubrique « Commandes » : suivi de toutes les commandes.
 * - Créations automatiques (capsules, teasers, interviews sous-titrées) payées en crédits.
 * - Montages sur mesure payés par carte : paiement, facture, e-mail compta et avancement du montage
 *   (à faire → en cours → livré), tenu par l'équipe.
 * Accès : session de l'équipe (requireTeam).
 */
const express = require('express');
const db = require('./db');
const orders = require('./orders');
const storage = require('./storage');
const credits = require('./credits/service');
const audit = require('./admin/audit');
const tracking = require('./payments/tracking');
const invoicing = require('./invoicing/service');
const mapping = require('./opusclip.config');
const { requireTeam } = require('./admin/session');

const router = express.Router();
const json = express.json({ limit: '20kb' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID = /^[0-9a-f-]{36}$/i;

const RUNNING = ['validated', 'paid', 'submitting', 'processing', 'opus_done', 'postprocessing'];
const PRODUCTION = { todo: 'À faire', in_progress: 'En cours', delivered: 'Livré' };

function creationKind(o) {
  if (o.type === 'subtitles') return 'subtitles';
  if (o.type === 'capsules') return o.options && o.options.kind === 'teaser' ? 'teaser' : 'capsules';
  return o.type;
}

/** Liste unifiée : créations et montages, avec compteurs par état. */
router.get('/admin/commandes', requireTeam, wrap(async (req, res) => {
  const [cr, mo] = await Promise.all([
    db.query(
      `SELECT o.id, o.type, o.options, o.status, o.error, o.created_at, o.updated_at, o.credits_cost, o.credits_charged, o.client_id,
              c.company, c.name AS client_name,
              (SELECT COUNT(*)::int FROM deliverables d WHERE d.order_id = o.id AND d.purged = false) AS files
       FROM orders o LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.status <> 'draft'
       ORDER BY o.created_at DESC LIMIT 500`
    ),
    db.query(
      `SELECT m.id, m.offer_title, m.status, m.amount_ht_cents, m.amount_ttc_cents, m.paid_at, m.created_at, m.client_id,
              m.contact, m.brief, m.invoice_provider, m.invoice_status, m.invoice_number, m.accounting_notified_at,
              m.production_status, m.production_note, m.production_updated_at, c.company, c.name AS client_name
       FROM montage_requests m LEFT JOIN clients c ON c.id = m.client_id
       ORDER BY m.created_at DESC LIMIT 500`
    ),
  ]);
  const creations = cr.rows.map((o) => ({
    id: o.id, family: 'creation', kind: creationKind(o), status: o.status, error: o.error || null,
    createdAt: o.created_at, updatedAt: o.updated_at, client: { id: o.client_id, company: o.company, name: o.client_name },
    programme: (mapping.programmes[o.options && o.options.programmeId] || {}).title || (o.options && o.options.videoTitle) || null,
    duration: o.options && o.options.duration ? Number(o.options.duration) : null, format: (o.options && o.options.format) || null,
    credits: Number(o.credits_charged) || Number(o.credits_cost) || 0, refunded: Number(o.credits_cost) > 0 && !Number(o.credits_charged) && o.status === 'error',
    files: o.files,
  }));
  const montages = mo.rows.map((m) => ({
    id: m.id, family: 'montage', kind: 'montage', title: m.offer_title, status: m.status,
    createdAt: m.created_at, paidAt: m.paid_at, amountTtcCents: m.amount_ttc_cents, amountHtCents: m.amount_ht_cents,
    client: { id: m.client_id, company: m.company || (m.contact && m.contact.company), name: m.client_name || (m.contact && m.contact.name), email: m.contact && m.contact.email },
    programme: (m.brief && m.brief.programme) || null, deadline: (m.brief && m.brief.deadline) || null,
    invoice: { provider: m.invoice_provider, status: m.invoice_status, number: m.invoice_number },
    accountingNotified: Boolean(m.accounting_notified_at),
    production: m.status === 'paid' || m.status === 'to_quote' ? (m.production_status || 'todo') : null,
  }));
  const all = [...creations, ...montages].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const counts = {
    running: creations.filter((o) => RUNNING.includes(o.status)).length,
    errors: creations.filter((o) => o.status === 'error').length,
    montagesTodo: montages.filter((m) => m.production && m.production !== 'delivered').length,
    invoicesPending: montages.filter((m) => m.status === 'paid' && m.invoice.provider === 'pennylane' && m.invoice.status !== 'created').length,
  };
  res.json({ orders: all, counts, production: PRODUCTION });
}));

/** Détail d'une création : chronologie, fichiers livrés (liens valables 1 heure), client. */
router.get('/admin/commandes/creations/:id', requireTeam, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Commande introuvable' });
  const order = await orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  const { access_token, ...safe } = order; // eslint-disable-line no-unused-vars
  const files = await orders.listDeliverables(order.id);
  const deliverables = await Promise.all(files.map(async (d) => ({
    id: d.id, title: d.title, fileName: d.file_name, durationMs: d.duration_ms, sizeBytes: d.size_bytes, expiresAt: d.expires_at,
    url: await storage.presignDownload(d.storage_key, d.file_name, 'attachment', 3600).catch(() => null),
  })));
  const client = order.client_id ? (await db.query('SELECT id, name, company, email FROM clients WHERE id = $1', [order.client_id])).rows[0] : null;
  res.json({ order: { ...safe, kind: creationKind(order), programme: (mapping.programmes[order.options && order.options.programmeId] || {}).title || null }, client, events: await orders.listEvents(order.id), deliverables });
}));

/** Relance d'une création en erreur (les crédits rendus sont débités à nouveau). */
router.post('/admin/commandes/creations/:id/retry', requireTeam, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Commande introuvable' });
  const order = await orders.get(req.params.id);
  if (!order || order.status !== 'error') return res.status(409).json({ error: 'Seules les commandes en erreur peuvent être relancées.' });
  if (order.client_id && Number(order.credits_cost) > 0 && !Number(order.credits_charged)) {
    try {
      await credits.chargeOrder(order, { actor: 'équipe (relance)' });
    } catch (e) {
      if (e instanceof credits.CreditError) return res.status(409).json({ error: `Relance impossible : ${e.message} Ajoutez des crédits au client (fiche client) puis relancez.` });
      throw e;
    }
  }
  const next = order.opus_project_id || (order.options && order.options.mode === 'client_file') ? 'opus_done' : 'paid';
  await orders.setStatus(order.id, next, { error: null });
  await audit.record(req, 'commande_relancee', { targetType: 'order', targetId: order.id, detail: { erreur: order.error } });
  require('./worker').nudge();
  res.json({ ok: true, status: next });
}));

/** Détail d'un montage : demande, paiement (chronologie), facture, avancement. */
router.get('/admin/commandes/montages/:id', requireTeam, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Demande introuvable' });
  const { rows } = await db.query('SELECT * FROM montage_requests WHERE id = $1', [req.params.id]);
  const m = rows[0];
  if (!m) return res.status(404).json({ error: 'Demande introuvable' });
  const ev = await tracking.eventsFor([m.id]);
  const client = m.client_id ? (await db.query('SELECT id, name, company, email, billing FROM clients WHERE id = $1', [m.client_id])).rows[0] : null;
  res.json({
    montage: {
      id: m.id, title: m.offer_title, status: m.status, amountHtCents: m.amount_ht_cents, amountTtcCents: m.amount_ttc_cents,
      createdAt: m.created_at, paidAt: m.paid_at, contact: m.contact, brief: m.brief, stripePaymentIntent: m.stripe_payment_intent,
      lastPaymentError: m.last_payment_error, invoice: { provider: m.invoice_provider, status: m.invoice_status, number: m.invoice_number, error: m.invoice_error },
      accountingNotifiedAt: m.accounting_notified_at,
      production: m.status === 'paid' || m.status === 'to_quote' ? (m.production_status || 'todo') : null,
      productionNote: m.production_note || '', productionUpdatedAt: m.production_updated_at, productionBy: m.production_by || null,
    },
    client, events: ev[m.id] || [], production: PRODUCTION,
  });
}));

/** Avancement du montage par l'équipe : à faire → en cours → livré, avec une note interne. */
router.post('/admin/commandes/montages/:id/production', requireTeam, json, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Demande introuvable' });
  const status = String((req.body || {}).status || '');
  const note = String((req.body || {}).note == null ? '' : req.body.note).trim().slice(0, 2000);
  if (!PRODUCTION[status]) return res.status(400).json({ error: 'État inconnu.' });
  const who = (req.adminUser && (req.adminUser.name || req.adminUser.email)) || 'équipe';
  const { rows } = await db.query(
    `UPDATE montage_requests SET production_status = $2, production_note = $3, production_updated_at = now(), production_by = $4
     WHERE id = $1 AND status IN ('paid', 'to_quote') RETURNING id`,
    [req.params.id, status, note, who]
  );
  if (!rows[0]) return res.status(409).json({ error: 'Seuls les montages payés (ou sur devis) ont un suivi de production.' });
  await audit.record(req, 'montage_avancement', { targetType: 'montage', targetId: req.params.id, detail: { etat: PRODUCTION[status], note } });
  res.json({ ok: true, production: status });
}));

/** Nouvel essai de facture (Pennylane) pour un montage payé. */
router.post('/admin/commandes/montages/:id/invoice', requireTeam, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Demande introuvable' });
  const r = await invoicing.invoicePayment('montage', req.params.id);
  if (r.status === 'created') {
    await audit.record(req, 'facture_creee', { targetType: 'montage', targetId: req.params.id, detail: { numero: r.number } });
    return res.json(r);
  }
  const msg = { missing_address: 'Adresse de facturation manquante : renseignez-la sur la fiche du client (ou le client, dans Factures).', stripe: 'Pennylane n’est pas configuré : la facture est faite par Stripe.', skipped: 'Ce montage n’est pas payé.' }[r.status];
  res.status(409).json({ error: msg || `Pennylane : ${r.error || 'erreur'}` });
}));

/** Lien vers la facture Pennylane d'un montage (PDF, adresse valable 30 minutes). */
router.get('/admin/commandes/montages/:id/invoice', requireTeam, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Demande introuvable' });
  const { rows } = await db.query('SELECT * FROM montage_requests WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Demande introuvable' });
  const link = await invoicing.invoiceLink('montage', rows[0]).catch((e) => ({ error: `Pennylane : ${e.message}`, status: 502 }));
  if (!link) return res.status(409).json({ error: 'Facture Stripe : ouvrez-la depuis la fiche du client (Paiements).' });
  if (link.error) return res.status(link.status || 502).json({ error: link.error });
  res.json(link);
}));

module.exports = router;
