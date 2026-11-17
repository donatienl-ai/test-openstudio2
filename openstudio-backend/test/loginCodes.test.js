'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const codes = require('../src/loginCodes');

const SECRET = 'secret-de-test-assez-long';

test('codes : format OM-XXXX-XX, sans caractères ambigus', () => {
  for (let i = 0; i < 2000; i++) {
    const c = codes.generate();
    assert.match(c, /^OM-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
    assert.doesNotMatch(c.slice(3), /[01ILO]/);
    assert.doesNotMatch(c, /^OM-\d{4}-/); // format réservé aux codes de démonstration
  }
});

test('codes : tirages différents (aucun doublon sur 5 000)', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(codes.generate());
  assert.equal(seen.size, 5000);
});

test('codes : la saisie est normalisée comme sur l’écran de connexion', () => {
  assert.equal(codes.normalize('om7kx4m9'), 'OM-7KX4-M9');
  assert.equal(codes.normalize(' OM-7KX4-M9 '), 'OM-7KX4-M9');
  assert.equal(codes.normalize('om 7kx4 m9'), 'OM-7KX4-M9');
  assert.equal(codes.normalize('OM-7KX4'), null);
  assert.equal(codes.normalize('XX-7KX4-M9'), null);
  assert.equal(codes.normalize(''), null);
  assert.equal(codes.normalize(undefined), null);
});

test('codes : empreinte stable, différente selon le code et le secret', () => {
  const h = codes.hash('OM-7KX4-M9', SECRET);
  assert.equal(h, codes.hash('OM-7KX4-M9', SECRET));
  assert.notEqual(h, codes.hash('OM-7KX4-M8', SECRET));
  assert.notEqual(h, codes.hash('OM-7KX4-M9', SECRET + 'x'));
  assert.doesNotMatch(h, /7KX4/);
});

test('codes : secret absent ou trop court refusé', () => {
  assert.throws(() => codes.hash('OM-7KX4-M9', ''));
  assert.throws(() => codes.hash('OM-7KX4-M9', 'court'));
});

test('codes : copie chiffrée relue avec le bon secret seulement', () => {
  const blob = codes.encrypt('OM-7KX4-M9', SECRET);
  assert.doesNotMatch(blob, /7KX4/);
  assert.equal(codes.decrypt(blob, SECRET), 'OM-7KX4-M9');
  assert.equal(codes.decrypt(blob, SECRET + 'x'), null);
  assert.equal(codes.decrypt(blob.slice(0, -2) + 'AA', SECRET), null);
  assert.equal(codes.decrypt(null, SECRET), null);
});

test('limite d’essais : bloque après le maximum, puis libère après la fenêtre', () => {
  let t = 0;
  const lim = codes.createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) {
    assert.equal(lim.check('ip').blocked, false);
    lim.fail('ip');
  }
  const st = lim.check('ip');
  assert.equal(st.blocked, true);
  assert.equal(st.retryAfterSec, 1);
  assert.equal(lim.check('autre-ip').blocked, false);
  t = 1001;
  assert.equal(lim.check('ip').blocked, false);
});

test('limite d’essais : une connexion réussie remet le compteur à zéro', () => {
  const lim = codes.createRateLimiter({ max: 2, windowMs: 60000 });
  lim.fail('ip');
  lim.fail('ip');
  assert.equal(lim.check('ip').blocked, true);
  lim.reset('ip');
  assert.equal(lim.check('ip').blocked, false);
});
