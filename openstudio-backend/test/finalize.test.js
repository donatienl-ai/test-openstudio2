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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-test-'));
const CLIP = path.join(tmp, 'clip.mp4');
const LOGO = path.join(tmp, 'logo.png');
const video = { id: 'v1', title: 'Passage', programme_id: 'bfm-business', source_key: 'uploads/x/video.mp4' };

let delivered = [];
let status = null;

test.before(() => {
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=25:duration=1', '-pix_fmt', 'yuv420p', CLIP], { stdio: 'ignore' });
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=120x40', '-frames:v', '1', LOGO], { stdio: 'ignore' });
  // OpusClip propose 4 clips, avec un score : le mieux classé est « c3 »
  opus.getExportableClips = async () => [
    { id: 'c1', title: 'Moment 1', score: 50, uriForExport: 'https://clips.example/c1.mp4', durationMs: 15000 },
    { id: 'c2', title: 'Moment 2', score: 70, uriForExport: 'https://clips.example/c2.mp4', durationMs: 15000 },
    { id: 'c3', title: 'Moment 3', score: 90, uriForExport: 'https://clips.example/c3.mp4', durationMs: 15000 },
    { id: 'c4', title: 'Moment 4', score: 10, uriForExport: 'https://clips.example/c4.mp4', durationMs: 15000 },
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
  assert.deepEqual(delivered.map((d) => d.title), ['Moment 3', 'Moment 2', 'Moment 1']);
  assert.ok(delivered.every((d) => d.storageKey.startsWith('commandes/abcdef12-0000-4000-8000-000000000000/')));
});

test('livraison « Teaser » : une seule vidéo de 15 s, la mieux classée, nommée « teaser »', async () => {
  await pipeline.finalize(orderFor({ kind: 'teaser', duration: '30 s' }));
  assert.equal(status, 'ready');
  assert.deepEqual(delivered.map((d) => d.fileName), ['bfm-business_teaser_15s_9x16.mp4']);
  assert.equal(delivered[0].title, 'Moment 3');
});
