'use strict';
/**
 * Suivi des paiements par carte (montage sur mesure et recharges de crédits).
 *
 * - Chronologie de chaque paiement (table payment_events) : page de paiement ouverte, refus avec sa
 *   raison, erreur technique, payé, abandonné.
 * - Raisons de refus traduites en français et classées par origine : client, banque / Stripe,
 *   technique OpenMedias.
 * - Abandon : une page de paiement non réglée au bout de 15 minutes est fermée chez Stripe et le
 *   paiement passe « Abandonné ».
 */
const config = require('../config');
const db = require('../db');

const ABANDON_MINUTES = 15;
const TABLES = { montage: 'montage_requests', recharge: 'credit_purchases' };
const ORIGINS = { client: 'Côté client', banque: 'Banque / Stripe', openmedias: 'Technique OpenMedias' };

// Codes Stripe (decline_code ou code) → origine et explication en français
const REASONS = {
  insufficient_funds: ['client', 'Fonds insuffisants sur la carte'],
  expired_card: ['client', 'Carte expirée'],
  incorrect_cvc: ['client', 'Code de sécurité (CVC) incorrect'],
  invalid_cvc: ['client', 'Code de sécurité (CVC) incorrect'],
  incorrect_number: ['client', 'Numéro de carte incorrect'],
  invalid_number: ['client', 'Numéro de carte incorrect'],
  invalid_expiry_month: ['client', 'Date d’expiration incorrecte'],
  invalid_expiry_year: ['client', 'Date d’expiration incorrecte'],
  incorrect_zip: ['client', 'Code postal incorrect'],
  authentication_required: ['client', 'Validation 3D Secure non effectuée'],
  payment_intent_authentication_failure: ['client', 'Validation 3D Secure échouée ou refusée par le client'],
  card_declined: ['banque', 'Carte refusée par la banque (sans motif précisé)'],
  generic_decline: ['banque', 'Carte refusée par la banque (sans motif précisé)'],
  do_not_honor: ['banque', 'Carte refusée par la banque (sans motif précisé)'],
  call_issuer: ['banque', 'Carte refusée : le client doit contacter sa banque'],
  lost_card: ['banque', 'Carte déclarée perdue'],
  stolen_card: ['banque', 'Carte déclarée volée'],
  pickup_card: ['banque', 'Carte bloquée par la banque'],
  restricted_card: ['banque', 'Carte bloquée ou restreinte par la banque'],
  fraudulent: ['banque', 'Paiement bloqué (suspicion de fraude)'],
  merchant_blacklist: ['banque', 'Paiement bloqué par Stripe (règle anti-fraude)'],
  card_velocity_exceeded: ['banque', 'Plafond de la carte atteint'],
  withdrawal_count_limit_exceeded: ['banque', 'Plafond de la carte atteint'],
  card_not_supported: ['banque', 'Carte non acceptée pour ce type de paiement'],
  currency_not_supported: ['banque', 'Carte non acceptée pour un paiement en euros'],
  transaction_not_allowed: ['banque', 'Paiement en ligne non autorisé sur cette carte'],
  try_again_later: ['banque', 'Refus temporaire de la banque : réessayer plus tard'],
  processing_error: ['banque', 'Erreur de traitement chez la banque ou Stripe'],
  issuer_not_available: ['banque', 'Banque injoignable au moment du paiement'],
};

/** Explication d'un refus Stripe (last_payment_error). */
function explain(err) {
  const e = err || {};
  const hit = REASONS[e.decline_code] || REASONS[e.code];
  if (hit) return { origin: hit[0], message: hit[1], code: e.decline_code || e.code };
  if (e.type === 'api_error') return { origin: 'banque', message: 'Erreur technique chez Stripe', code: e.code || 'api_error' };
  return { origin: 'banque', message: e.message ? `Paiement refusé : ${e.message}` : 'Paiement refusé', code: e.decline_code || e.code || null };
}

async function record(kind, paymentId, event, { origin = null, message = null, detail = null } = {}) {
  try {
    await db.query(
      'INSERT INTO payment_events (kind, payment_id, event, origin, message, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [kind, paymentId, event, origin, message ? String(message).slice(0, 500) : null, detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    console.error('[paiements] journal', e.message);
  }
}

/** Refus de carte : raison enregistrée sur le paiement et dans sa chronologie. */
async function recordFailure(kind, paymentId, stripeError) {
  const x = explain(stripeError);
  await db.query(
    `UPDATE ${TABLES[kind]} SET last_payment_error = $2, failure_origin = $3, payment_failed_at = now(),
       payment_failures = payment_failures + 1, updated_at = now()
     WHERE id = $1 AND status <> 'paid'`,
    [paymentId, x.message, x.origin]
  );
  await record(kind, paymentId, 'refus', { origin: x.origin, message: x.message, detail: { code: x.code, stripe: (stripeError || {}).message || null } });
  return x;
}

/** Erreur de notre côté (Stripe injoignable, traitement interrompu…). */
async function recordTechnical(kind, paymentId, error, { fail = false } = {}) {
  const message = `Erreur technique OpenMedias : ${String((error && error.message) || error).slice(0, 300)}`;
  await db.query(
    `UPDATE ${TABLES[kind]} SET last_payment_error = $2, failure_origin = 'openmedias', payment_failed_at = now(),
       ${fail ? "status = 'error'," : ''} updated_at = now()
     WHERE id = $1 AND status <> 'paid'`,
    [paymentId, message]
  ).catch((e) => console.error('[paiements]', e.message));
  await record(kind, paymentId, 'erreur_technique', { origin: 'openmedias', message });
}

/** Passe un paiement non réglé en « Abandonné » (idempotent). */
async function markAbandoned(kind, paymentId, why) {
  const { rows } = await db.query(
    `UPDATE ${TABLES[kind]} SET status = 'abandoned', abandoned_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'awaiting_payment' RETURNING last_payment_error`,
    [paymentId]
  );
  if (!rows[0]) return false;
  const after = rows[0].last_payment_error ? ` (dernier refus : ${rows[0].last_payment_error})` : '';
  await record(kind, paymentId, 'abandonne', { message: `${why}${after}` });
  return true;
}

/**
 * Ferme les pages de paiement ouvertes depuis plus de 15 minutes sans paiement.
 * Stripe impose au moins 30 minutes de validité : la page est donc fermée par notre serveur.
 */
async function abandonStale({ stripe = require('../montage/stripe') } = {}) {
  let n = 0;
  for (const [kind, table] of Object.entries(TABLES)) {
    const { rows } = await db.query(
      `SELECT id, stripe_session_id FROM ${table}
       WHERE status = 'awaiting_payment' AND created_at < now() - make_interval(mins => $1) LIMIT 100`,
      [ABANDON_MINUTES]
    );
    for (const r of rows) {
      const sid = r.stripe_session_id;
      if (sid && !sid.startsWith('mock_') && !config.stripe.mock) {
        try {
          await stripe.stripeRequest('POST', `/checkout/sessions/${sid}/expire`, {});
        } catch (e) {
          // Déjà expirée : on clôt. Déjà payée : la notification Stripe passe le paiement « Payé ».
          const s = await stripe.stripeRequest('GET', `/checkout/sessions/${sid}`).catch(() => null);
          if (!s || s.status !== 'expired') continue;
        }
      }
      if (await markAbandoned(kind, r.id, `Paiement non finalisé dans les ${ABANDON_MINUTES} minutes : page de paiement fermée`)) n++;
    }
  }
  return n;
}

async function eventsFor(ids) {
  if (!ids.length) return {};
  const { rows } = await db.query(
    "SELECT payment_id, event, origin, message, created_at FROM payment_events WHERE payment_id::text = ANY(string_to_array($1, ',')) ORDER BY created_at, id",
    [ids.join(',')]
  );
  const out = {};
  for (const r of rows) (out[r.payment_id] = out[r.payment_id] || []).push({ event: r.event, origin: r.origin, message: r.message, at: r.created_at });
  return out;
}

module.exports = { ABANDON_MINUTES, ORIGINS, REASONS, explain, record, recordFailure, recordTechnical, markAbandoned, abandonStale, eventsFor };
