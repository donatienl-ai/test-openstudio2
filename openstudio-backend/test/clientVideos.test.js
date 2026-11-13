'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateClientVideo } = require('../src/clientVideos');

const programmes = { 'bfm-business': {}, bfm: {} };
const key = 'uploads/2026-11-13/b84b5626-525c-4a73-9f64-6e4b82dd5f7f/video.mp4';

test('dépôt client : refusé si le mode test est désactivé', () => {
  const r = validateClientVideo({ title: 'A', sourceKey: key }, { enabled: false, programmes });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('dépôt client : titre requis', () => {
  assert.equal(validateClientVideo({ sourceKey: key }, { enabled: true, programmes }).status, 400);
});

test('dépôt client : clé hors du dossier uploads refusée', () => {
  for (const k of ['clients/autre/video.mp4', 'uploads/2026-11-13/x/video.mp4', key.replace('video.mp4', 'logo.png'), '../' + key]) {
    assert.equal(validateClientVideo({ title: 'A', sourceKey: k }, { enabled: true, programmes }).ok, false, k);
  }
});

test('dépôt client : émission inconnue refusée, émission par défaut sinon', () => {
  assert.equal(validateClientVideo({ title: 'A', sourceKey: key, programmeId: 'x' }, { enabled: true, programmes }).ok, false);
  const r = validateClientVideo({ title: ' Émission ', sourceKey: key }, { enabled: true, programmes });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { title: 'Émission', sourceKey: key, programmeId: 'bfm-business', broadcastDate: null, durationSec: null });
});

test('dépôt client : durée mesurée par le navigateur conservée si plausible', () => {
  const ok = validateClientVideo({ title: 'A', sourceKey: key, durationSec: 125.37 }, { enabled: true, programmes });
  assert.equal(ok.value.durationSec, 125.4);
  for (const d of [-1, 0, 'abc', 999999]) {
    assert.equal(validateClientVideo({ title: 'A', sourceKey: key, durationSec: d }, { enabled: true, programmes }).value.durationSec, null);
  }
});
