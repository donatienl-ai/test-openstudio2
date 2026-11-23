'use strict';
/**
 * Factures Pennylane (API remplacée par une fausse, conforme à la spécification « Company V2 ») et
 * e-mail à la compta quand un montage est payé. Base PostgreSQL : TEST_DATABASE_URL (sinon ignoré).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.DATABASE_SSL = 'false';
}
process.env.PUBLIC_BASE_URL = 'https://backend.example';
process.env.FRONTEND_ORIGIN = 'https://site.example';
process.env.STRIPE_SECRET_KEY = '';
process.env.PENNYLANE_API_KEY = 'pl_test_token';
process.env.PENNYLANE_MOCK = '';
process.env.ACCOUNTING_EMAIL = 'compta@openmedias.test';
process.env.ADMIN_URL = 'https://admin.example';
const skip = !DB && 'TEST_DATABASE_URL non défini';

const config = require('../src/config');
const pennylane = require('../src/invoicing/pennylane');
const invoicing = require('../src/invoicing/service');
const notify = require('../src/montage/notify');
const montage = require('../src/montage/service');
const clients = require('../src/clients');
const db = require('../src/db');

/** Fausse API Pennylane : clients et factures en mémoire, mêmes chemins et champs que la vraie. */
function fakePennylane() {
  const st = { customers: [], invoices: [], calls: [] };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    st.calls.push({ method: init.method, path: u.pathname, body, auth: init.headers.Authorization, query: Object.fromEntries(u.searchParams) });
    const filter = u.searchParams.get('filter') ? JSON.parse(u.searchParams.get('filter')) : [];
    const ref = (filter.find((f) => f.field === 'external_reference') || {}).value;
    if (u.pathname === '/api/external/v2/customers' && init.method === 'GET') return json({ items: st.customers.filter((c) => c.external_reference === ref), has_more: false, next_cursor: null });
    if (u.pathname === '/api/external/v2/company_customers' && init.method === 'POST') {
      const c = { id: 100 + st.customers.length, ...body };
      st.customers.push(c);
      return json(c, 201);
    }
    if (u.pathname === '/api/external/v2/customer_invoices' && init.method === 'POST') {
      if (st.invoices.some((i) => i.external_reference === body.external_reference)) return json({ error: 'external_reference already taken' }, 422);
      if (st.failNext) { st.failNext = false; return json({ error: 'Service indisponible' }, 503); }
      const inv = { id: 900 + st.invoices.length, invoice_number: `F-2026-${String(st.invoices.length + 1).padStart(4, '0')}`, paid: false, ...body };
      st.invoices.push(inv);
      return json(inv, 201);
    }
    if (u.pathname === '/api/external/v2/customer_invoices' && init.method === 'GET') return json({ items: st.invoices.filter((i) => i.external_reference === ref) });
    const paid = u.pathname.match(/^\/api\/external\/v2\/customer_invoices\/(\d+)\/mark_as_paid$/);
    if (paid && init.method === 'PUT') { st.invoices.find((i) => i.id === Number(paid[1])).paid = true; return json({}); }
    const one = u.pathname.match(/^\/api\/external\/v2\/customer_invoices\/(\d+)$/);
    if (one) { const i = st.invoices.find((x) => x.id === Number(one[1])); return json({ ...i, public_file_url: `https://files.pennylane.example/${i.id}.pdf` }); }
    return json({ error: 'not found' }, 404);
  };
  return st;
}

test('Pennylane : codes de TVA et de pays', () => {
  assert.equal(pennylane.vatCode(0.2), 'FR_200');
  assert.equal(pennylane.vatCode(0.055), 'FR_55');
  assert.equal(pennylane.countryCode('France'), 'FR');
  assert.equal(pennylane.countryCode('Belgique'), 'BE');
  assert.equal(pennylane.countryCode('ch'), 'CH');
  assert.equal(config.invoicing.provider, 'pennylane');
});

test('e-mail compta : prestation, montants HT/TVA/TTC, client, demande, facture', () => {
  const m = notify.accountingEmail({
    id: 'abcdef12-0000-4000-8000-000000000000', client_id: 'c1', offer_title: 'Teaser vidéo de 30 à 40 secondes', amount_ht_cents: 68000, amount_ttc_cents: 81600,
    paid_at: '2026-11-23T10:00:00Z', stripe_payment_intent: 'pi_123', invoice_status: 'created', invoice_number: 'F-2026-0001',
    contact: { company: 'Ecoval', name: 'Claire Dumas', email: 'c@ecoval.test', phone: '0612345678' },
    brief: { programme: 'BFM Business — Passage', description: 'Un teaser pour LinkedIn.', formats: ['Vertical'], deadline: '2026-12-01' },
  }, { billing: { company: 'Ecoval SAS', address: '12 rue des Lilas', postalCode: '69003', city: 'Lyon', vat: 'FR12345678901' } });
  assert.deepEqual(m.to, [{ email: 'compta@openmedias.test' }]);
  assert.match(m.subject, /Montage payé : Teaser vidéo de 30 à 40 secondes — Ecoval \(816,00 € TTC\)/);
  assert.match(m.text, /680,00 € HT \+ 136,00 € de TVA = 816,00 € TTC/);
  assert.match(m.text, /Facture F-2026-0001 créée dans Pennylane et marquée payée/);
  assert.match(m.text, /12 rue des Lilas, 69003 Lyon/);
  assert.match(m.text, /TVA : FR12345678901/);
  assert.match(m.text, /Un teaser pour LinkedIn\./);
  assert.match(m.text, /pi_123/);
  assert.match(m.text, /https:\/\/admin\.example\/#\/clients\/c1/);
  const missing = notify.accountingEmail({ id: 'x'.repeat(36), offer_title: 'Rushes', amount_ht_cents: 48000, amount_ttc_cents: 57600, invoice_status: 'missing_address', contact: {}, brief: {} });
  assert.match(missing.text, /Facture NON créée : adresse de facturation manquante/);
});

test.before(async () => {
  if (skip) return;
  if (!/test/i.test(DB)) throw new Error('TEST_DATABASE_URL doit désigner une base de test');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
});
test.after(async () => { if (!skip) await db.pool.end(); });

const form = (o = {}) => ({
  offerId: 'teaser',
  contact: { company: 'Ecoval Industrie', name: 'Claire Dumas', email: 'claire@ecoval.test', phone: '', ...(o.contact || {}) },
  brief: { description: 'Un teaser de notre passage pour LinkedIn.', programme: 'BFM Business', formats: ['Vertical'], deadline: '' },
});

test('montage payé : facture Pennylane finalisée et payée, e-mail compta une seule fois, pas de facture Stripe', { skip }, async () => {
  const realFetch = global.fetch;
  const st = fakePennylane();
  const mails = [];
  try {
    const client = await clients.create({ name: 'Ecoval Industrie', company: 'Ecoval Industrie', email: 'claire@ecoval.test' });
    const r = await montage.createRequest(client, form({ contact: { billing: { address: '12 rue des Lilas', postalCode: '69003', city: 'Lyon', vat: 'fr 12345678901' } } }));
    const saved = (await db.query('SELECT billing FROM clients WHERE id = $1', [client.id])).rows[0].billing;
    assert.equal(saved.city, 'Lyon', 'adresse gardée sur la fiche du client');
    // Paiement confirmé deux fois (notification Stripe en double)
    const send = async (m) => { mails.push(m); return { messageId: '1' }; };
    const orig = require('../src/mailer').send;
    require('../src/mailer').send = send;
    try {
      await montage.markPaid(r.id, 'pi_1');
      await montage.markPaid(r.id, 'pi_1');
      await notify.notifyAccounting(r.id);
    } finally {
      require('../src/mailer').send = orig;
    }
    const row = await montage.getRequest(r.id);
    assert.equal(row.invoice_status, 'created');
    assert.equal(row.invoice_number, 'F-2026-0001');
    assert.equal(st.invoices.length, 1);
    const inv = st.invoices[0];
    assert.equal(inv.draft, false);
    assert.equal(inv.paid, true, 'marquée payée');
    assert.equal(inv.currency, 'EUR');
    assert.equal(inv.external_reference, `openstudio-montage-${r.id}`);
    assert.deepEqual(inv.invoice_lines, [{ label: 'Teaser vidéo de 30 à 40 secondes', quantity: 1, unit: 'piece', raw_currency_unit_price: '680.00', vat_rate: 'FR_200' }]);
    const cust = st.customers[0];
    assert.equal(cust.external_reference, `openstudio-client-${client.id}`);
    assert.deepEqual(cust.billing_address, { address: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country_alpha2: 'FR' });
    assert.equal(cust.vat_number, 'FR12345678901');
    assert.ok(st.calls.every((c) => c.auth === 'Bearer pl_test_token'));
    assert.equal(mails.length, 1, 'un seul e-mail compta');
    assert.match(mails[0].text, /F-2026-0001/);
    // Lien vers le PDF (adresse temporaire demandée à l'ouverture)
    const link = await invoicing.invoiceLink('montage', row);
    assert.equal(link.url, `https://files.pennylane.example/${inv.id}.pdf`);
    // Plus de facture Stripe en double quand Pennylane est actif
    config.stripe.secretKey = 'sk_test_x';
    let stripeBody = null;
    global.fetch = async (url, init) => { stripeBody = new URLSearchParams(init.body); return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }), { status: 200 }); };
    try { await montage.createRequest(client, form()); } finally { config.stripe.secretKey = ''; }
    assert.equal(stripeBody.get('invoice_creation[enabled]'), null);
  } finally {
    global.fetch = realFetch;
  }
});

test('adresse manquante : facture en attente, créée dès que le client la renseigne ; erreur passagère reprise', { skip }, async () => {
  const realFetch = global.fetch;
  const st = fakePennylane();
  try {
    const client = await clients.create({ name: 'Nexalis', company: 'Nexalis', email: 'a@nexalis.test' });
    const r = await montage.createRequest(client, form({ contact: { email: 'a@nexalis.test' } }));
    await db.query("UPDATE montage_requests SET status = 'paid', paid_at = now() WHERE id = $1", [r.id]);
    assert.equal((await invoicing.invoicePayment('montage', r.id)).status, 'missing_address');
    assert.equal(st.invoices.length, 0);
    await db.query('UPDATE clients SET billing = $2 WHERE id = $1', [client.id, JSON.stringify({ company: 'Nexalis SAS', address: '1 quai Ouest', postalCode: '33000', city: 'Bordeaux', country: 'France' })]);
    st.failNext = true;
    await invoicing.retryPending();
    assert.equal((await montage.getRequest(r.id)).invoice_status, 'error', 'Pennylane indisponible : erreur enregistrée');
    await invoicing.retryPending();
    const row = await montage.getRequest(r.id);
    assert.equal(row.invoice_status, 'created');
    assert.equal(st.customers.at(-1).name, 'Nexalis SAS');
    // Création déjà faite mais réponse perdue : la facture existante est reprise (pas de doublon)
    await db.query("UPDATE montage_requests SET invoice_status = 'error' WHERE id = $1", [r.id]);
    await invoicing.retryPending();
    assert.equal(st.invoices.filter((i) => i.external_reference === `openstudio-montage-${r.id}`).length, 1);
    assert.equal((await montage.getRequest(r.id)).invoice_status, 'created');
  } finally {
    global.fetch = realFetch;
  }
});

test('simulation (PENNYLANE_MOCK=1, sans jeton) : numéro TEST-…, aucun appel', { skip }, async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response('{}'); };
  const key = config.invoicing.pennylaneKey;
  config.invoicing.pennylaneKey = '';
  config.invoicing.pennylaneMock = true;
  try {
    const client = await clients.create({ name: 'Hydrotec', company: 'Hydrotec', email: 'h@hydrotec.test', });
    await db.query('UPDATE clients SET billing = $2 WHERE id = $1', [client.id, JSON.stringify({ company: 'Hydrotec', address: '2 rue', postalCode: '75001', city: 'Paris' })]);
    const r = await montage.createRequest(client, form({ contact: { email: 'h@hydrotec.test' } }));
    await db.query("UPDATE montage_requests SET status = 'paid', paid_at = now() WHERE id = $1", [r.id]);
    const res = await invoicing.invoicePayment('montage', r.id);
    assert.equal(res.status, 'created');
    assert.match(res.number, /^TEST-/);
    assert.equal(calls, 0);
  } finally {
    config.invoicing.pennylaneKey = key;
    config.invoicing.pennylaneMock = false;
    global.fetch = realFetch;
  }
});
