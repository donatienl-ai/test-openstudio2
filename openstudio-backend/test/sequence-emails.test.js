'use strict';
// E-mails de la séquence (relances, avis, commande) : contenu des maquettes, liens, version texte, mise en page « messageries ».
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function load() {
  const orig = Module._load;
  Module._load = function (r, ...a) {
    if (/(^|\/)config$/.test(r)) return { mail: { assetsUrl: 'https://site.test/email' } };
    return orig.call(this, r, ...a);
  };
  try {
    for (const m of ['../src/emails/layout', '../src/emails/accessDay', '../src/emails/sequence']) delete require.cache[require.resolve(m)];
    return { seq: require('../src/emails/sequence'), day: require('../src/emails/accessDay') };
  } finally {
    Module._load = orig;
  }
}

const V = {
  name: 'Claire Dumas', code: 'OM-7KX4-M9', link: 'https://openstudio.fr/?code=OM-7KX4-M9', programme: 'Smart Impact', media: 'BFM Business',
  credits: 1000, prices: { capsules: 300, teaser: 300, subtitlesPer5Min: 300 }, creditsUntil: new Date('2027-01-02T12:00:00Z'),
  orderUrl: 'https://openstudio.fr/mes-commandes.html', reviewUrl: 'https://g.page/r/openmedias/review',
  order: { ref: 'CMD-2026-0042', offer: 'Teaser vidéo', programme: 'Smart Impact · BFM Business', amount: '816,00 € TTC', delay: 'sous 5 jours ouvrés',
    url: 'https://openstudio.fr/mes-commandes.html', invoiceUrl: 'https://openstudio.fr/mes-commandes.html#facture' },
};

const CASES = {
  relanceVideo1: { subject: 'Votre première vidéo est à 3 clics', has: ['Bonjour Claire', '1 000 crédits', '2 janvier 2027', '/email/espace.jpg', 'Étape 1', 'Choisissez le format', 'Créer ma première vidéo', 'Témoignages', 'os-hide'] },
  relanceVideo2: { subject: 'Vos 1 000 crédits offerts n’attendent que vous', has: ['Votre première vidéo est prête à être créée : lancez-vous.', 'Smart Impact', 'Ce que vos crédits vous permettent', '/email/capsules.jpg', 'Utiliser mes crédits', 'Commander un montage'] },
  relanceConnexion1: { subject: 'Connectez-vous et créez vos premières vidéos', has: ['OM-7KX4-M9', 'href="https://openstudio.fr/?code=OM-7KX4-M9"', 'crédits offerts', 'Accéder à mon espace', 'Utiliser mes crédits'] },
  relanceConnexion2: { subject: 'Vos 1 000 crédits expirent dans 10 jours', has: ['Dernier rappel', 'OM-7KX4-M9', 'crédits à utiliser', 'Expirent le', '2 janvier 2027', 'recharger des crédits'] },
  avisVideo: { subject: 'Donnez-nous votre avis, Claire !', has: ['Donnez-nous votre avis !', 'href="https://g.page/r/openmedias/review"', 'Laisser mon avis sur Google', 'Recharger mes crédits', 'Commander un montage'] },
  commandeConfirmee: { subject: 'Votre commande est confirmée', has: ['C’est lancé : vos vidéos sont en cours de montage.', '/email/montage.jpg', 'CMD-2026-0042', '816,00 € TTC', 'En cours', 'Livraison sous 5 jours ouvrés', 'Suivre ma commande', 'Voir ma facture'] },
  avisCommande: { subject: 'Vos vidéos vous ont plu ? Dites-le-nous !', has: ['Commande n° CMD-2026-0042', 'href="https://g.page/r/openmedias/review"', 'Commander un nouveau montage'] },
};

for (const [fn, c] of Object.entries(CASES)) {
  test(`e-mail ${fn} : objet, contenu, liens, version texte`, () => {
    const { seq } = load();
    const m = seq[fn](V);
    assert.equal(m.subject, c.subject);
    for (const s of c.has) assert.ok(m.html.includes(s), `${fn} : ${s}`);
    for (const s of ['/email/logo-openmedias.png', 'Répondez simplement à cet e-mail']) assert.ok(m.html.includes(s), s);
    assert.doesNotMatch(m.html, /display:\s*(flex|grid)|position:\s*absolute|undefined|NaN|\[object /);
    assert.ok(m.text.startsWith('Bonjour Claire,'), fn);
    assert.doesNotMatch(m.text, /undefined|NaN|<[a-z]/);
  });
}

test('envoi 1, variante test A : talon des crédits bleu nuit', () => {
  const { day } = load();
  const base = { name: 'Claire Dumas', code: 'OM-7KX4-M9', link: V.link, today: true, programme: 'Smart Impact', media: 'BFM Business', credits: 1000, creditsUntil: V.creditsUntil, prices: V.prices };
  const clair = day.accessDayEmail(base);
  const nuit = day.accessDayEmail({ ...base, dark: true });
  assert.ok(nuit.html.includes('linear-gradient(150deg,#0E084D'));
  assert.ok(!clair.html.includes('linear-gradient(150deg,#0E084D'));
  assert.equal(nuit.subject, clair.subject);
});
