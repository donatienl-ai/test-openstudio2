'use strict';
/**
 * Crédits côté client : solde, recharges payées par carte (Stripe Checkout), factures des recharges.
 */
const express = require('express');
const config = require('./config');
const clients = require('./clients');
const credits = require('./credits/service');
const stripe = require('./montage/stripe');

const router = express.Router();
const json = express.json({ limit: '20kb' });
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    if (e instanceof credits.CreditError) return res.status(e.status).json({ error: e.message, code: e.code });
    return next(e);
  });
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euros = (c) => (c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function requireClient(req, res) {
  const client = await clients.fromRequest(req);
  if (!client) res.status(401).json({ error: 'Espace client non reconnu' });
  return client;
}

function publicPurchase(p) {
  return {
    id: p.id, packId: p.pack_id, label: p.pack_label, credits: Number(p.credits),
    amountHT: p.amount_ht_cents / 100, amountTTC: p.amount_ttc_cents / 100,
    status: p.status, paidAt: p.paid_at, createdAt: p.created_at, hasInvoice: Boolean(p.stripe_session_id && p.status === 'paid'),
  };
}

/** Solde, échéance, barème et packs de recharge (sans le décompte détaillé). */
router.get('/me/credits', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  // Le décompte détaillé reste réservé à l'équipe (fiche client du back-office)
  const { history, ...acc } = await credits.account(client.id, { historyLimit: 0 });
  const purchases = await credits.listPurchases(client.id);
  res.json({ ...acc, paymentMode: config.stripe.mock ? 'simulation' : 'stripe', purchases: purchases.filter((p) => p.status === 'paid').map(publicPurchase) });
}));

/** Achat d'un pack : renvoie l'adresse de la page de paiement. */
router.post('/me/credits/purchases', json, wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const r = await credits.createPurchase(client, (req.body || {}).packId, { returnOrigin: req.get('origin') });
  res.status(201).json(r);
}));

/** Statut d'une recharge au retour du paiement. */
router.get('/me/credits/purchases/:id', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const p = await credits.getPurchase(req.params.id);
  if (!p || p.client_id !== client.id) return res.status(404).json({ error: 'Recharge introuvable' });
  res.json({ purchase: publicPurchase(p), balance: Number(client.credit_balance) });
}));

/** Facture Stripe d'une recharge payée. */
router.get('/me/credits/purchases/:id/invoice', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const p = await credits.getPurchase(req.params.id);
  if (!p || p.client_id !== client.id || p.status !== 'paid') return res.status(404).json({ error: 'Facture introuvable' });
  if (p.invoice_provider === 'pennylane') {
    const link = await require('./invoicing/service').invoiceLink('recharge', p).catch(() => null);
    if (link && !link.error) return res.json(link);
    return res.status(404).json({ error: p.invoice_status === 'missing_address' ? 'Renseignez vos informations de facturation (Factures → Modifier) : la facture sera créée aussitôt.' : 'La facture n’est pas encore disponible, réessayez dans quelques minutes.' });
  }
  if (config.stripe.mock || !p.stripe_session_id || p.stripe_session_id.startsWith('mock_')) {
    return res.status(404).json({ error: 'Paiement de test : pas de facture Stripe.' });
  }
  const inv = await stripe.invoiceForSession(p.stripe_session_id).catch((e) => { console.error('[crédits] facture', e.message); return null; });
  if (!inv) return res.status(404).json({ error: 'La facture n’est pas encore disponible, réessayez dans quelques minutes.' });
  res.json(inv);
}));

/* ---------------------------------------------------- Page de paiement SIMULÉE (sans clé Stripe) */

router.get('/credits/mock-checkout/:id', wrap(async (req, res) => {
  if (!config.stripe.mock) return res.status(404).send('Introuvable');
  const p = await credits.getPurchase(req.params.id);
  if (!p || p.status !== 'awaiting_payment') return res.status(404).send('Recharge introuvable ou déjà réglée');
  const base = p.return_base || credits.returnBase();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paiement (simulation)</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F3EF;color:#1A1A2E;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border-radius:16px;padding:28px;max-width:420px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 4px}.n{color:#B4641A;font-size:13px;margin:0 0 20px}.l{display:flex;justify-content:space-between;gap:12px;margin:8px 0}.t{font-weight:700;font-size:18px;border-top:1px solid #E2E0D8;padding-top:12px}button,a{display:block;width:100%;box-sizing:border-box;text-align:center;border-radius:999px;padding:14px;font:inherit;font-weight:600;margin-top:12px;cursor:pointer}button{background:#3B3BF9;color:#fff;border:0}a{color:#1A1A2E;border:1px solid #C9C7BE;text-decoration:none}</style></head>
<body><main><h1>Recharge de crédits</h1><p class="n">Mode test : simulation, aucun paiement réel (aucune clé Stripe configurée).</p>
<div class="l"><span>${escHtml(p.pack_label)} · ${Number(p.credits).toLocaleString('fr-FR')} crédits</span><span>${euros(p.amount_ht_cents)} € HT</span></div>
<div class="l"><span>TVA</span><span>${euros(p.amount_ttc_cents - p.amount_ht_cents)} €</span></div>
<div class="l t"><span>Total</span><span>${euros(p.amount_ttc_cents)} € TTC</span></div>
<form method="post" action="${escHtml(`${config.publicBaseUrl}/api/credits/mock-checkout/${p.id}`)}"><button type="submit">Payer ${euros(p.amount_ttc_cents)} € (simulation)</button></form>
<a href="${escHtml(`${base}/?credits=cancelled&purchase=${p.id}`)}">Annuler et revenir</a></main></body></html>`);
}));

router.post('/credits/mock-checkout/:id', wrap(async (req, res) => {
  if (!config.stripe.mock) return res.status(404).send('Introuvable');
  const p = await credits.getPurchase(req.params.id);
  if (!p) return res.status(404).send('Recharge introuvable');
  await credits.markPurchasePaid(p.id, 'simulation');
  res.redirect(303, `${p.return_base || credits.returnBase()}/?credits=paid&purchase=${p.id}`);
}));

module.exports = router;
