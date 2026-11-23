'use strict';
/** « Mon accès » : code visible ; « Code oublié ? » : code renvoyé par e-mail, sans révéler les adresses connues. */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.DATABASE_SSL = 'false';
}
process.env.ADMIN_ENCRYPTION_KEY = process.env.ADMIN_ENCRYPTION_KEY || 'k'.repeat(64);
process.env.MAIL_REDIRECT_TO = '';
process.env.MAIL_ALLOW_REAL_RECIPIENTS = '';
const skip = !DB && 'TEST_DATABASE_URL non défini';

const db = require('../src/db');
const clients = require('../src/clients');
const access = require('../src/admin/client-access');

let base;
let server;
let client;
let code;

test.before(async () => {
  if (skip) return;
  if (!/test/i.test(DB)) throw new Error('TEST_DATABASE_URL doit désigner une base de test');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  const app = express();
  app.use('/api', require('../src/routes'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  client = await clients.create({ name: 'Claire Dumas', company: 'Ecoval Industrie', email: 'Claire@Ecoval.test' });
  code = await access.ensureCode(client.id);
});
test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('e-mail « code oublié » : le code, le lien de connexion, rien d’autre', () => {
  const m = access.forgotCodeEmail({ id: 'x', name: 'Claire', company: 'Ecoval', email: 'c@e.test' }, 'https://site/?code=OM-AAAA-BB', 'OM-AAAA-BB');
  assert.equal(m.subject, 'Votre code d’accès OpenStudio');
  assert.match(m.text, /Votre code d’accès : OM-AAAA-BB/);
  assert.match(m.text, /https:\/\/site\/\?code=OM-AAAA-BB/);
  assert.match(m.text, /votre code reste inchangé/);
});

test('code oublié : envoyé à l’adresse de la fiche (majuscules ignorées), code inchangé', { skip }, async () => {
  let sent = null;
  const r = await access.sendForgottenCode('  claire@ecoval.TEST ', { send: async (m) => { sent = m; return { messageId: '1' }; } });
  assert.equal(r.sent, true);
  assert.equal(sent.to.email, 'Claire@Ecoval.test');
  assert.match(sent.text, new RegExp(code));
  assert.equal(await access.ensureCode(client.id), code, 'le code ne change pas');
  assert.deepEqual(await access.sendForgottenCode('inconnu@nulle.part', { send: async () => assert.fail('aucun envoi') }), { sent: false, reason: 'inconnu' });
});

test('route : même réponse pour une adresse connue ou non, e-mail invalide refusé, essais limités', { skip }, async () => {
  const post = (email) => fetch(`${base}/client/forgot-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const known = await (await post('claire@ecoval.test')).json();
  const unknown = await (await post('personne@nulle.part')).json();
  assert.deepEqual(known, unknown);
  assert.match(known.message, /Si cette adresse correspond/);
  assert.equal((await post('pas-un-mail')).status, 400);
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post('autre@nulle.part')).status);
  assert.ok(statuses.includes(429), 'au-delà de quelques demandes : 429');
});

test('Mon accès : le client connecté voit son code', { skip }, async () => {
  const token = await clients.openSession(client.id, 'test');
  const me = await (await fetch(`${base}/me`, { headers: { 'x-client-id': client.id, 'x-client-token': token } })).json();
  assert.equal(me.client.accessCode, code);
  assert.match(code, /^OM-[A-Z0-9]{4}-[A-Z0-9]{2}$/);
});

test('Factures : informations de facturation enregistrées sur la fiche, contrôlées', { skip }, async () => {
  const token = await clients.openSession(client.id, 'test');
  const h = { 'Content-Type': 'application/json', 'x-client-id': client.id, 'x-client-token': token };
  const post = (b) => fetch(`${base}/me/billing`, { method: 'POST', headers: h, body: JSON.stringify(b) });
  const ok = { company: 'Ecoval Industrie SAS', contact: 'Service comptable', email: 'Compta@Ecoval.test', address: '12 rue des Lilas', postalCode: '69003', city: 'Lyon', vat: 'fr 12 345678901', siret: '123 456 789 00012' };
  assert.equal((await post({ ...ok, email: 'x' })).status, 400);
  assert.match((await (await post({ ...ok, siret: '123' })).json()).error, /14 chiffres/);
  assert.equal((await post({ ...ok, city: '' })).status, 400);
  const r = await (await post(ok)).json();
  assert.equal(r.billing.email, 'compta@ecoval.test');
  assert.equal(r.billing.vat, 'FR12345678901');
  assert.equal(r.billing.siret, '12345678900012');
  assert.equal(r.billing.country, 'France');
  const me = await (await fetch(`${base}/me`, { headers: h })).json();
  assert.equal(me.client.billing.city, 'Lyon');
  assert.equal((await fetch(`${base}/me/billing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});
