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
