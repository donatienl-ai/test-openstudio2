'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isLiveOrder, liveTestGuard } = require('../src/opusclip/mode');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const opus = (o = {}) => ({ dryRun: true, liveClients: [CLIENT], liveMaxMinutes: 10, apiKey: 'sk-test', ...o });

test('mode : dry run par défaut, envoi réel pour les seuls clients listés', () => {
  assert.equal(isLiveOrder({ client_id: CLIENT }, opus()), true);
  assert.equal(isLiveOrder({ client_id: 'autre' }, opus()), false);
  assert.equal(isLiveOrder({ client_id: null }, opus()), false);
  assert.equal(isLiveOrder({ client_id: CLIENT }, opus({ liveClients: [] })), false);
  assert.equal(isLiveOrder({ client_id: 'autre' }, opus({ dryRun: false })), true);
});

test('mode : garde-fous de l’envoi réel de test', () => {
  assert.equal(liveTestGuard(120, opus()), null);
  assert.match(liveTestGuard(null, opus()), /Durée/);
  assert.match(liveTestGuard(11 * 60, opus()), /trop longue/);
  assert.match(liveTestGuard(120, opus({ apiKey: '' })), /OPUSCLIP_API_KEY/);
  assert.equal(liveTestGuard(null, opus({ dryRun: false })), null); // production : budget seulement
});
