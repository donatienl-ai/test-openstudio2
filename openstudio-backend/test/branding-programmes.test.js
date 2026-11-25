'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

// Pas de base : aucun réglage enregistré, logos d'émission = configuration.
db.query = async () => ({ rows: [] });
const branding = require('../src/media/branding');

test('deux émissions : logo du média propre au client limité à son émission', async () => {
  const client = { id: 'c1', media_logo_key: 'clients/c1/logos/media/figaro.png', media_logo_programme_id: 'le-figaro' };
  const fig = await branding.clientLogos(client, 'le-figaro');
  assert.equal(fig.media.key, 'clients/c1/logos/media/figaro.png');
  assert.equal(fig.media.source, 'client');
  const bfm = await branding.clientLogos(client, 'bfm-business');
  assert.notEqual(bfm.media.key, 'clients/c1/logos/media/figaro.png');
  assert.notEqual(bfm.media.source, 'client');
  assert.equal(bfm.media.programmeId, 'bfm-business');
});

test('ancien logo propre sans émission : appliqué partout', async () => {
  const client = { id: 'c2', media_logo_key: 'clients/c2/logos/media/x.png', media_logo_programme_id: null };
  for (const p of ['le-figaro', 'bfm-business']) assert.equal((await branding.clientLogos(client, p)).media.source, 'client');
});
