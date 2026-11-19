'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { costOf, tranchesOf } = require('../src/credits/service');
const { DEFAULTS, validate } = require('../src/credits/settings');

const prices = DEFAULTS.prices;

test('barème : capsules et teaser au même prix quel que soit le format', () => {
  for (const format of ['vertical', 'carré', 'horizontal']) {
    assert.equal(costOf('capsules', { kind: 'capsules', duration: '60', format }, { prices }).credits, 300);
    assert.equal(costOf('capsules', { kind: 'teaser', duration: '15', format }, { prices }).credits, 300);
  }
});

test('barème : sous-titres par tranche de 5 minutes entamée', () => {
  assert.deepEqual([240, 300, 301, 600, 720].map((d) => costOf('subtitles', {}, { prices, durationSec: d }).credits), [300, 300, 600, 600, 900]);
  assert.equal(tranchesOf(null).tranches, 2, 'durée inconnue : passage classique de 10 min');
  assert.equal(costOf('subtitles', { spokenLanguage: 'fr', subtitleLanguage: 'en' }, { prices, durationSec: 600 }).credits, 1200);
});

test('barème : les autres commandes ne se paient pas en crédits', () => {
  assert.equal(costOf('visuels', {}, { prices }), null);
  assert.equal(costOf('photo', {}, { prices }), null);
});

test('réglages : packs validés par OpenMedias, contrôles de saisie', () => {
  assert.deepEqual(DEFAULTS.packs.map((p) => [p.credits, p.priceHT]), [[200, 59], [300, 69], [900, 179], [1500, 279], [3000, 499]]);
  assert.ok(validate(DEFAULTS).value);
  assert.match(validate({ ...DEFAULTS, packs: [] }).error, /packs/);
  assert.match(validate({ ...DEFAULTS, packs: [{ id: 'a', label: 'A', credits: 10, priceHT: 0.001 }] }).error, /prix/);
  assert.match(validate({ ...DEFAULTS, packs: [{ id: 'a', label: 'A', credits: 1, priceHT: 5 }, { id: 'a', label: 'B', credits: 1, priceHT: 5 }] }).error, /unique/);
});
