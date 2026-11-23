'use strict';
/**
 * Pennylane (API v2 « Company ») : clients et factures clients.
 * Référence : https://pennylane.readme.io/ (spécification OpenAPI « Company V2 »).
 * - Authentification : jeton d'entreprise (Bearer), créé dans Pennylane → Paramètres → Connectivité →
 *   Développeurs, droits « Lecture et écriture » (scopes customers:all et customer_invoices:all).
 * - Limite : 25 requêtes toutes les 5 secondes par jeton (429 sinon, nouvel essai automatique).
 * - Sans jeton, ou avec PENNYLANE_MOCK=1 : simulation (aucun appel, numéros « TEST-… »).
 */
const crypto = require('crypto');
const config = require('../config');

const BASE = 'https://app.pennylane.com/api/external/v2';

class PennylaneError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, { body, query, fetchImpl = fetch, retries = 2 } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${config.invoicing.pennylaneKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429 && retries > 0) {
    const wait = Number(res.headers.get('retry-after')) || 5;
    await sleep(Math.min(wait, 10) * 1000);
    return request(method, path, { body, query, fetchImpl, retries: retries - 1 });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const detail = data && (data.error || data.message || (Array.isArray(data.errors) ? data.errors.join(' ; ') : null));
    throw new PennylaneError(`Pennylane ${res.status}${detail ? ` : ${String(detail).slice(0, 300)}` : ''}`, res.status, data);
  }
  return data;
}

const mock = () => config.invoicing.pennylaneMock || !config.invoicing.pennylaneKey;
const fakeId = () => crypto.randomInt(100000, 999999);

/** Client entreprise retrouvé par notre référence, sinon créé. */
async function ensureCustomer({ externalReference, name, billing, email, recipient }, opts = {}) {
  if (mock()) return { id: fakeId(), mock: true };
  const found = await request('GET', '/customers', { ...opts, query: { filter: [{ field: 'external_reference', operator: 'eq', value: externalReference }], limit: 1 } });
  const existing = found && Array.isArray(found.items) && found.items[0];
  if (existing) return existing;
  return request('POST', '/company_customers', {
    ...opts,
    body: {
      name: name.slice(0, 200),
      ...(billing.vat ? { vat_number: billing.vat } : {}),
      ...(billing.siret ? { reg_no: billing.siret } : {}),
      billing_address: { address: billing.address, postal_code: billing.postalCode, city: billing.city, country_alpha2: countryCode(billing.country) },
      ...(email ? { emails: [email] } : {}),
      ...(recipient ? { recipient } : {}),
      external_reference: externalReference,
      billing_language: 'fr_FR',
    },
  });
}

/**
 * Facture finalisée (non brouillon), une ligne de prestation à 20 %, puis marquée payée
 * (réglée par carte sur Stripe). Une facture déjà créée avec la même référence est reprise.
 */
async function createPaidInvoice({ customerId, externalReference, label, description, amountHtCents, vatRate, paidAt, poReference }, opts = {}) {
  if (mock()) return { id: fakeId(), invoice_number: `TEST-${new Date().getFullYear()}-${String(fakeId()).slice(0, 4)}`, mock: true };
  const day = (paidAt ? new Date(paidAt) : new Date()).toISOString().slice(0, 10);
  let inv;
  try {
    inv = await request('POST', '/customer_invoices', {
      ...opts,
      body: {
        date: day,
        deadline: day,
        customer_id: customerId,
        draft: false,
        currency: 'EUR',
        sale_type: 'services',
        pdf_invoice_subject: label.slice(0, 200),
        ...(description ? { pdf_description: description.slice(0, 5000) } : {}),
        special_mention: 'Facture acquittée : réglée par carte bancaire en ligne.',
        external_reference: externalReference,
        ...(poReference ? { purchase_order_reference: String(poReference).slice(0, 50) } : {}),
        invoice_lines: [{
          label: label.slice(0, 200),
          quantity: 1,
          unit: 'piece',
          raw_currency_unit_price: (amountHtCents / 100).toFixed(2),
          vat_rate: vatCode(vatRate),
        }],
      },
    });
  } catch (e) {
    // Déjà créée lors d'un essai précédent (référence unique) : on la reprend
    if (e.status !== 422 && e.status !== 409) throw e;
    const found = await request('GET', '/customer_invoices', { ...opts, query: { filter: [{ field: 'external_reference', operator: 'eq', value: externalReference }], limit: 1 } });
    inv = found && Array.isArray(found.items) && found.items[0];
    if (!inv) throw e;
  }
  if (!inv.paid) {
    await request('PUT', `/customer_invoices/${inv.id}/mark_as_paid`, opts).catch((e) => {
      console.warn(`[pennylane] facture ${inv.invoice_number || inv.id} créée, mais non marquée payée : ${e.message}`);
    });
  }
  return inv;
}

/** Adresse du PDF (valable 30 minutes chez Pennylane) : demandée au moment de l'ouvrir. */
async function invoiceFile(invoiceId, opts = {}) {
  if (mock()) return null;
  const inv = await request('GET', `/customer_invoices/${encodeURIComponent(invoiceId)}`, opts);
  return inv && inv.public_file_url ? { number: inv.invoice_number || null, url: inv.public_file_url } : null;
}

function vatCode(rate) {
  const r = Math.round(Number(rate) * 1000); // 0.2 → 200
  return { 200: 'FR_200', 100: 'FR_100', 55: 'FR_55', 21: 'FR_21' }[r] || 'FR_200';
}

const COUNTRIES = { france: 'FR', belgique: 'BE', suisse: 'CH', luxembourg: 'LU', monaco: 'MC', allemagne: 'DE', espagne: 'ES', italie: 'IT', 'royaume-uni': 'GB', canada: 'CA' };
function countryCode(country) {
  const c = String(country || 'France').trim();
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  return COUNTRIES[c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()] || 'FR';
}

module.exports = { request, ensureCustomer, createPaidInvoice, invoiceFile, vatCode, countryCode, PennylaneError, mock };
