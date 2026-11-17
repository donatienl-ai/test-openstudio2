'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rules = require('../src/drive/rules');
const { createDrive, parseCredentials, signedAssertion, FOLDER } = require('../src/drive/google');

test('nom du dossier : date, média, format ; « date à fixer » si la date n’est pas calée', () => {
  const d = { state: 'active', dateDiffusion: '2026-12-03', media: 'BFM Business 1&2', format: 'Plateau TV' };
  assert.equal(rules.diffusionFolderName(d), '2026-12-03 – BFM Business 1&2 – Plateau TV');
  assert.equal(rules.diffusionFolderName({ ...d, state: 'date_pending' }), 'date à fixer – BFM Business 1&2 – Plateau TV');
  assert.equal(rules.diffusionFolderName({ ...d, media: 'Médias spécialisés', sousMedia: 'Cnews', format: 'Immersion' }), '2026-12-03 – Médias spécialisés Cnews – Immersion');
  assert.equal(rules.clientFolderName('A/B Conseil'), 'A-B Conseil');
});

test('dossier rangé dans « Annulées » seulement si la diffusion est annulée', () => {
  assert.equal(rules.expectedParent({ state: 'cancelled' }), 'cancelled');
  assert.equal(rules.expectedParent({ state: 'active' }), 'client');
  assert.equal(rules.expectedParent({ state: 'date_pending' }), 'client');
});

test('émission OpenStudio déduite du média du planning', () => {
  assert.equal(rules.programmeFor('BFM Business 1&2'), 'bfm-business');
  assert.equal(rules.programmeFor('BFMTV'), 'bfm');
  assert.equal(rules.programmeFor('Capital'), 'capital');
  assert.equal(rules.programmeFor('Le Figaro HP + HP Eco'), 'le-figaro-hp-hp-eco');
});

test('vidéo à importer : la plus récente, non vide, plus modifiée depuis 2 minutes', () => {
  const now = Date.parse('2026-12-01T12:00:00Z');
  const f = (name, min, o = {}) => ({ id: name, name, mimeType: 'video/mp4', size: '1000', modifiedTime: new Date(now - min * 60000).toISOString(), ...o });
  assert.equal(rules.pickVideo([f('a.mp4', 30), f('b.mp4', 10)], { now }).id, 'b.mp4');
  assert.equal(rules.pickVideo([f('en-cours.mp4', 1)], { now }), null); // encore en cours d'envoi
  assert.equal(rules.pickVideo([f('vide.mp4', 10, { size: '0' })], { now }), null);
  assert.equal(rules.pickVideo([f('notes.pdf', 10, { mimeType: 'application/pdf' })], { now }), null);
  assert.equal(rules.pickVideo([f('export.mov', 10, { mimeType: 'application/octet-stream' })], { now }).id, 'export.mov');
  assert.equal(rules.pickVideo([], { now }), null);
});

// --- Client Google Drive avec un faux serveur -------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  client_email: 'openstudio@projet.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});

test('clé du compte de service : JSON invalide ou incomplet refusé clairement', () => {
  assert.throws(() => parseCredentials('{pas du json'), /illisible/);
  assert.throws(() => parseCredentials('{}'), /incomplet/);
});

test('assertion JWT signée avec la clé du compte de service', () => {
  const jwt = signedAssertion(parseCredentials(KEY_JSON), 1000);
  const [h, c, sig] = jwt.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.iss, 'openstudio@projet.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive');
  assert.equal(claims.exp, 4600);
});

function fakeGoogle() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push({ method: opts.method || 'GET', url: u, body: opts.body, headers: opts.headers || {} });
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'jeton', expires_in: 3600 });
    if (u.searchParams.get('alt') === 'media') return { ok: true, status: 200, body: new Blob(['VIDEO']).stream() };
    if (opts.method === 'POST') return json({ id: 'nouveau', ...JSON.parse(opts.body) });
    if (opts.method === 'PATCH') return json({ id: 'dossier', name: JSON.parse(opts.body).name });
    if (u.pathname === '/drive/v3/files') return json({ files: [{ id: 'f1', name: 'v.mp4' }] });
    return json({ error: { message: 'inconnu' } }, 404);
  };
  return { calls, drive: createDrive({ credentialsJson: KEY_JSON, fetchImpl }) };
}

test('Drive : un seul jeton pour plusieurs appels, Drive partagé pris en charge', async () => {
  const { calls, drive } = fakeGoogle();
  await drive.listFiles('dossier');
  await drive.listFiles('dossier');
  assert.equal(calls.filter((c) => c.url.hostname === 'oauth2.googleapis.com').length, 1);
  const list = calls.find((c) => c.url.pathname === '/drive/v3/files');
  assert.equal(list.headers.Authorization, 'Bearer jeton');
  assert.equal(list.url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(list.url.searchParams.get('includeItemsFromAllDrives'), 'true');
  assert.match(list.url.searchParams.get('q'), /^'dossier' in parents and trashed = false/);
});

test('Drive : dossier créé avec son étiquette OpenStudio, recherche et déplacement', async () => {
  const { calls, drive } = fakeGoogle();
  const f = await drive.createFolder('2026-12-03 – Capital – Immersion', 'client1', { openstudioDiffusion: '42' });
  assert.equal(f.mimeType, FOLDER);
  assert.deepEqual(f.parents, ['client1']);
  assert.deepEqual(f.appProperties, { openstudioDiffusion: '42' });
  await drive.findFolderByProperty('openstudioDiffusion', "4'2");
  assert.match(calls.at(-1).url.searchParams.get('q'), /key='openstudioDiffusion' and value='4\\'2'/);
  await drive.updateFolder('dossier', { name: 'Nouveau nom', addParent: 'annulees', removeParent: 'client1' });
  const patch = calls.at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url.searchParams.get('addParents'), 'annulees');
  assert.equal(patch.url.searchParams.get('removeParents'), 'client1');
});

test('Drive : téléchargement en flux vers un fichier local', async () => {
  const { drive } = fakeGoogle();
  const tmp = path.join(os.tmpdir(), `drive-test-${process.pid}.mp4`);
  await drive.downloadToFile('f1', tmp);
  assert.equal(fs.readFileSync(tmp, 'utf8'), 'VIDEO');
  fs.rmSync(tmp);
});
