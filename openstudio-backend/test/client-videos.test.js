'use strict';
/**
 * POST /api/me/videos — dépôt d'une vidéo depuis l'espace client (tests uniquement).
 * Base de données et stockage simulés : aucun accès réseau.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const clients = require('../src/clients');
const storage = require('../src/storage');
const routes = require('../src/routes');

const CLIENT = { id: '11111111-1111-4111-8111-111111111111', name: 'Client test', access_token: 'jeton' };
const KEY = 'uploads/2026-11-13/22222222-2222-4222-8222-222222222222/video.mp4';

// Simulations
const bucket = new Map();
const added = [];
clients.fromRequest = async (req) => (req.get('x-client-id') === CLIENT.id && req.get('x-client-token') === 'jeton' ? CLIENT : null);
clients.addVideo = async (clientId, v) => {
  const row = { id: '33333333-3333-4333-8333-333333333333', client_id: clientId, programme_id: v.programmeId, title: v.title, source_key: v.sourceKey, broadcast_date: v.broadcastDate || null };
  added.push(row);
  return row;
};
storage.head = async (key) => (bucket.has(key) ? { exists: true, ...bucket.get(key) } : { exists: false });

let base;
let server;
test.before(async () => {
  const app = express();
  app.use('/api', routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: String(err.message) }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());
test.beforeEach(() => {
  process.env.CLIENT_UPLOADS_ENABLED = 'true';
  bucket.clear();
  added.length = 0;
});

const session = { 'X-Client-Id': CLIENT.id, 'X-Client-Token': 'jeton' };
async function post(body, headers = session) {
  const r = await fetch(`${base}/me/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('dépôt client : refusé sans session client', async () => {
  bucket.set(KEY, { size: 1000, contentType: 'video/mp4' });
  const r = await post({ title: 'Ma vidéo', sourceKey: KEY }, {});
  assert.equal(r.status, 401);
  const bad = await post({ title: 'Ma vidéo', sourceKey: KEY }, { 'X-Client-Id': CLIENT.id, 'X-Client-Token': 'faux' });
  assert.equal(bad.status, 401);
  assert.equal(added.length, 0);
});

test('dépôt client : refusé si CLIENT_UPLOADS_ENABLED est désactivé', async () => {
  bucket.set(KEY, { size: 1000, contentType: 'video/mp4' });
  for (const v of [undefined, 'false', '']) {
    if (v === undefined) delete process.env.CLIENT_UPLOADS_ENABLED;
    else process.env.CLIENT_UPLOADS_ENABLED = v;
    const r = await post({ title: 'Ma vidéo', sourceKey: KEY });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /désactivé/);
  }
  assert.equal(added.length, 0);
});

test('dépôt client : refusé si le fichier n’existe pas dans le stockage', async () => {
  const r = await post({ title: 'Ma vidéo', sourceKey: KEY });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /introuvable/);
  assert.equal(added.length, 0);
});

test('dépôt client : refusé si ce n’est pas une vidéo ou pas une clé d’upload', async () => {
  bucket.set(KEY, { size: 1000, contentType: 'image/png' });
  assert.equal((await post({ title: 'X', sourceKey: KEY })).status, 400);
  // Un autre fichier du bucket (ex. livrable d'un autre client) ne peut pas être rattaché
  bucket.set('deliverables/autre/capsule.mp4', { size: 1000, contentType: 'video/mp4' });
  assert.equal((await post({ title: 'X', sourceKey: 'deliverables/autre/capsule.mp4' })).status, 400);
  assert.equal((await post({ title: 'X', sourceKey: KEY, programmeId: 'inconnue' })).status, 400);
  assert.equal(added.length, 0);
});

test('dépôt client : vidéo ajoutée au package (émission par défaut = première)', async () => {
  bucket.set(KEY, { size: 1000, contentType: 'video/mp4' });
  const r = await post({ title: '  Passage BFM  ', sourceKey: KEY });
  assert.equal(r.status, 201);
  assert.equal(added.length, 1);
  assert.equal(added[0].client_id, CLIENT.id);
  assert.equal(added[0].programme_id, 'bfm-business');
  assert.equal(r.body.video.title, 'Passage BFM');
  assert.equal(r.body.video.programmeId, 'bfm-business');

  const r2 = await post({ title: 'Immersion', sourceKey: KEY, programmeId: 'immersion', broadcastDate: '2026-11-01' });
  assert.equal(r2.status, 201);
  assert.equal(added[1].programme_id, 'immersion');
});

test('catalogue : indique si le dépôt client est actif', async () => {
  assert.equal((await (await fetch(`${base}/catalog`)).json()).clientUploads, true);
  process.env.CLIENT_UPLOADS_ENABLED = 'false';
  assert.equal((await (await fetch(`${base}/catalog`)).json()).clientUploads, false);
});
