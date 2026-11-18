'use strict';
/**
 * « Confier ma vidéo à un monteur » : prestations, demande + paiement Stripe, notification Stripe.
 */
const express = require('express');
const config = require('./config');
const clients = require('./clients');
const { isAdmin } = require('./auth');
const { OFFERS, ttcCents } = require('./montage/offers');
const montage = require('./montage/service');

const router = express.Router();
const json = express.json({ limit: '100kb' });
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    if (e instanceof montage.MontageError) return res.status(e.status).json({ error: e.message });
    return next(e);
  });
const euros = (cents) => (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).replace(/ /g, ' ');
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Prestations et prix (HT et TTC) affichés dans le formulaire. */
router.get('/montage/offers', (req, res) => {
  res.json({
    vatRate: config.stripe.vatRate,
    paymentMode: config.stripe.mock ? 'simulation' : 'stripe',
    offers: OFFERS.map((o) => ({ ...o, priceTTC: o.priceHT == null ? null : ttcCents(o.priceHT, config.stripe.vatRate) / 100 })),
  });
});

/** Enregistre la demande et renvoie l'adresse de la page de paiement. Espace client facultatif. */
router.post('/montage/requests', json, wrap(async (req, res) => {
  const client = await clients.fromRequest(req).catch(() => null);
  const r = await montage.createRequest(client, req.body, { returnOrigin: req.get('origin') });
  res.status(201).json({ id: r.id, status: r.status, checkoutUrl: r.checkoutUrl || null });
}));

/** Statut au retour du paiement (sans donnée personnelle). */
router.get('/montage/requests/:id', wrap(async (req, res) => {
  const s = await montage.publicStatus(req.params.id);
  if (!s) return res.status(404).json({ error: 'Demande introuvable' });
  res.json(s);
}));

/** Page de paiement SIMULÉE : seulement tant qu'aucune clé Stripe n'est configurée (tests). */
router.get('/montage/mock-checkout/:id', wrap(async (req, res) => {
  if (!config.stripe.mock) return res.status(404).send('Introuvable');
  const r = await montage.getRequest(req.params.id);
  if (!r || r.status !== 'awaiting_payment') return res.status(404).send('Demande introuvable ou déjà réglée');
  const base = r.return_base || montage.returnBase();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paiement (simulation)</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F3EF;color:#1A1A2E;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border-radius:16px;padding:28px;max-width:420px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 4px}.n{color:#B4641A;font-size:13px;margin:0 0 20px}.l{display:flex;justify-content:space-between;gap:12px;margin:8px 0}.t{font-weight:700;font-size:18px;border-top:1px solid #E2E0D8;padding-top:12px}button,a{display:block;width:100%;box-sizing:border-box;text-align:center;border-radius:999px;padding:14px;font:inherit;font-weight:600;margin-top:12px;cursor:pointer}button{background:#3B3BF9;color:#fff;border:0}a{color:#1A1A2E;border:1px solid #C9C7BE;text-decoration:none}</style></head>
<body><main><h1>Paiement</h1><p class="n">Mode test : simulation, aucun paiement réel (aucune clé Stripe configurée).</p>
<div class="l"><span>${escHtml(r.offer_title)}</span><span>${euros(r.amount_ht_cents)} € HT</span></div>
<div class="l"><span>TVA</span><span>${euros(r.amount_ttc_cents - r.amount_ht_cents)} €</span></div>
<div class="l t"><span>Total</span><span>${euros(r.amount_ttc_cents)} € TTC</span></div>
<form method="post" action="${escHtml(`${config.publicBaseUrl}/api/montage/mock-checkout/${r.id}`)}"><button type="submit">Payer ${euros(r.amount_ttc_cents)} € (simulation)</button></form>
<a href="${escHtml(`${base}/?montage=cancelled&request=${r.id}`)}">Annuler et revenir</a></main></body></html>`);
}));

router.post('/montage/mock-checkout/:id', wrap(async (req, res) => {
  if (!config.stripe.mock) return res.status(404).send('Introuvable');
  const r = await montage.getRequest(req.params.id);
  if (!r) return res.status(404).send('Demande introuvable');
  await montage.markPaid(r.id, 'simulation');
  res.redirect(303, `${r.return_base || montage.returnBase()}/?montage=paid&request=${r.id}`);
}));

/** Notifications Stripe (corps brut : signature Stripe-Signature vérifiée). */
router.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const r = await montage.handleStripeWebhook(req.body || Buffer.alloc(0), req.get('stripe-signature'));
  if (r.status !== 200) console.warn(`[webhook stripe] rejeté : ${r.reason}`);
  res.status(r.status).json({ received: r.status === 200 });
}));

/** Équipe : demandes reçues (session du back-office, ou ADMIN_TOKEN pendant la transition). */
router.get('/admin/montage-requests', wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'non autorisé' });
  res.json({ requests: await montage.listRequests() });
}));

module.exports = router;
