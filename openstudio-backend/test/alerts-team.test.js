'use strict';
/** Destinataires des alertes (back-office) et équipe : rôle modifiable, identifiant obligatoire. */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.DATABASE_SSL = 'false';
}
process.env.TEAM_ALERT_EMAIL = 'communication@openmedias.test, equipe@openmedias.test';
process.env.ACCOUNTING_EMAIL = '';
const skip = !DB && 'TEST_DATABASE_URL non défini';

const mailer = require('../src/mailer');
const alerts = require('../src/admin/alerts');
const db = require('../src/db');

test('e-mail à plusieurs destinataires ; en mode test, un seul envoi redirigé', () => {
  const cfg = { fromEmail: 'a@b.c', fromName: 'OM', redirectTo: '', allowRealRecipients: true };
  const m = mailer.buildMessage({ to: [{ email: 'x@om.test' }, { email: 'y@om.test' }], subject: 'S', text: 'T' }, cfg);
  assert.deepEqual(m.To, [{ Email: 'x@om.test' }, { Email: 'y@om.test' }]);
  const r = mailer.buildMessage({ to: [{ email: 'x@om.test' }, { email: 'y@om.test' }], subject: 'S', text: 'T' }, { ...cfg, redirectTo: 'moi@om.test' });
  assert.deepEqual(r.To, [{ Email: 'moi@om.test', Name: 'Test OpenStudio' }]);
  assert.match(r.Subject, /\[TEST\] S \(pour x@om\.test, y@om\.test\)/);
  assert.deepEqual(mailer.buildMessage({ to: { email: 'z@om.test', name: 'Z' }, subject: 'S', text: 'T' }, cfg).To, [{ Email: 'z@om.test', Name: 'Z' }]);
});

test('alertes : contrôle des adresses', () => {
  assert.match(alerts.validate({ compta: ['pas-un-mail'] }).error, /invalide/);
  assert.deepEqual(alerts.validate({ compta: [' A@OM.test ', 'a@om.test'] }).value.compta, ['a@om.test']);
  assert.match(alerts.validate({ compta: Array.from({ length: 11 }, (_, i) => `p${i}@om.test`) }).error, /10 destinataires/);
});

test.before(async () => {
  if (skip) return;
  if (!/test/i.test(DB)) throw new Error('TEST_DATABASE_URL doit désigner une base de test');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
});
test.after(async () => { if (!skip) await db.pool.end(); });

test('alertes : variables d’environnement par défaut, puis réglages du back-office (liste vide possible)', { skip }, async () => {
  assert.deepEqual(await alerts.recipients('diffusions'), ['communication@openmedias.test', 'equipe@openmedias.test']);
  assert.deepEqual(await alerts.recipients('compta'), ['communication@openmedias.test', 'equipe@openmedias.test'], 'compta : TEAM_ALERT_EMAIL à défaut');
  const r = await alerts.save({ compta: ['compta@openmedias.test'], erreurs: [] }, 'Lola');
  assert.deepEqual(r.value.types.find((t) => t.id === 'compta').recipients, ['compta@openmedias.test']);
  assert.deepEqual(await alerts.recipients('compta'), ['compta@openmedias.test']);
  assert.deepEqual(await alerts.recipients('erreurs'), [], 'liste vidée : personne');
  assert.equal((await alerts.list()).types.find((t) => t.id === 'diffusions').fromEnv, true, 'non modifiée : toujours la variable');
  await alerts.save({ diffusions: ['a@om.test'] }, 'Lola');
  assert.deepEqual(await alerts.recipients('compta'), ['compta@openmedias.test'], 'les autres alertes sont conservées');
});

test('équipe : rôle modifiable, toujours un super admin', { skip }, async () => {
  const accounts = require('../src/admin/accounts');
  const a = await accounts.createUser({ email: 'lola@openmedias.test', name: 'Lola', username: 'lola', role: 'super_admin' });
  await db.query('UPDATE admin_users SET active = true WHERE id = $1', [a.user.id]);
  const b = await accounts.createUser({ email: 'julien@openmedias.test', name: 'Julien', username: 'julien' });
  assert.equal(b.user.role, 'admin');
  await assert.rejects(accounts.setRole(a.user.id, 'admin'), /au moins un super admin/);
  assert.equal((await accounts.setRole(b.user.id, 'super_admin')).role, 'super_admin');
  await db.query('UPDATE admin_users SET active = true WHERE id = $1', [b.user.id]);
  assert.equal((await accounts.setRole(a.user.id, 'admin')).role, 'admin', 'possible dès qu’un autre super admin existe');
  await assert.rejects(accounts.setRole(b.user.id, 'roi'), /Rôle inconnu/);
});

test('e-mails automatiques : liste complète, pause et réactivation, chaque envoi automatique respecte la pause', { skip }, async () => {
  const emails = require('../src/emails/settings');
  const l = await emails.list();
  assert.deepEqual(l.emails.map((e) => e.id), ['acces', 'code_oublie', 'recharge', 'diffusions', 'compta', 'erreurs']);
  assert.ok(l.emails.every((e) => e.enabled), 'tous actifs par défaut');
  assert.deepEqual(l.emails.find((e) => e.id === 'compta').recipients, ['compta@openmedias.test'], 'destinataires des alertes affichés');
  assert.match((await emails.save(['inconnu'])).error, /inconnu/);
  await emails.save(['acces', 'code_oublie', 'diffusions', 'compta'], 'Lola');
  assert.equal(await emails.isEnabled('acces'), false);
  assert.equal(await emails.isEnabled('recharge'), true);
  // Envoi automatique du code : rien ne part
  const access = require('../src/admin/client-access');
  let sent = 0;
  const r = await access.runScheduled({ now: new Date('2026-11-24T10:00:00Z'), send: async () => { sent += 1; return {}; } });
  assert.match(String(r.skipped), /en pause/);
  assert.equal(sent, 0);
  // Code oublié : rien ne part
  const clients = require('../src/clients');
  const paul = await clients.create({ name: 'Paul', company: 'P', email: 'paul@client.test' });
  await db.query('UPDATE clients SET access_email_sent_at = now() WHERE id = $1', [paul.id]); // espace ouvert (envoi 1 parti)
  assert.match((await access.sendForgottenCode('paul@client.test', { send: async () => { sent += 1; return {}; } })).reason, /en pause/);
  // Compta : rien ne part
  assert.equal((await require('../src/montage/notify').notifyAccounting('00000000-0000-4000-8000-000000000000')).reason, 'en pause');
  assert.equal(sent, 0);
  await emails.save([], 'Lola');
  assert.equal(await emails.isEnabled('acces'), true, 'réactivé');
});

test('e-mails de test : chacun des 6 e-mails, données d’exemple, à la personne connectée, même en pause', { skip }, async () => {
  const emails = require('../src/emails/settings');
  const samples = require('../src/emails/samples');
  await emails.save(emails.IDS, 'Lola'); // tout en pause
  const got = [];
  for (const id of emails.IDS) {
    const r = await samples.sendTest(id, { email: 'lola@openmedias.test', name: 'Lola' }, { send: async (m) => { got.push(m); return { messageId: '1' }; } });
    assert.equal(r.to, 'lola@openmedias.test');
  }
  assert.equal(got.length, 6);
  for (const m of got) {
    assert.deepEqual(m.to, { email: 'lola@openmedias.test', name: 'Lola' });
    assert.match(m.subject, /^\[Test\] /);
    assert.doesNotMatch(m.text, /undefined|null|NaN/);
  }
  assert.ok(got[0].html.includes('OM-7KX4-M9'), 'envoi 1 : version mise en page');
  await assert.rejects(samples.sendTest('inconnu', { email: 'x@om.test' }, { send: async () => ({}) }), /inconnu/);
  await emails.save([], 'Lola');
});

test('mode test : plusieurs adresses reçoivent tous les e-mails, réglables dans le back-office', { skip }, async () => {
  const config = require('../src/config');
  const redirect = require('../src/emails/redirect');
  const allow = config.mail.allowRealRecipients;
  config.mail.allowRealRecipients = false;
  try {
    assert.match((await redirect.save([])).error, /au moins une adresse/, 'jamais zéro adresse si l’envoi réel est interdit');
    assert.match((await redirect.save(['pas-un-mail'])).error, /invalide/);
    assert.match((await redirect.save(['lola@openmedias.fr', 'lola@gmail.com'])).error, /@openmedias\.fr.*lola@gmail\.com/, 'garde-fou : adresses de l’équipe uniquement');
    assert.match((await redirect.save(['lola@openmedias.fr.pirate.com'])).error, /@openmedias\.fr/);
    assert.ok(redirect.isTestAddress('Julien@OpenMedias.fr') && !redirect.isTestAddress('julien@openmedias.fr.test') && !redirect.isTestAddress('client@vrai.test'));
    const r = await redirect.save(['Lola@OpenMedias.fr', 'julien@openmedias.fr', 'lola@openmedias.fr'], 'Lola');
    assert.deepEqual(r.value.list, ['lola@openmedias.fr', 'julien@openmedias.fr']);
    assert.equal(r.value.mode, 'test');
    assert.equal(config.mail.redirectTo, 'lola@openmedias.fr, julien@openmedias.fr', 'appliqué tout de suite aux envois');
    const m = mailer.buildMessage({ to: { email: 'client@vrai.test' }, subject: 'Votre code', text: 'T' }, { fromEmail: 'a@b.c', fromName: 'OM', redirectTo: config.mail.redirectTo });
    assert.deepEqual(m.To.map((t) => t.Email), ['lola@openmedias.fr', 'julien@openmedias.fr']);
    assert.match(m.Subject, /^\[TEST\] Votre code \(pour client@vrai\.test\)$/);
    // Relu au démarrage du serveur
    config.mail.redirectTo = '';
    await redirect.load();
    assert.equal(config.mail.redirectTo, 'lola@openmedias.fr, julien@openmedias.fr');
    // Envoi réel autorisé : liste vide = vrais destinataires
    config.mail.allowRealRecipients = true;
    assert.equal((await redirect.save([], 'Lola')).value.mode, 'reel');
    assert.equal(config.mail.redirectTo, '');
  } finally {
    config.mail.allowRealRecipients = allow;
  }
});
