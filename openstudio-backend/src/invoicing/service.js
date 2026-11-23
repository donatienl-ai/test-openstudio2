'use strict';
/**
 * Factures des paiements par carte : montages sur mesure et recharges de crédits.
 * - Pennylane (PENNYLANE_API_KEY) : client et facture créés après le paiement, facture marquée payée.
 * - Sinon : facture Stripe (créée par Stripe Checkout, comme avant).
 * Une facture ne bloque jamais un paiement : en cas d'échec ou d'adresse manquante, elle reste
 * « à faire » et le worker réessaie (5 essais), ou dès que le client complète son adresse.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const pennylane = require('./pennylane');

const TABLES = { montage: 'montage_requests', recharge: 'credit_purchases' };
const MAX_ATTEMPTS = 5;

/** Adresse de facturation complète ? */
const complete = (b) => Boolean(b && b.address && b.postalCode && b.city);

async function load(kind, id) {
  const { rows } = await db.query(`SELECT * FROM ${TABLES[kind]} WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Client à facturer : fiche du client (Factures → Modifier), sinon coordonnées saisies avec la demande. */
async function billingFor(kind, row) {
  const c = row.client_id ? (await db.query('SELECT id, name, company, email, billing FROM clients WHERE id = $1', [row.client_id])).rows[0] : null;
  const fromRequest = kind === 'montage' && row.contact && row.contact.billing ? row.contact.billing : null;
  const billing = (c && complete(c.billing) && c.billing) || (complete(fromRequest) && fromRequest) || null;
  const contact = row.contact || {};
  const name = (billing && billing.company) || (c && (c.company || c.name)) || contact.company || 'Client OpenStudio';
  const email = (billing && billing.email) || (c && c.email) || contact.email || null;
  const externalReference = c ? `openstudio-client-${c.id}` : `openstudio-contact-${crypto.createHash('sha256').update(String(contact.email || row.id).toLowerCase()).digest('hex').slice(0, 24)}`;
  return { billing, name, email, recipient: (billing && billing.contact) || contact.name || null, externalReference };
}

function lineFor(kind, row) {
  if (kind === 'montage') {
    const b = row.brief || {};
    return { label: row.offer_title, description: [b.programme ? `Émission : ${b.programme}` : '', b.description ? `Demande : ${b.description}` : ''].filter(Boolean).join('\n') };
  }
  return { label: `${row.pack_label} — ${row.credits} crédits OpenStudio`, description: null };
}

/**
 * Crée la facture d'un paiement réglé (idempotent).
 * @returns {Promise<{ status: 'created'|'stripe'|'missing_address'|'error'|'skipped', number?: string, error?: string }>}
 */
async function invoicePayment(kind, id) {
  const row = await load(kind, id);
  if (!row || row.status !== 'paid' || !row.amount_ht_cents) return { status: 'skipped' };
  if (row.invoice_status === 'created') return { status: 'created', number: row.invoice_number };
  if (config.invoicing.provider !== 'pennylane') {
    await db.query(`UPDATE ${TABLES[kind]} SET invoice_provider = 'stripe', invoice_status = 'stripe' WHERE id = $1 AND invoice_status IS NULL`, [id]);
    return { status: 'stripe' };
  }
  const who = await billingFor(kind, row);
  if (!who.billing) {
    await db.query(`UPDATE ${TABLES[kind]} SET invoice_provider = 'pennylane', invoice_status = 'missing_address', invoice_error = $2 WHERE id = $1`,
      [id, 'Adresse de facturation manquante : la facture sera créée dès que le client l’aura renseignée (Factures → Modifier).']);
    return { status: 'missing_address' };
  }
  try {
    const customer = await pennylane.ensureCustomer(who);
    const line = lineFor(kind, row);
    const inv = await pennylane.createPaidInvoice({
      customerId: customer.id,
      externalReference: `openstudio-${kind}-${row.id}`,
      label: line.label,
      description: line.description,
      amountHtCents: row.amount_ht_cents,
      vatRate: config.stripe.vatRate,
      paidAt: row.paid_at,
      poReference: who.billing.po,
    });
    const number = inv.invoice_number || null;
    await db.query(
      `UPDATE ${TABLES[kind]} SET invoice_provider = 'pennylane', invoice_status = 'created', invoice_external_id = $2, invoice_number = $3,
         invoice_error = NULL, invoice_attempts = invoice_attempts + 1 WHERE id = $1`,
      [id, String(inv.id), number]
    );
    console.log(`[facture] ${kind} ${id.slice(0, 8)} : facture ${number || inv.id}${inv.mock ? ' (simulée)' : ''} créée dans Pennylane`);
    return { status: 'created', number, mock: Boolean(inv.mock) };
  } catch (e) {
    await db.query(`UPDATE ${TABLES[kind]} SET invoice_provider = 'pennylane', invoice_status = 'error', invoice_error = $2, invoice_attempts = invoice_attempts + 1 WHERE id = $1`,
      [id, e.message.slice(0, 500)]);
    console.error(`[facture] ${kind} ${id.slice(0, 8)} : ${e.message}`);
    return { status: 'error', error: e.message };
  }
}

/** Nouveaux essais (worker) : erreurs passagères, et adresses complétées depuis par le client. */
async function retryPending({ limit = 10 } = {}) {
  if (config.invoicing.provider !== 'pennylane') return 0;
  let n = 0;
  for (const [kind, table] of Object.entries(TABLES)) {
    const { rows } = await db.query(
      `SELECT id FROM ${table} WHERE status = 'paid' AND amount_ht_cents IS NOT NULL
         AND (invoice_status IS NULL OR invoice_status = 'missing_address' OR (invoice_status = 'error' AND invoice_attempts < $1))
       ORDER BY paid_at LIMIT $2`,
      [MAX_ATTEMPTS, limit]
    );
    for (const r of rows) {
      const res = await invoicePayment(kind, r.id);
      if (res.status === 'created') n += 1;
    }
  }
  return n;
}

/** Lien vers la facture : PDF Pennylane (adresse temporaire) ou facture Stripe. */
async function invoiceLink(kind, row) {
  if (row.invoice_provider === 'pennylane') {
    if (row.invoice_status !== 'created') return { error: row.invoice_error || 'La facture n’est pas encore créée.', status: 409 };
    if (String(row.invoice_external_id || '').length && !pennylane.mock()) {
      const f = await pennylane.invoiceFile(row.invoice_external_id);
      if (f) return { kind: 'facture', number: f.number || row.invoice_number, url: f.url, pdf: f.url };
    }
    return { error: 'Le PDF de la facture est en cours de génération chez Pennylane : réessayez dans quelques minutes.', status: 404 };
  }
  return null; // Stripe : traité par l'appelant
}

module.exports = { invoicePayment, retryPending, invoiceLink, billingFor, complete, MAX_ATTEMPTS };
