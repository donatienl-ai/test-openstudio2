'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/broadcastRules');
const tpl = require('../src/mail/templates');
const { createMailjet } = require('../src/mail/mailjet');

const TODAY = '2026-12-03';
const d = (o) => ({
  id: 'd1', planningId: 1, clientId: 'c1', state: 'active', dateDiffusion: TODAY, videoId: 'v1',
  clientEmail: 'claire@ecoval.fr', contactEmail: null, mailSentAt: null,
  clientMailed: false, alertJ2On: null, alertDayJOn: null, ...o,
});
const plan = (list, o = {}) => rules.planDay(list, { today: TODAY, hour: 9, sendHour: 8, ...o });

test('heure de Paris : date et heure locales, hiver comme été', () => {
  assert.deepEqual(rules.parisParts(new Date('2026-12-02T23:30:00Z')), { today: '2026-12-03', hour: 0 });
  assert.deepEqual(rules.parisParts(new Date('2026-07-01T22:30:00Z')), { today: '2026-07-02', hour: 0 });
});

test('jour J, tout est prêt : premier mail du client, à partir de 8 h seulement', () => {
  const p = plan([d()]);
  assert.equal(p.toSend.length, 1);
  assert.equal(p.toSend[0].kind, 'first');
  assert.equal(p.toSend[0].to, 'claire@ecoval.fr');
  assert.equal(plan([d()], { hour: 7 }).toSend.length, 0);
  assert.equal(plan([d()], { hour: 20 }).toSend.length, 0); // pas de mail client le soir
});

test('client déjà prévenu pour une autre diffusion : mail « nouvelle émission »', () => {
  assert.equal(plan([d({ clientMailed: true })]).toSend[0].kind, 'next');
});

test('destinataire : toujours l’e-mail du client (à défaut, le contact de la diffusion)', () => {
  assert.equal(rules.recipientOf(d({ contactEmail: 'autre@ecoval.fr' })), 'claire@ecoval.fr');
  assert.equal(rules.recipientOf(d({ clientEmail: null, contactEmail: 'bdc@ecoval.fr' })), 'bdc@ecoval.fr');
  assert.equal(rules.recipientOf(d({ clientEmail: null })), null);
});

test('jour J incomplet : pas de mail, alerte équipe une seule fois', () => {
  const p = plan([d({ videoId: null })]);
  assert.equal(p.toSend.length, 0);
  assert.equal(p.blocked[0].missing, 'vidéo');
  assert.equal(plan([d({ videoId: null, clientEmail: null })]).blocked[0].missing, 'vidéo et e-mail du client');
  assert.equal(plan([d({ videoId: null, alertDayJOn: TODAY })]).blocked.length, 0);
});

test('vidéo arrivée en retard : le mail part encore jusqu’à 7 jours après', () => {
  assert.equal(plan([d({ dateDiffusion: '2026-11-28' })]).toSend.length, 1);
  assert.equal(plan([d({ dateDiffusion: '2026-11-25' })]).toSend.length, 0);
});

test('J-2 et J-1 incomplets : alerte équipe ; J-3 : rien encore', () => {
  const p = plan([d({ id: 'a', dateDiffusion: '2026-12-05', videoId: null }), d({ id: 'b', dateDiffusion: '2026-12-04', clientEmail: null }), d({ id: 'c', dateDiffusion: '2026-12-06', videoId: null })]);
  assert.deepEqual(p.upcoming.map((x) => x.id), ['a', 'b']);
  assert.equal(p.toSend.length, 0);
  assert.equal(plan([d({ dateDiffusion: '2026-12-05', videoId: null, alertJ2On: '2026-12-03' })]).upcoming.length, 0);
});

test('jamais deux mails : déjà envoyé, annulée, date à fixer, deux diffusions du client le même jour', () => {
  assert.equal(plan([d({ mailSentAt: new Date() })]).toSend.length, 0);
  assert.equal(plan([d({ state: 'cancelled' })]).toSend.length, 0);
  assert.equal(plan([d({ state: 'date_pending' })]).toSend.length, 0);
  assert.equal(plan([d({ id: 'a' }), d({ id: 'b', planningId: 2 })]).toSend.length, 1);
});

test('contenu du premier mail : code, arguments, expiration des crédits, sans la vidéo', () => {
  const m = tpl.diffusionFirst({ prenom: 'Claire', nom_emission: 'BFM Business', code: 'OM-7KX4-M9', lien: 'https://openstudio.fr', date_expiration: tpl.dateFr(tpl.addDays('2026-12-03', 30)) });
  assert.equal(m.subject, 'Votre émission est diffusée aujourd’hui');
  for (const s of ['Bonjour Claire', 'OM-7KX4-M9', 'BFM Business', 'https://openstudio.fr', '2 janvier 2027']) assert.ok(m.text.includes(s), s);
  assert.ok(m.html.includes('OM-7KX4-M9'));
  assert.ok(!/vidéo vous attend|télécharg/i.test(m.text)); // la vidéo n'est pas dans le mail
  assert.ok(!tpl.diffusionFirst({ prenom: '<b>', code: 'x' }).html.includes('<b>,')); // caractères échappés
  assert.equal(tpl.firstName('Claire Dumas'), 'Claire');
  assert.ok(tpl.diffusionNext({ nom_emission: 'Capital' }).text.startsWith('Bonjour,'));
});

test('Mailjet : redirection vers l’adresse de test, refus sans configuration', async () => {
  let sent;
  const fetchImpl = async (url, o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ Messages: [{ Status: 'success', To: [{ MessageID: 42 }] }] }) }; };
  const mj = createMailjet({ apiKey: 'k', secretKey: 's', fromEmail: 'communication@openmedias.fr', redirectTo: 'test@openmedias.fr', fetchImpl });
  const r = await mj.send({ to: { email: 'claire@ecoval.fr' }, fallback: { subject: 'Sujet', html: '<p>x</p>', text: 'x' } });
  assert.equal(r.messageId, '42');
  assert.equal(sent.Messages[0].To[0].Email, 'test@openmedias.fr');
  assert.match(sent.Messages[0].Subject, /^\[TEST\] Sujet \(pour claire@ecoval\.fr\)$/);
  const tplMsg = mj.build({ to: { email: 'a@b.fr' }, templateId: '123', variables: { code: 'OM' } });
  assert.equal(tplMsg.TemplateID, 123);
  assert.equal(tplMsg.Variables.original_recipient, 'a@b.fr');
  await assert.rejects(createMailjet({ apiKey: 'k', secretKey: 's', fromEmail: 'x@y.fr', fetchImpl }).send({ to: { email: 'a@b.fr' }, fallback: {} }), /Envoi réel désactivé/);
  await assert.rejects(createMailjet({}).send({ to: { email: 'a@b.fr' } }), /non configuré/);
});
