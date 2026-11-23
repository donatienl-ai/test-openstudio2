'use strict';
/**
 * Crédits des clients.
 *
 * - Le solde (clients.credit_balance) ne change qu'avec une ligne du registre client_credit_ledger,
 *   écrite dans la même requête : impossible de passer sous zéro, même avec deux commandes simultanées.
 * - Validité : une seule date pour tout le solde. Par défaut, 30 jours après la (première) diffusion ;
 *   chaque recharge payée relance la validité de tout le solde pour 30 jours à partir du paiement.
 *   À l'échéance, le solde restant est retiré (ligne « expiration »).
 * - Une commande est débitée au lancement ; si la génération échoue, les crédits sont remboursés.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const mailer = require('../mailer');
const settings = require('./settings');
const tracking = require('../payments/tracking');

class CreditError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const fmt = (n) => Number(n).toLocaleString('fr-FR').replace(/ /g, ' ');

/* ------------------------------------------------------------------ Coût d'une commande */

/** Tranches de 5 minutes entamées (au moins une). Durée inconnue : 10 minutes, un passage classique. */
function tranchesOf(durationSec) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return { tranches: 2, known: false };
  return { tranches: Math.max(1, Math.ceil(d / 300)), known: true };
}

/**
 * Coût en crédits d'une commande (options normalisées) ; null si le type ne se paie pas en crédits.
 * @returns {{ credits: number, label: string } | null}
 */
function costOf(type, options, { prices, durationSec = null }) {
  const o = options || {};
  if (type === 'capsules') {
    if (o.kind === 'teaser') return { credits: prices.teaser, label: `Teaser ${o.duration || 15} s${o.format ? ` · ${o.format}` : ''}` };
    return { credits: prices.capsules, label: `Projet de capsules ${o.duration ? `${o.duration} s` : ''}${o.format ? ` · ${o.format}` : ''}`.trim() };
  }
  if (type === 'subtitles') {
    const { tranches, known } = tranchesOf(durationSec ?? o.sourceDurationSec);
    const translated = o.subtitleLanguage && o.spokenLanguage && o.subtitleLanguage !== o.spokenLanguage;
    const credits = tranches * prices.subtitlesPer5Min + (translated ? tranches * prices.translationPer5Min : 0);
    const sec = Math.round(Number(durationSec ?? o.sourceDurationSec));
    const minutes = known ? `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ''}` : 'durée estimée 10 min';
    return { credits, label: `Interview sous-titrée${translated ? ` et traduite (${o.subtitleLanguage})` : ''} · ${minutes}, ${tranches} tranche${tranches > 1 ? 's' : ''} de 5 min` };
  }
  return null;
}

/* ------------------------------------------------------------------ Validité */

/**
 * Date d'échéance des crédits : celle fixée par la dernière recharge, sinon diffusion + validité
 * (fin de journée, heure de Paris). null tant qu'aucune date de diffusion n'est connue.
 */
const EXPIRY_SQL = (validityParam) => `COALESCE(c.credits_expire_at, (
    (COALESCE(
       (SELECT MIN(COALESCE(v.broadcast_date, c.broadcast_date)) FROM client_videos v WHERE v.client_id = c.id AND v.active = true),
       c.broadcast_date
     ) + ${validityParam}::int)::timestamp AT TIME ZONE 'Europe/Paris'))`;

async function expiryOf(clientId) {
  const s = await settings.get();
  const { rows } = await db.query(`SELECT ${EXPIRY_SQL('$2')} AS expires_at FROM clients c WHERE c.id = $1`, [clientId, s.validityDays]);
  return rows[0] ? rows[0].expires_at : null;
}

/* ------------------------------------------------------------------ Mouvements */

/**
 * Ajoute (delta > 0) ou retire (delta < 0) des crédits, avec sa ligne de registre.
 * Renvoie la ligne, ou null si le solde ne suffit pas.
 */
async function move(clientId, delta, kind, { label = null, orderId = null, purchaseId = null, actor = null } = {}) {
  const { rows } = await db.query(
    `WITH u AS (
       UPDATE clients SET credit_balance = credit_balance + $2::int
       WHERE id = $1 AND credit_balance + $2::int >= 0
       RETURNING credit_balance
     )
     INSERT INTO client_credit_ledger (client_id, kind, credits, balance_after, label, order_id, purchase_id, actor)
     SELECT $1, $3, $2::int, u.credit_balance, $4, $5, $6, $7 FROM u
     RETURNING *`,
    [clientId, delta, kind, label, orderId, purchaseId, actor]
  );
  const r = rows[0];
  return r ? { ...r, credits: Number(r.credits), balance_after: Number(r.balance_after) } : null;
}

/** Crédits offerts à la création du compte (une seule fois par client). */
async function grantIncluded(clientId, actor = 'système') {
  const s = await settings.get();
  if (!s.included) return null;
  try {
    return await move(clientId, s.included, 'inclus', { label: 'Crédits offerts à l’ouverture du compte', actor });
  } catch (e) {
    if (/client_credit_ledger_inclus|duplicate key/i.test(e.message)) return null; // déjà attribués
    throw e;
  }
}

/** Attribue les crédits offerts aux comptes qui ne les ont pas encore (démarrage du serveur). */
async function grantIncludedToAll() {
  const { rows } = await db.query(
    `SELECT id FROM clients c WHERE NOT EXISTS (SELECT 1 FROM client_credit_ledger l WHERE l.client_id = c.id AND l.kind = 'inclus') LIMIT 1000`
  );
  let n = 0;
  for (const r of rows) if (await grantIncluded(r.id)) n++;
  return n;
}

/** Retire le solde d'un client dont la validité est passée. */
async function expireIfDue(clientId) {
  const s = await settings.get();
  const { rows } = await db.query(
    `SELECT c.credit_balance, ${EXPIRY_SQL('$2')} AS expires_at FROM clients c WHERE c.id = $1`,
    [clientId, s.validityDays]
  );
  const c = rows[0];
  if (!c || !c.credit_balance || !c.expires_at || new Date(c.expires_at) > new Date()) return null;
  return move(clientId, -Number(c.credit_balance), 'expiration', {
    label: `Crédits arrivés à échéance le ${new Date(c.expires_at).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}`,
  });
}

/** Passe en revue tous les soldes arrivés à échéance (tâche horaire). */
async function expireAll() {
  const s = await settings.get();
  const { rows } = await db.query(
    `SELECT c.id FROM clients c WHERE c.credit_balance > 0 AND ${EXPIRY_SQL('$1')} <= now() LIMIT 500`,
    [s.validityDays]
  );
  let n = 0;
  for (const r of rows) if (await expireIfDue(r.id)) n++;
  return n;
}

/** Ajustement manuel par l'équipe (geste commercial, correction), toujours avec un motif. */
async function adjust(clientId, delta, reason, actor) {
  const n = Number(delta);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) throw new CreditError('Indiquez un nombre entier de crédits, positif pour ajouter, négatif pour retirer.');
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (why.length < 3) throw new CreditError('Indiquez le motif de l’ajustement.');
  await expireIfDue(clientId);
  if (n > 0) {
    // Des crédits ajoutés à un solde échu ne doivent pas disparaître aussitôt : nouvelle validité
    const s = await settings.get();
    const exp = await expiryOf(clientId);
    if (exp && new Date(exp) <= new Date()) {
      await db.query(`UPDATE clients SET credits_expire_at = now() + make_interval(days => $2) WHERE id = $1`, [clientId, s.validityDays]);
    }
  }
  const row = await move(clientId, n, 'ajustement', { label: why, actor });
  if (!row) throw new CreditError('Le client n’a pas assez de crédits pour en retirer autant.', 409);
  return row;
}

/* ------------------------------------------------------------------ Commandes */

/** Débite une commande validée (idempotent). Solde insuffisant : CreditError 402. */
async function chargeOrder(order, { actor = null } = {}) {
  const cost = Number(order.credits_cost);
  if (!order.client_id || !Number.isInteger(cost) || cost <= 0) return { charged: 0 };
  await expireIfDue(order.client_id);
  const claim = await db.query(
    'UPDATE orders SET credits_charged = $2 WHERE id = $1 AND credits_charged = 0 RETURNING id',
    [order.id, cost]
  );
  if (!claim.rowCount) return { charged: 0, already: true };
  const row = await move(order.client_id, -cost, 'debit', { label: order.credits_label || labelForOrder(order), orderId: order.id, actor });
  if (!row) {
    await db.query('UPDATE orders SET credits_charged = 0 WHERE id = $1', [order.id]);
    const { rows } = await db.query('SELECT credit_balance FROM clients WHERE id = $1', [order.client_id]);
    const balance = rows[0] ? Number(rows[0].credit_balance) : 0;
    throw new CreditError(
      `Il vous manque ${fmt(cost - balance)} crédits pour cette création (${fmt(cost)} nécessaires, ${fmt(balance)} disponibles).`,
      402, { code: 'credits_insuffisants', needed: cost, balance }
    );
  }
  return { charged: cost, balance: row.balance_after };
}

function labelForOrder(order) {
  const c = costOf(order.type, order.options, { prices: { capsules: 0, teaser: 0, subtitlesPer5Min: 0, translationPer5Min: 0 } });
  return c ? c.label : 'Création';
}

/** Rembourse une commande en échec (idempotent). */
async function refundOrder(orderId, reason = 'Génération en échec : crédits rendus') {
  const { rows } = await db.query(
    `WITH o AS (SELECT id, client_id, credits_charged FROM orders WHERE id = $1 AND credits_charged > 0 FOR UPDATE)
     UPDATE orders SET credits_charged = 0 FROM o WHERE orders.id = o.id
     RETURNING o.client_id, o.credits_charged::int AS credits_charged`,
    [orderId]
  );
  const r = rows[0];
  if (!r || !r.client_id) return null;
  return move(r.client_id, Number(r.credits_charged), 'remboursement', { label: reason, orderId });
}

/* ------------------------------------------------------------------ Compte */

async function account(clientId, { historyLimit = 50 } = {}) {
  await expireIfDue(clientId);
  const s = await settings.get();
  const { rows } = await db.query(`SELECT c.credit_balance, ${EXPIRY_SQL('$2')} AS expires_at FROM clients c WHERE c.id = $1`, [clientId, s.validityDays]);
  if (!rows[0]) return null;
  const [hist, bought] = await Promise.all([
    db.query('SELECT * FROM client_credit_ledger WHERE client_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [clientId, historyLimit]),
    db.query("SELECT pack_id FROM credit_purchases WHERE client_id = $1 AND status = 'paid'", [clientId]),
  ]);
  const owned = new Set(bought.rows.map((r) => r.pack_id));
  const vat = config.stripe.vatRate;
  return {
    balance: Number(rows[0].credit_balance),
    expiresAt: rows[0].expires_at || null,
    validityDays: s.validityDays,
    prices: s.prices,
    packs: s.packs.map((p) => ({
      ...p,
      priceTTC: Math.round(p.priceHT * 100 * (1 + vat)) / 100,
      productions: s.prices.capsules ? Math.round((p.credits / s.prices.capsules) * 10) / 10 : null,
      available: !(p.once && owned.has(p.id)),
    })),
    history: hist.rows.map((l) => ({
      id: String(l.id), kind: l.kind, credits: Number(l.credits), balanceAfter: Number(l.balance_after),
      label: l.label, orderId: l.order_id, purchaseId: l.purchase_id, actor: l.actor, at: l.created_at,
    })),
  };
}

/* ------------------------------------------------------------------ Recharges */

function returnBase(requested) {
  const origins = config.frontendOrigins;
  return origins.includes(requested) ? requested : origins[0] || config.publicBaseUrl;
}

/** Prépare l'achat d'un pack : renvoie l'adresse de la page de paiement Stripe (ou simulée). */
async function createPurchase(client, packId, { returnOrigin, stripe } = {}) {
  const s = await settings.get();
  const pack = s.packs.find((p) => p.id === String(packId || ''));
  if (!pack) throw new CreditError('Choisissez une recharge.');
  if (pack.once) {
    const { rowCount } = await db.query("SELECT 1 FROM credit_purchases WHERE client_id = $1 AND pack_id = $2 AND status = 'paid'", [client.id, pack.id]);
    if (rowCount) throw new CreditError(`« ${pack.label} » ne peut être acheté qu’une seule fois.`, 409);
  }
  const id = crypto.randomUUID();
  const ht = Math.round(pack.priceHT * 100);
  const ttc = Math.round(pack.priceHT * 100 * (1 + config.stripe.vatRate));
  const base = returnBase(returnOrigin);
  await db.query(
    `INSERT INTO credit_purchases (id, client_id, pack_id, pack_label, credits, amount_ht_cents, amount_ttc_cents, status, return_base)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_payment',$8)`,
    [id, client.id, pack.id, pack.label, pack.credits, ht, ttc, base]
  );
  const title = `Recharge OpenStudio — ${pack.label} (${fmt(pack.credits)} crédits)`;
  let session;
  if (config.stripe.mock) {
    session = { id: `mock_${id}`, url: `${config.publicBaseUrl}/api/credits/mock-checkout/${id}` };
  } else {
    try {
      const priceId = await require('./stripe-catalog').priceFor(pack.id, ttc);
      session = await (stripe || require('../montage/stripe')).createCheckoutSession({
        requestId: id, priceId, title, description: `${fmt(pack.credits)} crédits, valables ${s.validityDays} jours avec tout votre solde`,
        amountTtcCents: ttc, email: client.email || undefined,
        successUrl: `${base}/?credits=paid&purchase=${id}`, cancelUrl: `${base}/?credits=cancelled&purchase=${id}`,
        metadata: { credit_purchase_id: id, client_id: client.id },
      });
    } catch (e) {
      console.error('[crédits] Stripe :', e.message);
      await tracking.recordTechnical('recharge', id, `ouverture de la page de paiement impossible (${e.message})`, { fail: true });
      throw new CreditError('Le paiement n’a pas pu être préparé. Réessayez dans quelques minutes.', 502);
    }
  }
  await db.query('UPDATE credit_purchases SET stripe_session_id = $2, updated_at = now() WHERE id = $1', [id, session.id]);
  await tracking.record('recharge', id, 'page_ouverte', { message: `Page de paiement ouverte : ${pack.label}, ${(ttc / 100).toFixed(2).replace('.', ',')} € TTC` });
  return { id, checkoutUrl: session.url };
}

/**
 * Paiement confirmé (idempotent) : crédite le solde, relance la validité de tout le solde,
 * puis envoie l'e-mail de confirmation.
 */
async function markPurchasePaid(purchaseId, paymentIntent = null, { send = mailer.send } = {}) {
  const { rows } = await db.query(
    `UPDATE credit_purchases SET status = 'paid', paid_at = now(), stripe_payment_intent = COALESCE($2, stripe_payment_intent), updated_at = now()
     WHERE id = $1 AND status <> 'paid' RETURNING *`,
    [purchaseId, paymentIntent]
  );
  const p = rows[0];
  if (!p) return null;
  await tracking.record('recharge', p.id, 'paye', { message: `Payé : ${(p.amount_ttc_cents / 100).toFixed(2).replace('.', ',')} € TTC, +${p.credits} crédits` });
  const s = await settings.get();
  await expireIfDue(p.client_id); // un solde déjà échu n'est pas prolongé
  await db.query(
    `UPDATE clients c SET credits_expire_at = GREATEST(
       CASE WHEN ${EXPIRY_SQL('$2')} > now() THEN ${EXPIRY_SQL('$2')} END,
       now() + make_interval(days => $2::int))
     WHERE c.id = $1`,
    [p.client_id, s.validityDays]
  );
  const row = await move(p.client_id, p.credits, 'recharge', { label: `${p.pack_label} payé par carte`, purchaseId: p.id });
  await db.query('UPDATE credit_purchases SET credited_at = now() WHERE id = $1', [p.id]);
  console.log(`[crédits] recharge ${p.id.slice(0, 8)} payée : +${p.credits} crédits (solde ${row ? row.balance_after : '?'})`);
  await require('../invoicing/service').invoicePayment('recharge', p.id).catch((e) => console.error('[facture]', e.message));
  await sendConfirmation(p.id, { send }).catch((e) => console.error('[crédits] e-mail de confirmation', e.message));
  return { ...p, balanceAfter: row ? row.balance_after : null };
}

function confirmationEmail(client, p, balance, expiresAt) {
  const euros = (c) => (c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const until = expiresAt ? new Date(expiresAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }) : '';
  const site = config.clientSiteUrl || '';
  const text = [
    client.name ? `Bonjour ${client.name},` : 'Bonjour,',
    '',
    `Votre paiement de ${euros(p.amount_ttc_cents)} € TTC est confirmé : ${fmt(p.credits)} crédits ont été ajoutés à votre espace OpenStudio (${p.pack_label}).`,
    '',
    `Votre solde : ${fmt(balance)} crédits${until ? `, utilisables jusqu’au ${until} inclus` : ''}.`,
    '',
    site ? `Pour lancer vos prochaines créations : ${site}` : '',
    'Votre facture est disponible dans la rubrique Factures de votre espace.',
    '',
    'L’équipe OpenMedias',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return {
    to: { email: client.email, name: client.name || undefined },
    subject: 'Votre recharge de crédits est confirmée',
    text,
    templateId: config.mail.templateCreditsRecharge || null,
    variables: {
      nom: client.name || '', entreprise: client.company || '', pack: p.pack_label,
      credits: fmt(p.credits), montant_ttc: euros(p.amount_ttc_cents), solde: fmt(balance), valable_jusqu_au: until, lien: site,
    },
    customId: `recharge-${p.id}`,
  };
}

/** E-mail « recharge confirmée » (journalisé sur la fiche client). */
async function sendConfirmation(purchaseId, { send = mailer.send } = {}) {
  const { rows } = await db.query(
    'SELECT p.*, c.name, c.company, c.email, c.credit_balance FROM credit_purchases p JOIN clients c ON c.id = p.client_id WHERE p.id = $1',
    [purchaseId]
  );
  const p = rows[0];
  if (!p || p.email_sent_at) return null;
  const client = { id: p.client_id, name: p.name, company: p.company, email: p.email };
  const subject = 'Votre recharge de crédits est confirmée';
  const log = (status, extra = {}) => db.query(
    `INSERT INTO client_emails (client_id, kind, to_email, redirected_to, subject, status, provider_id, error, automatic)
     VALUES ($1, 'recharge', $2, $3, $4, $5, $6, $7, true)`,
    [client.id, client.email || '', extra.redirectedTo || null, subject, status, extra.providerId || null, extra.error ? String(extra.error).slice(0, 500) : null]
  ).catch((e) => console.error('[crédits] journal des e-mails', e.message));
  const fail = async (msg) => {
    await db.query('UPDATE credit_purchases SET email_error = $2 WHERE id = $1', [p.id, String(msg).slice(0, 300)]);
    await log('echec', { error: msg, redirectedTo: config.mail.redirectTo || null });
    return { error: msg };
  };
  if (!client.email) return fail('Pas d’adresse e-mail sur la fiche client.');
  const unavailable = send === mailer.send ? mailer.problem() : null;
  if (unavailable) return fail(unavailable);
  const message = confirmationEmail(client, p, Number(p.credit_balance), await expiryOf(client.id));
  try {
    const r = await send(message);
    await db.query('UPDATE credit_purchases SET email_sent_at = now(), email_error = NULL WHERE id = $1', [p.id]);
    await log('envoye', { providerId: r && r.messageId, redirectedTo: r && r.redirectedTo });
    return { sent: true };
  } catch (e) {
    return fail(e.message);
  }
}

/** Notification Stripe concernant une recharge (signature et doublons déjà contrôlés). */
async function handleStripeEvent(event, purchaseId) {
  const s = event.data && event.data.object;
  if (event.type === 'checkout.session.completed' && s.payment_status === 'paid') await markPurchasePaid(purchaseId, s.payment_intent || null);
  if (event.type === 'checkout.session.async_payment_succeeded') await markPurchasePaid(purchaseId, s.payment_intent || null);
  if (event.type === 'payment_intent.payment_failed') await tracking.recordFailure('recharge', purchaseId, s.last_payment_error);
  if (event.type === 'checkout.session.async_payment_failed') await tracking.recordFailure('recharge', purchaseId, { code: 'processing_error', message: 'Paiement différé refusé' });
  if (event.type === 'checkout.session.expired') await tracking.markAbandoned('recharge', purchaseId, 'Page de paiement expirée chez Stripe sans paiement');
  return { status: 200 };
}

async function getPurchase(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { rows } = await db.query('SELECT * FROM credit_purchases WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listPurchases(clientId, limit = 50) {
  const { rows } = await db.query('SELECT * FROM credit_purchases WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2', [clientId, limit]);
  return rows;
}

module.exports = {
  CreditError, costOf, tranchesOf, move, grantIncluded, grantIncludedToAll, expireIfDue, expireAll, expiryOf, adjust,
  chargeOrder, refundOrder, account, createPurchase, markPurchasePaid, sendConfirmation, confirmationEmail,
  handleStripeEvent, getPurchase, listPurchases, returnBase, settings,
};
