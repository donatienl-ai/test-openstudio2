'use strict';
/**
 * Stripe Checkout (appels HTTP directs, sans dépendance). La clé secrète reste sur le serveur.
 * - createCheckoutSession : page de paiement hébergée par Stripe (carte, 3-D Secure).
 * - verifyWebhook : vérification de l'en-tête Stripe-Signature (HMAC-SHA256, tolérance 5 min).
 */
const crypto = require('crypto');
const config = require('../config');

/** Encode un objet imbriqué au format attendu par l'API Stripe (a[b][0][c]=…). */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripeRequest(method, path, body, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripe.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? form(body).toString() : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Stripe : erreur ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * @param {{ requestId, title, description, amountTtcCents, email, successUrl, cancelUrl, metadata? }} p
 * @returns {Promise<{ id: string, url: string }>}
 */
async function createCheckoutSession(p) {
  const metadata = p.metadata || { montage_request_id: p.requestId };
  // Validité minimale imposée par Stripe (30 min) ; notre serveur ferme la page au bout de 15 min sans paiement
  const expiresAt = Math.floor(Date.now() / 1000) + 31 * 60;
  const s = await stripeRequest('POST', '/checkout/sessions', {
    mode: 'payment',
    expires_at: expiresAt,
    client_reference_id: p.requestId,
    customer_email: p.email,
    locale: 'fr',
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    metadata,
    payment_intent_data: { metadata, description: p.title },
    // Facture Stripe générée après le paiement (numérotée, PDF) : affichée dans le back-office.
    // Les mentions légales (raison sociale, SIRET, TVA) se règlent dans Stripe → Paramètres → Factures.
    // Avec Pennylane (PENNYLANE_API_KEY), la facture est faite dans Pennylane : pas de facture Stripe en double.
    ...(config.invoicing.provider === 'stripe' ? { invoice_creation: { enabled: true, invoice_data: { description: p.title, metadata } } } : {}),
    // Prix du catalogue Stripe s'il existe (recharges de crédits), sinon prix calculé pour ce paiement
    line_items: [p.priceId ? { quantity: 1, price: p.priceId } : {
      quantity: 1,
      price_data: { currency: 'eur', unit_amount: p.amountTtcCents, product_data: { name: p.title, description: p.description } },
    }],
  });
  return { id: s.id, url: s.url };
}

/** Vérifie la signature d'une notification Stripe ; renvoie l'événement ou null. */
function verifyWebhook(rawBody, header, secret = config.stripe.webhookSecret, toleranceSec = 300) {
  if (!secret || !header) return null;
  const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=').map((x) => x.trim())).filter((x) => x.length === 2));
  const t = Number(parts.t);
  const sigs = String(header).split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) return null;
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Facture d'un paiement Checkout : la facture Stripe si elle existe, sinon le reçu de paiement
 * (paiements faits avant l'activation des factures). null si rien n'est disponible.
 */
async function invoiceForSession(sessionId, opts) {
  const q = new URLSearchParams([['expand[]', 'invoice'], ['expand[]', 'payment_intent.latest_charge']]);
  const s = await stripeRequest('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}?${q}`, null, opts);
  const inv = s.invoice && typeof s.invoice === 'object' ? s.invoice : null;
  if (inv && (inv.hosted_invoice_url || inv.invoice_pdf)) {
    return { kind: 'facture', number: inv.number || null, url: inv.hosted_invoice_url || inv.invoice_pdf, pdf: inv.invoice_pdf || null };
  }
  const charge = s.payment_intent && s.payment_intent.latest_charge;
  if (charge && typeof charge === 'object' && charge.receipt_url) {
    return { kind: 'recu', number: charge.receipt_number || null, url: charge.receipt_url, pdf: null };
  }
  return null;
}

module.exports = { createCheckoutSession, verifyWebhook, form, invoiceForSession, stripeRequest };
