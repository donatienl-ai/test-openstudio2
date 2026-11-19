'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const importer = require('../src/admin/client-import');
const mailer = require('../src/mailer');

/* ---------------------------------------------------------------- Dates */

test('dates : formats français et ISO acceptés', () => {
  assert.equal(importer.parseDate('12/01/2027'), '2027-01-12');
  assert.equal(importer.parseDate('2/1/27'), '2027-01-02');
  assert.equal(importer.parseDate('12.01.2027'), '2027-01-12');
  assert.equal(importer.parseDate('2027-01-12'), '2027-01-12');
  assert.equal(importer.parseDate(''), null);
  assert.equal(importer.parseDate('  '), null);
});

test('dates : dates impossibles refusées', () => {
  assert.equal(importer.parseDate('31/02/2027'), false);
  assert.equal(importer.parseDate('12/13/2027'), false);
  assert.equal(importer.parseDate('demain'), false);
});

/* ---------------------------------------------------------------- CSV */

test('CSV : séparateur ; (Excel français), guillemets et retours à la ligne', () => {
  const rows = importer.parseCsv('﻿nom;entreprise;notes\r\n"Dupont; Marie";Ecoval;"ligne 1\nligne 2"\r\n;;\r\n');
  assert.deepEqual(rows, [['nom', 'entreprise', 'notes'], ['Dupont; Marie', 'Ecoval', 'ligne 1\nligne 2']]);
});

test('CSV : séparateur , et guillemets doublés', () => {
  const rows = importer.parseCsv('nom,notes\nMarie,"elle a dit ""oui"""');
  assert.deepEqual(rows[1], ['Marie', 'elle a dit "oui"']);
});

test('import : colonnes reconnues malgré majuscules et accents, problèmes ligne par ligne', () => {
  const csv = [
    'Nom;Société;E-mail;Date de diffusion;Formule',
    'Marie Dupont;Ecoval;Marie@Ecoval.fr;12/01/2027;BFM Business',
    'Paul Martin;Atelier;pas-un-mail;12/01/2027;',
    ';Boulangerie Durand;contact@durand.fr;31/02/2027;',
    'Jeanne;Studio J;marie@ecoval.fr;;',
    'Luc;Garage;deja@client.fr;15/01/2027;',
    'Sans mail;Sans mail SARL;;;',
  ].join('\n');
  const r = importer.analyse(csv, { existingEmails: new Set(['deja@client.fr']) });
  assert.deepEqual(r.columns.sort(), ['broadcastDate', 'company', 'email', 'name', 'packageLabel']);
  const byLine = Object.fromEntries(r.rows.map((x) => [x.line, x]));
  assert.deepEqual(byLine[2].problems, []);
  assert.equal(byLine[2].client.email, 'marie@ecoval.fr', 'e-mail en minuscules');
  assert.equal(byLine[2].client.broadcastDate, '2027-01-12');
  assert.equal(byLine[2].client.packageLabel, 'BFM Business');
  assert.deepEqual(byLine[3].problems, ['e-mail invalide']);
  assert.equal(byLine[4].client.name, 'Boulangerie Durand', 'nom manquant : celui de l’entreprise est repris');
  assert.match(byLine[4].problems.join(), /date illisible/);
  assert.deepEqual(byLine[5].problems, ['en double dans le fichier']);
  assert.deepEqual(byLine[6].problems, ['déjà présent dans le back-office']);
  assert.deepEqual(byLine[7].problems, []);
  assert.equal(byLine[7].warnings.length, 2, 'sans e-mail ni date : deux avertissements');
  assert.equal(r.ready, 2);
  assert.equal(r.rejected, 4);
});

test('import : fichier sans colonne nom ni entreprise refusé', () => {
  assert.match(importer.analyse('email;date\na@b.fr;12/01/2027').error, /nom/);
  assert.match(importer.analyse('').error, /vide/);
});

/* ---------------------------------------------------------------- E-mails */

const CFG = {
  apiKey: 'k', secretKey: 's', fromEmail: 'communication@openmedias.fr', fromName: 'OpenMedias',
  redirectTo: '', allowRealRecipients: true, apiUrl: 'https://mailjet.test/send', sandbox: false,
};
const MSG = { to: { email: 'marie@ecoval.fr', name: 'Marie' }, subject: 'Votre espace', text: 'Bonjour <Marie>', customId: 'x' };

test('e-mail : envoi réel vers le client, texte échappé dans la version HTML', () => {
  const m = mailer.buildMessage(MSG, CFG);
  assert.deepEqual(m.To, [{ Email: 'marie@ecoval.fr', Name: 'Marie' }]);
  assert.equal(m.From.Email, 'communication@openmedias.fr');
  assert.equal(m.Subject, 'Votre espace');
  assert.match(m.HTMLPart, /Bonjour &lt;Marie&gt;/);
});

test('e-mail : en test, tout part vers l’adresse de redirection, sujet marqué', () => {
  const m = mailer.buildMessage(MSG, { ...CFG, redirectTo: 'moi@openmedias.fr', allowRealRecipients: false });
  assert.equal(m.To[0].Email, 'moi@openmedias.fr');
  assert.match(m.Subject, /^\[TEST\] Votre espace \(pour marie@ecoval\.fr\)$/);
  assert.equal(m.Variables.destinataire_reel, 'marie@ecoval.fr');
});

test('e-mail : modèle Mailjet utilisé quand il est configuré', () => {
  const m = mailer.buildMessage({ ...MSG, templateId: 123, variables: { lien: 'https://x' } }, CFG);
  assert.equal(m.TemplateID, 123);
  assert.equal(m.TemplateLanguage, true);
  assert.equal(m.Variables.lien, 'https://x');
  assert.equal(m.Subject, undefined);
});

test('e-mail : aucun envoi sans configuration ni sans redirection ou autorisation', async () => {
  assert.match(mailer.problem({ ...CFG, apiKey: '' }), /non configuré/);
  assert.match(mailer.problem({ ...CFG, allowRealRecipients: false }), /MAIL_REDIRECT_TO/);
  await assert.rejects(mailer.send(MSG, { cfg: { ...CFG, allowRealRecipients: false }, fetchImpl: () => assert.fail('aucun appel') }), /MAIL_REDIRECT_TO/);
});

test('e-mail : réponse Mailjet en succès, puis erreur explicite', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ Messages: [{ Status: 'success', To: [{ MessageID: 42 }] }] }) });
  assert.deepEqual(await mailer.send(MSG, { cfg: CFG, fetchImpl: ok }), { messageId: '42', redirectedTo: null });
  const ko = async () => ({ ok: false, status: 400, json: async () => ({ Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'adresse refusée' }] }] }) });
  await assert.rejects(mailer.send(MSG, { cfg: CFG, fetchImpl: ko, retries: 0 }), /adresse refusée/);
});

test('import : colonne marketing (oui / non), réponse illisible signalée', () => {
  assert.equal(importer.parseYesNo('Oui'), true);
  assert.equal(importer.parseYesNo('x'), true);
  assert.equal(importer.parseYesNo('NON'), false);
  assert.equal(importer.parseYesNo(''), null);
  assert.equal(importer.parseYesNo('peut-être'), undefined);
  const r = importer.analyse('nom;email;marketing\nA;a@a.fr;oui\nB;b@b.fr;\nC;c@c.fr;bof');
  assert.equal(r.rows[0].client.marketingOptin, true);
  assert.equal(r.rows[0].client.marketingOptinSource, 'Import CSV');
  assert.equal(r.rows[1].client.marketingOptin, null);
  assert.deepEqual(r.rows[2].problems, ['marketing : indiquez oui ou non']);
});
