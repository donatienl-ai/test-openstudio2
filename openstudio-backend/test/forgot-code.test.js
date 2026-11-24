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
  // Version mise en page (maquette « Code oublié »)
  for (const s of ['Voici votre code d’accès.', 'Bonjour Claire', 'OM-AAAA-BB', 'href="https://site/?code=OM-AAAA-BB"', 'Accéder à mon espace', 'votre code ne change pas', '/email/logo-openmedias.png']) assert.ok(m.html.includes(s), s);
  assert.doesNotMatch(m.html, /display:\s*(flex|grid)|position:\s*absolute|undefined/);
});

test('code oublié : rien avant l’ouverture de l’espace (envoi 1), puis envoyé à l’adresse de la fiche, code inchangé', { skip }, async () => {
  let sent = null;
  await db.query('UPDATE clients SET access_email_sent_at = NULL WHERE id = $1', [client.id]);
  const early = await access.sendForgottenCode('claire@ecoval.test', { send: async () => assert.fail('aucun envoi avant l’envoi 1') });
  assert.equal(early.sent, false);
  assert.match(early.reason, /pas encore ouvert/);
  await db.query('UPDATE clients SET access_email_sent_at = now() WHERE id = $1', [client.id]);
  const r = await access.sendForgottenCode('  claire@ecoval.TEST ', { send: async (m) => { sent = m; return { messageId: '1' }; } });
  assert.equal(r.sent, true);
  assert.equal(sent.to.email, 'Claire@Ecoval.test');
  assert.match(sent.text, new RegExp(code));
  assert.equal(await access.ensureCode(client.id), code, 'le code ne change pas');
  assert.deepEqual(await access.sendForgottenCode('inconnu@nulle.part', { send: async () => assert.fail('aucun envoi') }), { sent: false, reason: 'inconnu' });
  await db.query('UPDATE clients SET access_email_sent_at = NULL WHERE id = $1', [client.id]);
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

test('aperçu de l’e-mail du jour J : envoyé à l’équipe, données du client, rien ne change chez le client', { skip }, async () => {
  let sent = null;
  await db.query("UPDATE clients SET broadcast_date = '2099-05-01' WHERE id = $1", [client.id]);
  const before = (await db.query('SELECT access_email_sent_at, access_email_attempts FROM clients WHERE id = $1', [client.id])).rows[0];
  const r = await access.sendPreview(await clients.get(client.id), { email: 'lola@openmedias.test', name: 'Lola' }, { send: async (m) => { sent = m; return { messageId: '1' }; } });
  assert.equal(r.to, 'lola@openmedias.test');
  assert.deepEqual(sent.to, { email: 'lola@openmedias.test', name: 'Lola' });
  assert.equal(sent.subject, '[Aperçu] C’est le jour J : votre espace OpenStudio est ouvert', 'toujours la version du jour J');
  assert.ok(sent.html.includes(code), 'vrai code du client');
  assert.ok(sent.html.includes('Votre émission est diffusée aujourd’hui.'));
  const after = (await db.query('SELECT access_email_sent_at, access_email_attempts FROM clients WHERE id = $1', [client.id])).rows[0];
  assert.deepEqual(after, before, 'fiche du client inchangée');
});

test('e-mail du code envoyé par l’équipe : même code et même mise en page, sans « vous avez demandé »', () => {
  const m = access.forgotCodeEmail({ id: 'x', name: 'Claire Dumas', company: 'Ecoval', email: 'c@e.test' }, 'https://site/?code=OM-AAAA-BB', 'OM-AAAA-BB', { byTeam: true });
  assert.equal(m.subject, 'Votre code d’accès OpenStudio');
  for (const s of ['Voici votre code d’accès.', 'Bonjour Claire', 'OM-AAAA-BB', 'href="https://site/?code=OM-AAAA-BB"', 'Accéder à mon espace']) assert.ok(m.html.includes(s), s);
  assert.doesNotMatch(m.html + m.text, /avez demandé|pas à l’origine/);
  assert.match(m.text, /Votre code d’accès : OM-AAAA-BB/);
});

test('fiche client → « Envoyer le code au client » : refusé avant la diffusion ; ensuite l’e-mail du code, l’envoi 1 reste à faire', { skip }, async () => {
  let sent = null;
  await db.query("UPDATE clients SET broadcast_date = '2099-05-01', access_email_sent_at = NULL WHERE id = $1", [client.id]);
  await assert.rejects(access.sendCodeByEmail(await clients.get(client.id), { send: async () => assert.fail('aucun envoi') }), (e) => e.status === 409 && /s’ouvre le/.test(e.message));
  await db.query("UPDATE clients SET broadcast_date = '2020-01-15' WHERE id = $1", [client.id]);
  const r = await access.sendCodeByEmail(await clients.get(client.id), { send: async (m) => { sent = m; return { messageId: '2' }; } });
  assert.equal(r.sent, true);
  assert.equal(sent.subject, 'Votre code d’accès OpenStudio');
  assert.ok(sent.html.includes(code));
  const { rows } = await db.query('SELECT access_email_sent_at FROM clients WHERE id = $1', [client.id]);
  assert.equal(rows[0].access_email_sent_at, null, 'l’envoi 1 n’est pas marqué comme fait');
});

test('connexion : refusée avant le jour de la diffusion (message avec la date), possible ensuite ou sans date', { skip }, async () => {
  const login = () => fetch(`${base}/client/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  await db.query("UPDATE clients SET broadcast_date = '2099-05-01', access_email_sent_at = NULL WHERE id = $1", [client.id]);
  const early = await login();
  assert.equal(early.status, 403);
  const body = await early.json();
  assert.equal(body.code, 'pas_encore_ouvert');
  assert.equal(body.opensOn, '2099-05-01');
  assert.match(body.error, /s’ouvre le .*1 mai/);
  await db.query('UPDATE clients SET access_email_sent_at = now() WHERE id = $1', [client.id]);
  assert.equal((await login()).status, 200, 'envoi 1 parti : ouvert');
  await db.query("UPDATE clients SET broadcast_date = NULL, access_email_sent_at = NULL WHERE id = $1", [client.id]);
  assert.equal((await login()).status, 200, 'sans date de diffusion (compte interne) : ouvert');
});
