'use strict';
/**
 * Demandes « Confier ma vidéo à un monteur » : coordonnées + description, puis paiement Stripe.
 * Le prix vient toujours de src/montage/offers.js (jamais du navigateur).
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const { byId, ttcCents } = require('./offers');
const stripe = require('./stripe');

class MontageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const FORMATS = ['Vertical', 'Carré', 'Horizontal', 'Je ne sais pas encore'];
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** Contrôle et normalise le formulaire. */
function validate(body) {
  const b = body || {};
  const offer = byId(String(b.offerId || ''));
  if (!offer) throw new MontageError('Choisissez la prestation souhaitée.');
  const c = b.contact || {};
  const contact = { company: clean(c.company, 120), name: clean(c.name, 120), email: clean(c.email, 200).toLowerCase(), phone: clean(c.phone, 30) };
  if (!contact.company) throw new MontageError('Indiquez le nom de votre entreprise.');
  if (!contact.name) throw new MontageError('Indiquez vos nom et prénom.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact.email)) throw new MontageError('Indiquez une adresse e-mail valide.');
  if (contact.phone && !/^[+\d][\d ().-]{5,}$/.test(contact.phone)) throw new MontageError('Le numéro de téléphone semble incorrect.');
  const br = b.brief || {};
  const description = String(br.description || '').trim().slice(0, 4000);
  if (description.length < 10) throw new MontageError('Décrivez en quelques mots la vidéo souhaitée.');
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(br.deadline || '')) ? br.deadline : null;
  if (deadline && new Date(`${deadline}T23:59:59`) < new Date()) throw new MontageError('La date souhaitée est déjà passée.');
  const formats = Array.isArray(br.formats) ? br.formats.filter((f) => FORMATS.includes(f)) : [];
  return { offer, contact, brief: { description, programme: clean(br.programme, 200), formats, deadline } };
}

/** Origine du site où renvoyer le client après le paiement (seulement une origine autorisée). */
function returnBase(requested) {
  const origins = config.frontendOrigins;
  return origins.includes(requested) ? requested : origins[0] || config.publicBaseUrl;
}

/**
 * Crée la demande. Prestation à prix fixe : renvoie l'URL de paiement Stripe (ou de la page simulée).
 * Prix à définir : demande enregistrée, l'équipe recontacte le client.
 */
async function createRequest(client, body, { returnOrigin } = {}) {
  const { offer, contact, brief } = validate(body);
  const id = crypto.randomUUID();
  const ht = offer.priceHT == null ? null : Math.round(offer.priceHT * 100);
  const ttc = offer.priceHT == null ? null : ttcCents(offer.priceHT, config.stripe.vatRate);
  await db.query(
    `INSERT INTO montage_requests (id, client_id, offer_id, offer_title, amount_ht_cents, amount_ttc_cents, contact, brief, status, return_base)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, client ? client.id : null, offer.id, offer.title, ht, ttc, JSON.stringify(contact), JSON.stringify(brief), ttc == null ? 'to_quote' : 'awaiting_payment', returnBase(returnOrigin)]
  );
  if (ttc == null) {
    console.log(`[montage] nouvelle demande ${id.slice(0, 8)} (${offer.title}, prix à définir) — ${contact.company}`);
    return { id, status: 'to_quote' };
  }
  const base = returnBase(returnOrigin);
  const successUrl = `${base}/?montage=paid&request=${id}`;
  const cancelUrl = `${base}/?montage=cancelled&request=${id}`;
  let session;
  if (config.stripe.mock) {
    session = { id: `mock_${id}`, url: `${config.publicBaseUrl}/api/montage/mock-checkout/${id}` };
  } else {
    try {
      session = await stripe.createCheckoutSession({
        requestId: id, title: offer.title, description: brief.description.slice(0, 300),
        amountTtcCents: ttc, email: contact.email, successUrl, cancelUrl,
      });
    } catch (e) {
      console.error('[montage] Stripe :', e.message);
      await db.query("UPDATE montage_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
      throw new MontageError('Le paiement n’a pas pu être préparé. Réessayez dans quelques minutes.', 502);
    }
  }
  await db.query('UPDATE montage_requests SET stripe_session_id = $2, updated_at = now() WHERE id = $1', [id, session.id]);
  return { id, status: 'awaiting_payment', checkoutUrl: session.url, successUrl, cancelUrl };
}

/** Paiement confirmé (idempotent : sans effet si déjà payée). */
async function markPaid(requestId, paymentIntent = null) {
  const { rows } = await db.query(
    `UPDATE montage_requests SET status = 'paid', paid_at = now(), stripe_payment_intent = COALESCE($2, stripe_payment_intent), updated_at = now()
     WHERE id = $1 AND status = 'awaiting_payment' RETURNING *`,
    [requestId, paymentIntent]
  );
  if (rows[0]) {
    // TODO (back-office P1) : e-mail à l'équipe communication et facture automatique (Pennylane).
    console.log(`[montage] demande ${requestId.slice(0, 8)} payée : ${rows[0].offer_title} — ${rows[0].contact.company} <${rows[0].contact.email}>`);
  }
  return rows[0] || null;
}

/** Notification Stripe : signature vérifiée, chaque événement traité une seule fois. */
async function handleStripeWebhook(rawBody, signatureHeader) {
  const event = stripe.verifyWebhook(rawBody, signatureHeader);
  if (!event) return { status: 400, reason: 'signature invalide' };
  const r = await db.query('INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [String(event.id)]);
  if (!r.rowCount) return { status: 200, duplicate: true };
  const s = event.data && event.data.object;
  const requestId = s && ((s.metadata && s.metadata.montage_request_id) || s.client_reference_id);
  if (!requestId) return { status: 200, ignored: true };
  if (event.type === 'checkout.session.completed' && s.payment_status === 'paid') await markPaid(requestId, s.payment_intent || null);
  if (event.type === 'checkout.session.async_payment_succeeded') await markPaid(requestId, s.payment_intent || null);
  if (event.type === 'checkout.session.expired') {
    await db.query("UPDATE montage_requests SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'awaiting_payment'", [requestId]);
  }
  return { status: 200 };
}

/** Statut affiché au retour du paiement (aucune donnée personnelle). */
async function publicStatus(requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(requestId))) return null;
  const { rows } = await db.query('SELECT id, status, offer_title FROM montage_requests WHERE id = $1', [requestId]);
  return rows[0] ? { id: rows[0].id, status: rows[0].status, offerTitle: rows[0].offer_title } : null;
}

async function getRequest(requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(requestId))) return null;
  const { rows } = await db.query('SELECT * FROM montage_requests WHERE id = $1', [requestId]);
  return rows[0] || null;
}

async function listRequests(limit = 200) {
  const { rows } = await db.query('SELECT * FROM montage_requests ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows;
}

module.exports = { MontageError, FORMATS, returnBase, validate, createRequest, markPaid, handleStripeWebhook, publicStatus, getRequest, listRequests };
