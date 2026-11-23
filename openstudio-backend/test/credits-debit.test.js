'use strict';
/**
 * Débit réel des crédits, de bout en bout par les routes du serveur, avec un barème modifié
 * dans le back-office : le montant débité est celui paramétré au moment de la validation.
 * Demande TEST_DATABASE_URL (sinon ignoré).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.DATABASE_SSL = 'false';
}
process.env.FRONTEND_ORIGIN = 'https://site.example';
const skip = !DB && 'TEST_DATABASE_URL non défini';

const db = require('../src/db');
// Le traitement vidéo n'est pas lancé ici (pas de stockage) : sinon il échouerait et rendrait les crédits.
require('../src/worker').nudge = () => {};
const clients = require('../src/clients');
const credits = require('../src/credits/service');
const settings = require('../src/credits/settings');

let base;
let server;
let client;
let headers;
let video;

test.before(async () => {
  if (skip) return;
  if (!/test/i.test(DB)) throw new Error('TEST_DATABASE_URL doit désigner une base de test');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  const app = express();
  app.use('/api', require('../src/routes'));
  app.use('/api', require('../src/routes-credits'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;

  // Barème modifié dans le back-office : 1 000 crédits offerts, capsules 250, teaser 120
  const s = await settings.get({ fresh: true });
  await settings.save({ ...s, included: 1000, prices: { ...s.prices, capsules: 250, teaser: 120 } }, 'test');
  client = await clients.create({ name: 'Ecoval Industrie', company: 'Ecoval Industrie', email: 'c@ecoval.test', logoKey: 'logos/ecoval.png' });
  await credits.grantIncluded(client.id, 'test');
  video = await clients.addVideo(client.id, { programmeId: 'bfm-business', title: 'Passage', sourceKey: 'clients/x/video.mp4', durationSec: 600 });
  headers = { 'Content-Type': 'application/json', 'x-client-id': client.id, 'x-client-token': await clients.openSession(client.id, 'test') };
});
test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const balance = async () => (await call('GET', '/me/credits')).body.balance;
async function order(kind) {
  const c = await call('POST', '/orders', { type: 'capsules', options: { videoId: video.id, kind, duration: kind === 'teaser' ? '15 s' : '30 s', format: 'Vertical 9:16' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const v = await call('POST', `/orders/${c.body.order.id}/validate`);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return c.body.order.id;
}

test('débit au montant paramétré : capsules 250, teaser 120, une seule fois par commande', { skip }, async () => {
  assert.equal(await balance(), 1000, 'crédits offerts selon le barème');
  const id = await order('capsules');
  const { rows } = await db.query('SELECT credits_cost FROM orders WHERE id = $1', [id]);
  assert.equal(Number(rows[0].credits_cost), 250, 'coût fixé par le serveur à la validation');
  assert.equal((await call('POST', `/orders/${id}/pay/credits`)).status, 200);
  assert.equal(await balance(), 750);
  // Double clic : pas de second débit
  assert.equal((await call('POST', `/orders/${id}/pay/credits`)).status, 200);
  assert.equal(await balance(), 750);
  const t = await order('teaser');
  await call('POST', `/orders/${t}/pay/credits`);
  assert.equal(await balance(), 630);
  const { rows: ledger } = await db.query("SELECT credits, label FROM client_credit_ledger WHERE client_id = $1 AND kind = 'debit' ORDER BY id", [client.id]);
  assert.deepEqual(ledger.map((l) => Number(l.credits)), [-250, -120]);
});

test('génération en échec : crédits rendus (une seule fois)', { skip }, async () => {
  const id = await order('capsules');
  await call('POST', `/orders/${id}/pay/credits`);
  assert.equal(await balance(), 380);
  await credits.refundOrder(id);
  await credits.refundOrder(id);
  assert.equal(await balance(), 630);
});

test('solde insuffisant : 402 avec le montant manquant, rien de débité ni lancé', { skip }, async () => {
  await db.query('UPDATE clients SET credit_balance = 100 WHERE id = $1', [client.id]);
  const id = await order('capsules');
  const r = await call('POST', `/orders/${id}/pay/credits`);
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'credits_insuffisants');
  assert.equal(r.body.needed, 250);
  assert.match(r.body.error, /Il vous manque 150 crédits/);
  assert.equal(await balance(), 100);
  const { rows } = await db.query('SELECT status FROM orders WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'validated', 'commande non lancée');
});
