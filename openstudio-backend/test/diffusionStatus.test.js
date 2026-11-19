'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../src/diffusionStatus');

const TODAY = '2026-12-03'; // jeudi
const d = (o = {}) => ({
  id: 'd1', state: 'active', dateDiffusion: '2026-12-10', videoId: 'v1', entreprise: 'Ecoval', media: 'BFM Business 1&2', format: 'Plateau TV',
  client: { id: 'c1', company: 'Ecoval Industrie', email: 'claire@ecoval.fr' },
  accessSentAt: null, accessError: null, accessRevokedAt: null, alertBeforeOn: null, alertDayJOn: null, ...o,
});
const status = (o) => st.rowStatus(d(o), { today: TODAY, sendHour: 8 });
const alerts = (list, o = {}) => st.planAlerts(list, { today: TODAY, hour: 9, sendHour: 8, ...o });

test('alerte avant diffusion : J-2, avancée au vendredi si J-2 tombe un week-end', () => {
  assert.equal(st.alertDayFor('2026-12-03'), '2026-12-01'); // jeudi → mardi
  assert.equal(st.alertDayFor('2026-12-07'), '2026-12-04'); // lundi → vendredi (J-3)
  assert.equal(st.alertDayFor('2026-12-08'), '2026-12-04'); // mardi → vendredi (J-4)
  assert.equal(st.alertDayFor('2026-12-06'), '2026-12-04'); // dimanche → vendredi
});

test('état : prête, incomplète, bloquée, en ligne, annulée, date à fixer', () => {
  assert.equal(status().code, 'ready');
  assert.equal(status().label, 'Prête : code envoyé le jour J à 8 h');
  assert.equal(status({ videoId: null }).label, 'Incomplète : vidéo manquante');
  assert.equal(status({ videoId: null, client: { email: null } }).label, 'Incomplète : vidéo et e-mail du client manquants');
  assert.equal(status({ dateDiffusion: TODAY, videoId: null }).code, 'blocked');
  assert.equal(status({ dateDiffusion: TODAY, videoId: null }).tone, 'err');
  assert.equal(status({ dateDiffusion: TODAY }).code, 'sending');
  assert.equal(status({ dateDiffusion: '2026-11-20', accessSentAt: '2026-11-20T08:00:00Z' }).code, 'online');
  assert.equal(status({ state: 'cancelled' }).code, 'cancelled');
  assert.equal(status({ state: 'date_pending' }).code, 'date_pending');
  assert.equal(status({ accessRevokedAt: '2026-11-30' }).code, 'revoked');
  assert.equal(status({ dateDiffusion: TODAY, accessError: 'Mailjet injoignable' }).code, 'failed');
});

test('deuxième diffusion d’un client déjà prévenu : seul compte la vidéo, pas l’e-mail', () => {
  assert.equal(status({ accessSentAt: '2026-11-20', client: { email: null } }).code, 'ready');
  assert.equal(status({ accessSentAt: '2026-11-20', videoId: null }).label, 'Vidéo manquante');
});

test('alertes : rien quand tout est en ordre', () => {
  const r = alerts([d({ dateDiffusion: '2026-12-05' }), d({ id: 'x', dateDiffusion: TODAY })]);
  assert.deepEqual(r, { before: [], dayJ: [] });
});

test('alertes : diffusion de samedi incomplète signalée jeudi (J-2), celle de lundi signalée vendredi (J-3)', () => {
  const list = [d({ id: 'sam', dateDiffusion: '2026-12-05', videoId: null }), d({ id: 'lun', dateDiffusion: '2026-12-07', videoId: null })];
  assert.deepEqual(alerts(list).before.map((x) => x.id), ['sam']);
  assert.deepEqual(st.planAlerts(list, { today: '2026-12-04', hour: 9 }).before.map((x) => x.id), ['sam', 'lun']);
  assert.deepEqual(alerts([d({ id: 'sam', dateDiffusion: '2026-12-05', videoId: null, alertBeforeOn: '2026-12-03' })]).before, []);
});

test('alertes du jour J : à partir de 8 h, une fois par jour, pas pour une diffusion annulée ou un accès coupé', () => {
  const blocked = d({ dateDiffusion: TODAY, client: { email: null } });
  assert.deepEqual(alerts([blocked], { hour: 7 }).dayJ, []);
  assert.equal(alerts([blocked]).dayJ.length, 1);
  assert.deepEqual(alerts([blocked]).dayJ[0].missing, ['e-mail du client']);
  assert.deepEqual(alerts([{ ...blocked, alertDayJOn: TODAY }]).dayJ, []);
  assert.deepEqual(alerts([{ ...blocked, state: 'cancelled' }]).dayJ, []);
  assert.deepEqual(alerts([{ ...blocked, accessRevokedAt: '2026-12-01' }]).dayJ, []);
});

test('texte de l’alerte : client, émission, élément manquant, lien vers le dossier Drive', () => {
  // diffusionAlerts charge la base : on ne teste que sa mise en forme, isolée ici
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (/\/(db|mailer|diffusions|config)$/.test(req) || /client-access$/.test(req)) return { parisParts: () => ({}), mail: {}, admin: {} };
    return orig.call(this, req, ...rest);
  };
  try {
    const { alertText } = require('../src/diffusionAlerts');
    const item = { ...d({ dateDiffusion: '2026-12-05', videoId: null, driveUrl: 'https://drive.google.com/drive/folders/abc' }), missing: ['vidéo'] };
    const t = alertText('before', [item], { backofficeUrl: 'https://admin.openstudio.fr' });
    assert.equal(t.subject, 'Diffusion à venir incomplète (1)');
    assert.match(t.text, /5 décembre 2026 · Ecoval Industrie · BFM Business 1&2 – Plateau TV : vidéo manquante/);
    assert.match(t.text, /Dossier Drive : https:\/\/drive\.google\.com\/drive\/folders\/abc/);
    assert.match(t.text, /https:\/\/admin\.openstudio\.fr\/#diffusions/);
    assert.match(alertText('dayJ', [item, item]).subject, /^Diffusions du jour bloquées : 2 clients sans code d’accès$/);
  } finally {
    Module._load = orig;
  }
});
