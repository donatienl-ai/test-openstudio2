'use strict';
// E-mail du code d'accès : contenu demandé (code, arguments, crédits valables 30 jours), sans la vidéo.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function loadAccess() {
  const orig = Module._load;
  Module._load = function (r, ...a) {
    if (/(^|\/)(db|mailer|clients|audit|secretbox)$/.test(r)) return { newAccessCode() {}, sha256() {}, problem() {} };
    if (/(^|\/)config$/.test(r)) return { mail: { templateClientAccess: 0 }, clientSiteUrl: 'https://openstudio.fr', admin: {} };
    return orig.call(this, r, ...a);
  };
  try {
    delete require.cache[require.resolve('../src/admin/client-access')];
    return require('../src/admin/client-access');
  } finally {
    Module._load = orig;
  }
}

test('e-mail du jour de diffusion : code, arguments, crédits 30 jours, sans la vidéo, à l’e-mail du client', () => {
  const access = loadAccess();
  const today = access.parisParts().day;
  const m = access.accessEmail({ id: 'c1', name: 'Claire Dumas', company: 'Ecoval', email: 'claire@ecoval.fr', broadcast_date: today },
    'https://openstudio.fr/?code=OM-7KX4-M9', 'OM-7KX4-M9', new Date('2027-01-02T22:59:59Z'));
  assert.equal(m.to.email, 'claire@ecoval.fr');
  assert.equal(m.subject, 'Votre émission est diffusée aujourd’hui : votre espace OpenStudio est ouvert');
  for (const s of ['OM-7KX4-M9', 'https://openstudio.fr/?code=OM-7KX4-M9', 'Pourquoi utiliser OpenStudio ?', 'LinkedIn', 'logos', 'crédibilité', 'valables 30 jours, jusqu’au 2 janvier 2027']) {
    assert.ok(m.text.includes(s), s);
  }
  assert.doesNotMatch(m.text, /vidéo de votre passage|télécharg/i);
  assert.equal(m.variables.credits_jusqu_au, '2 janvier 2027');
});

test('envoi à la main avant la diffusion : pas de « diffusé aujourd’hui »', () => {
  const access = loadAccess();
  const m = access.accessEmail({ id: 'c1', name: 'Claire', email: 'c@e.fr', broadcast_date: '2099-01-01' }, 'l', 'OM-AAAA-BB', null);
  assert.equal(m.subject, 'Votre espace OpenStudio est ouvert');
  assert.doesNotMatch(m.text, /aujourd’hui/);
  assert.match(m.text, /Vos crédits offerts sont valables 30 jours\./);
});
