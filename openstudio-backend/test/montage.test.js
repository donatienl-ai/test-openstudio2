'use strict';
/**
 * « Confier ma vidéo à un monteur » : prix serveur, formulaire, paiement Stripe (simulé ou réel, API Stripe
 * remplacée par une fausse), notifications signées et idempotentes.
 * Les tests sur base PostgreSQL demandent TEST_DATABASE_URL (sinon ignorés).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.DATABASE_SSL = 'false';
}
process.env.PUBLIC_BASE_URL = 'https://backend.example';
process.env.FRONTEND_ORIGIN = 'https://site.example,https://autre.example';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stripe_test';
const skip = !DB && 'TEST_DATABASE_URL non défini';

const config = require('../src/config');
const { OFFERS, ttcCents } = require('../src/montage/offers');
const stripe = require('../src/montage/stripe');
const montage = require('../src/montage/service');
const db = require('../src/db');

const form = (o = {}) => ({
  offerId: 'teaser',
  contact: { company: 'Ecoval Industrie', name: 'Claire Dumas', email: 'C.Dumas@Ecoval.fr', phone: '06 12 34 56 78' },
  brief: { description: 'Un teaser de notre passage pour LinkedIn.', programme: 'BFM Business — Passage', formats: ['Vertical', 'Inconnu'], deadline: '' },
  ...o,
});
const sign = (body, secret = 'whsec_stripe_test', t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('tarifs de la plaquette (sans drone, traduction d’article ni pack communication)', () => {
  assert.deepEqual(OFFERS.map((o) => [o.id, o.priceHT]), [
    ['capsules', 780], ['teaser', 680], ['sous-titres-fr', 420], ['sous-titres-langue', 420], ['rushes', 480], ['media-training', null],
  ]);
  assert.equal(OFFERS.some((o) => /drone|pack communication|traduction d.article/i.test(o.title)), false);
  assert.equal(ttcCents(680, 0.2), 81600);
  assert.equal(ttcCents(420, 0.2), 50400);
});

test('formulaire : coordonnées et description obligatoires, valeurs nettoyées', () => {
  const v = montage.validate(form());
  assert.equal(v.offer.priceHT, 680);
  assert.equal(v.contact.email, 'c.dumas@ecoval.fr');
  assert.deepEqual(v.brief.formats, ['Vertical'], 'format inconnu ignoré');
  assert.throws(() => montage.validate(form({ offerId: 'drone' })), /prestation/);
  assert.throws(() => montage.validate(form({ contact: { ...form().contact, company: ' ' } })), /entreprise/);
  assert.throws(() => montage.validate(form({ contact: { ...form().contact, email: 'pas-un-mail' } })), /e-mail/);
  assert.throws(() => montage.validate(form({ brief: { description: 'court' } })), /Décrivez/);
  assert.throws(() => montage.validate(form({ brief: { ...form().brief, deadline: '2020-01-01' } })), /passée/);
  // Un prix envoyé par le navigateur est ignoré
  assert.equal(montage.validate(form({ priceHT: 1, amount: 1 })).offer.priceHT, 680);
});

test('Stripe : encodage des paramètres et vérification de signature', () => {
  assert.equal(stripe.form({ line_items: [{ price_data: { unit_amount: 81600 } }], mode: 'payment' }).toString(), 'line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=81600&mode=payment');
  const body = JSON.stringify({ id: 'evt_1' });
  assert.deepEqual(stripe.verifyWebhook(Buffer.from(body), sign(body)), { id: 'evt_1' });
  assert.equal(stripe.verifyWebhook(Buffer.from(body), sign(body, 'faux')), null);
  assert.equal(stripe.verifyWebhook(Buffer.from(body + ' '), sign(body)), null, 'corps modifié');
  assert.equal(stripe.verifyWebhook(Buffer.from(body), sign(body, undefined, Math.floor(Date.now() / 1000) - 3600)), null, 'trop ancien');
  assert.equal(montage.returnBase('https://autre.example'), 'https://autre.example');
  assert.equal(montage.returnBase('https://pirate.example'), 'https://site.example', 'origine non autorisée ignorée');
});

test.before(async () => {
  if (skip) return;
  if (!/test/i.test(DB)) throw new Error('TEST_DATABASE_URL doit désigner une base de test');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
});
test.after(async () => { if (!skip) await db.pool.end(); });

test('paiement simulé (sans clé Stripe) : page de paiement puis demande payée', { skip }, async () => {
  assert.equal(config.stripe.mock, true);
  const r = await montage.createRequest(null, form(), { returnOrigin: 'https://site.example' });
  assert.equal(r.status, 'awaiting_payment');
  assert.equal(r.checkoutUrl, `https://backend.example/api/montage/mock-checkout/${r.id}`);
  const row = await montage.getRequest(r.id);
  assert.equal(row.amount_ht_cents, 68000);
  assert.equal(row.amount_ttc_cents, 81600);
  assert.equal(row.return_base, 'https://site.example');
  assert.ok(await montage.markPaid(r.id, 'simulation'));
  assert.equal(await montage.markPaid(r.id, 'simulation'), null, 'deuxième confirmation sans effet');
  assert.deepEqual(await montage.publicStatus(r.id), { id: r.id, status: 'paid', offerTitle: 'Teaser vidéo de 30 à 40 secondes' });
});

test('Stripe réel (API remplacée) : session Checkout au prix serveur, notification signée et idempotente', { skip }, async () => {
  config.stripe.secretKey = 'sk_test_x';
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 }); };
  let r;
  try {
    r = await montage.createRequest(null, form({ offerId: 'capsules' }), { returnOrigin: 'https://site.example' });
  } finally {
    global.fetch = realFetch;
    config.stripe.secretKey = '';
  }
  assert.equal(r.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(sent.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(sent.init.headers.Authorization, 'Bearer sk_test_x');
  const p = new URLSearchParams(sent.init.body);
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '93600', '780 € HT = 936 € TTC');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(p.get('customer_email'), 'c.dumas@ecoval.fr');
  assert.equal(p.get('metadata[montage_request_id]'), r.id);
  assert.equal(p.get('success_url'), `https://site.example/?montage=paid&request=${r.id}`);

  const event = JSON.stringify({ id: 'evt_paid_1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_1', metadata: { montage_request_id: r.id } } } });
  assert.equal((await montage.handleStripeWebhook(Buffer.from(event), sign(event, 'mauvais'))).status, 400);
  assert.equal((await montage.handleStripeWebhook(Buffer.from(event), sign(event))).status, 200);
  assert.equal((await montage.handleStripeWebhook(Buffer.from(event), sign(event))).duplicate, true);
  const row = await montage.getRequest(r.id);
  assert.equal(row.status, 'paid');
  assert.equal(row.stripe_payment_intent, 'pi_1');
});

test('prix à définir (media training) : demande enregistrée sans paiement', { skip }, async () => {
  const r = await montage.createRequest(null, form({ offerId: 'media-training' }));
  assert.equal(r.status, 'to_quote');
  assert.equal(r.checkoutUrl, undefined);
  const row = await montage.getRequest(r.id);
  assert.equal(row.amount_ttc_cents, null);
});
