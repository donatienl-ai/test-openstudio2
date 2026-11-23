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

test('e-mail du jour J (maquette « pass clair ») : code, lien, crédits, émission, tarifs, version texte', () => {
  const access = loadAccess();
  const today = access.parisParts().day;
  const m = access.accessEmail({ id: 'c1', name: 'Claire Dumas', company: 'Ecoval', email: 'claire@ecoval.fr', broadcast_date: today },
    'https://openstudio.fr/?code=OM-7KX4-M9', 'OM-7KX4-M9', new Date('2027-01-02T22:59:59Z'),
    { programme: 'Smart Impact', media: 'BFM Business', credits: 1000, prices: { capsules: 300, teaser: 250, subtitlesPer5Min: 200 } });
  assert.equal(m.to.email, 'claire@ecoval.fr');
  assert.equal(m.subject, 'C’est le jour J : votre espace OpenStudio est ouvert');
  for (const s of ['Votre émission est diffusée aujourd’hui.', 'Bonjour Claire', 'Smart Impact', 'BFM Business', 'OM-7KX4-M9', 'href="https://openstudio.fr/?code=OM-7KX4-M9"',
    '1 000', 'crédits offerts', '2 janvier 2027', 'Accéder à mon espace', 'Utiliser mes crédits', '300 crédits', '250 crédits', '200 crédits / 5 min',
    'Des capsules pour vos réseaux', 'Sous-titres et logo', 'Un teaser de votre passage', '/email/logo-openmedias.png', '/email/capsules.jpg', 'Répondez simplement à cet e-mail']) {
    assert.ok(m.html.includes(s), s);
  }
  // Mise en page compatible avec les messageries : tableaux, pas de flex ni de grid
  assert.doesNotMatch(m.html, /display:\s*(flex|grid)|position:\s*absolute/);
  for (const s of ['Bonjour Claire,', 'OM-7KX4-M9', 'https://openstudio.fr/?code=OM-7KX4-M9', 'valables jusqu’au 2 janvier 2027', 'dans Smart Impact sur BFM Business']) assert.ok(m.text.includes(s), s);
  assert.doesNotMatch(m.text, /télécharg/i);
});

test('envoi à la main avant la diffusion : pas de « aujourd’hui » ; données manquantes sans trou', () => {
  const access = loadAccess();
  const m = access.accessEmail({ id: 'c1', name: 'Ecoval Industrie SAS', email: 'c@e.fr', broadcast_date: '2099-01-01' }, 'l', 'OM-AAAA-BB', null);
  assert.equal(m.subject, 'Votre espace OpenStudio est ouvert');
  const visible = m.html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visible, /aujourd’hui|\[|undefined|null/);
  assert.match(m.html, /Bonjour, votre espace OpenStudio est ouvert/, 'nom d’entreprise : pas de prénom inventé');
  assert.doesNotMatch(m.html, /Valables jusqu/);
});
