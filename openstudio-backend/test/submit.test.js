'use strict';
/**
 * Soumission d'une commande : la vidéo source est téléchargée puis lue en local par ffmpeg
 * (durée → estimation des crédits). Stockage, base et OpusClip simulés.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const config = require('../src/config');
const storage = require('../src/storage');
const orders = require('../src/orders');
const opus = require('../src/opusclip/client');
const pipeline = require('../src/pipeline');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-test-'));
const SOURCE = path.join(tmp, 'source.mp4');
const CLIENT = '11111111-1111-4111-8111-111111111111';

test.before(() => {
  execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=3', '-pix_fmt', 'yuv420p', SOURCE], { stdio: 'ignore' });
  storage.head = async () => ({ exists: true, size: fs.statSync(SOURCE).size, contentType: 'video/mp4' });
  storage.downloadToFile = async (key, dest) => fs.copyFileSync(SOURCE, dest);
  orders.creditsUsed = async () => 0;
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const order = () => ({
  id: '22222222-2222-4222-8222-222222222222',
  type: 'capsules',
  client_id: CLIENT,
  options: { sourceKey: 'uploads/x/video.mp4', programmeId: 'bfm-business', duration: 30, format: '9:16', subtitleStyle: 'discret', videoTitle: 'Test' },
});

test('soumission dry run : durée lue en local, crédits estimés', async () => {
  delete process.env.OPUSCLIP_LIVE_CLIENTS;
  let saved = null;
  orders.setStatus = async (id, status, extra) => { saved = { status, ...extra }; };
  await pipeline.submit(order());
  assert.equal(saved.status, 'dry_run');
  assert.equal(saved.estimated_credits, 1); // 3 s → 1 crédit (arrondi supérieur)
});

test('soumission réelle (client de test) : vidéo locale envoyée à OpusClip', async () => {
  process.env.OPUSCLIP_LIVE_CLIENTS = CLIENT;
  const prevKey = config.opus.apiKey;
  config.opus.apiKey = 'sk-test';
  let uploaded = 0;
  opus.uploadVideo = async (stream, size) => { for await (const c of stream) uploaded += c.length; assert.equal(uploaded, size); return 'upload-1'; };
  opus.createProject = async () => ({ projectId: 'P1' });
  const calls = [];
  orders.saveProjectId = async (id, p) => calls.push(['project', p]);
  orders.recordCredits = async (id, c) => calls.push(['credits', c]);
  orders.setProcessing = async (id, p) => calls.push(['processing', p]);
  try {
    await pipeline.submit(order());
  } finally {
    config.opus.apiKey = prevKey;
    delete process.env.OPUSCLIP_LIVE_CLIENTS;
  }
  assert.equal(uploaded, fs.statSync(SOURCE).size);
  assert.deepEqual(calls, [['project', 'P1'], ['credits', 1], ['processing', 'P1']]);
});
