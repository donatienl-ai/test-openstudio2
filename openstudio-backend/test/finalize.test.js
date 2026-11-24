'use strict';
/**
 * Livraison d'une commande « capsules » : vrais clips vidéo et vrai ffmpeg (logos incrustés),
 * OpusClip, stockage et base simulés. Vérifie que le type choisi par le client (capsules ou
 * teaser) donne le bon contenu : nombre de vidéos, noms de fichiers, durée demandée.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const storage = require('../src/storage');
const orders = require('../src/orders');
const clients = require('../src/clients');
const opus = require('../src/opusclip/client');
const pipeline = require('../src/pipeline');
const { normalizeOptions } = require('../src/opusclip/payload');
const mapping = require('../src/opusclip.config');
// Habillage (ouverture + fin en fondu) compris dans la durée choisie : l'extrait est raccourci de 2 s + 2 s − 2 × 0,5 s
const B = require('../src/opusclip.config').bumpers;
const HABILLAGE_MS = B && B.enabled ? Math.round((B.introSec + B.outroSec - 2 * B.fadeSec) * 1000) : 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-test-'));
const CLIP = path.join(tmp, 'clip.mp4');
const LOGO = path.join(tmp, 'logo.png');
const video = { id: 'v1', title: 'Passage', programme_id: 'bfm-business', source_key: 'uploads/x/video.mp4' };

let delivered = [];
let status = null;

test.before(() => {
  // Vrai clip de 36 s (son compris) : plus long que toutes les durées cibles, pour vérifier la coupe exacte
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=10:duration=36', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=36', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', CLIP], { stdio: 'ignore' });
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=120x40', '-frames:v', '1', LOGO], { stdio: 'ignore' });
  // OpusClip propose 5 clips de durées variées (comme sur un vrai projet : 19 s, 17,7 s…), avec un score
  opus.getExportableClips = async () => [
    { id: 'c1', title: 'Moment 1', score: 50, uriForExport: 'https://clips.example/c1.mp4', durationMs: 17720 },
    { id: 'c2', title: 'Moment 2', score: 70, uriForExport: 'https://clips.example/c2.mp4', durationMs: 19040 },
    { id: 'c3', title: 'Moment 3', score: 90, uriForExport: 'https://clips.example/c3.mp4', durationMs: 15480 },
    { id: 'c4', title: 'Moment 4', score: 95, uriForExport: 'https://clips.example/c4.mp4', durationMs: 9000 }, // trop court
    { id: 'c5', title: 'Moment 5', score: 10, uriForExport: 'https://clips.example/c5.mp4', durationMs: 35000 },
  ];
  global.fetch = async () => new Response(fs.readFileSync(CLIP), { status: 200 });
  storage.downloadToFile = async (key, dest) => fs.copyFileSync(LOGO, dest);
  storage.uploadFile = async (key, file) => fs.statSync(file).size;
  clients.get = async () => ({ id: 'c', logo_key: 'clients/c/logo.png' });
  orders.existingClipIds = async () => new Set();
  orders.addDeliverable = async (d) => { delivered.push(d); };
  orders.setStatus = async (id, s) => { status = s; };
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test.beforeEach(() => { delivered = []; status = null; });

const orderFor = (choice) => ({
  id: 'abcdef12-0000-4000-8000-000000000000',
  type: 'capsules',
  client_id: 'c',
  opus_project_id: 'P1',
  options: normalizeOptions('capsules', { videoId: 'v1', format: 'Vertical 9:16', ...choice }, mapping, { video }),
});

test('livraison « Capsules » (15 s) : 3 capsules, les mieux classées, nommées « capsule »', async () => {
  await pipeline.finalize(orderFor({ kind: 'capsules', duration: '15 s' }));
  assert.equal(status, 'ready');
  assert.deepEqual(delivered.map((d) => d.fileName), [
    'bfm-business_capsule-01_15s_9x16.mp4',
    'bfm-business_capsule-02_15s_9x16.mp4',
    'bfm-business_capsule-03_15s_9x16.mp4',
  ]);
  // c4 (9 s) est écarté malgré son score : trop court pour 15 s
  assert.deepEqual(delivered.map((d) => d.title), ['Moment 3', 'Moment 2', 'Moment 1']);
  // Durée réelle des fichiers livrés : exactement 15 s (et non 15,5 / 17,7 / 19 s)
  for (const d of delivered) assert.ok(Math.abs(d.durationMs - 15000) <= 100, `${d.fileName} : ${d.durationMs} ms`);
  assert.ok(delivered.every((d) => d.storageKey.startsWith('commandes/abcdef12-0000-4000-8000-000000000000/')));
});

test('livraison « Teaser » : une seule vidéo de 15 s, la mieux classée, nommée « teaser »', async () => {
  await pipeline.finalize(orderFor({ kind: 'teaser', duration: '30 s' }));
  assert.equal(status, 'ready');
  assert.deepEqual(delivered.map((d) => d.fileName), ['bfm-business_teaser_15s_9x16.mp4']);
  assert.equal(delivered[0].title, 'Moment 3');
  assert.ok(Math.abs(delivered[0].durationMs - 15000) <= 100, `${delivered[0].durationMs} ms`);
});

test('livraison « Capsules » 30 s : seuls les extraits assez longs, coupés à 30 s exactement', async () => {
  await pipeline.finalize(orderFor({ kind: 'capsules', duration: '30 s' }));
  // Seul c5 (35 s) atteint 30 s ; les autres (≤ 19 s) sont écartés
  assert.deepEqual(delivered.map((d) => d.title), ['Moment 5']);
  assert.ok(Math.abs(delivered[0].durationMs - 30000) <= 100, `${delivered[0].durationMs} ms`);
});

test('livraison : aucun extrait assez long → erreur explicite, rien de livré', async () => {
  await assert.rejects(pipeline.finalize(orderFor({ kind: 'capsules', duration: '60 s' })), /Aucun extrait OpusClip d'au moins 57 s/);
  assert.equal(delivered.length, 0);
});

test('sélection par durée : extraits longs d\'abord, courts (à 1 s près) en complément', () => {
  const { pickClipsForDuration } = require('../src/pipeline');
  const c = (id, ms) => ({ id, durationMs: ms });
  const { long, short } = pickClipsForDuration([c('a', 14500), c('b', 15000), c('c', 13000), c('d', 21000), c('e', undefined)], 15, 1);
  assert.deepEqual(long.map((x) => x.id), ['b', 'd', 'e']);
  assert.deepEqual(short.map((x) => x.id), ['a']);
});
