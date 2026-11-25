'use strict';
/** Traduction des sous-titres par DeepL (API remplacée par une fausse, conforme à la documentation v2). */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DEEPL_API_KEY = 'cle-test:fx';
process.env.DEEPL_MOCK = '';
const config = require('../src/config');
const deepl = require('../src/translation/deepl');
const subs = require('../src/media/subtitles');

function fakeDeepl(handler) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return handler(calls.at(-1), calls.length);
  };
  return { calls, restore: () => { global.fetch = real; } };
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

test('clé gratuite (« :fx ») → api-free.deepl.com ; sinon api.deepl.com', () => {
  assert.equal(deepl.baseUrl(), 'https://api-free.deepl.com');
  const k = config.translation.deeplKey;
  config.translation.deeplKey = 'cle-pro';
  assert.equal(deepl.baseUrl(), 'https://api.deepl.com');
  config.translation.deeplKey = k;
  assert.equal(deepl.enabled(), true);
  assert.equal(require('../src/opusclip.config').subtitles.translationEnabled, true, 'traduction proposée dès que la clé est là');
});

test('sous-titres traduits ligne à ligne, minutage conservé, contexte des lignes voisines, paquets de 50', async () => {
  const f = fakeDeepl((c) => json({ translations: c.body.text.map((t) => ({ detected_source_language: 'FR', text: `EN:${t}` })) }));
  try {
    const cues = Array.from({ length: 60 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 900, text: i === 0 ? 'Nous recyclons\nles plastiques' : `Ligne ${i}` }));
    const out = await deepl.translateCues(cues, { from: 'fr', to: 'en', wrap: (t) => subs.wrapText(t, 42, 2) });
    assert.equal(out.length, 60);
    assert.deepEqual(out.map((c) => [c.start, c.end]), cues.map((c) => [c.start, c.end]), 'minutage inchangé');
    assert.equal(out[0].text, 'EN:Nous recyclons les plastiques');
    assert.equal(f.calls.length, 2, '60 lignes → 2 appels');
    assert.equal(f.calls[0].url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(f.calls[0].headers.Authorization, 'DeepL-Auth-Key cle-test:fx');
    assert.equal(f.calls[0].body.target_lang, 'EN-GB');
    assert.equal(f.calls[0].body.source_lang, 'FR');
    assert.equal(f.calls[0].body.text.length, 50);
    assert.match(f.calls[1].body.context, /Ligne 45/, 'contexte : lignes précédentes');
  } finally { f.restore(); }
});

test('erreurs : 429 réessayé ; 456 (quota) et clé refusée expliqués', async () => {
  let f = fakeDeepl((c, n) => (n === 1 ? json({ message: 'Too many requests' }, 429) : json({ translations: [{ text: 'Hello' }] })));
  try { assert.deepEqual(await deepl.translateTexts(['Bonjour'], { from: 'fr', to: 'en' }), ['Hello']); } finally { f.restore(); }
  f = fakeDeepl(() => json({ message: 'Quota exceeded' }, 456));
  try { await assert.rejects(deepl.translateTexts(['Bonjour'], { from: 'fr', to: 'en' }), /Quota de traduction DeepL atteint/); assert.equal(f.calls.length, 1, '456 : pas de nouvel essai'); } finally { f.restore(); }
  f = fakeDeepl(() => json({ message: 'Forbidden' }, 403));
  try { await assert.rejects(deepl.translateTexts(['Bonjour'], { from: 'fr', to: 'en' }), /Clé DeepL refusée/); } finally { f.restore(); }
  await assert.rejects(deepl.translateTexts(['x'], { from: 'fr', to: 'xx' }), /non prise en charge/);
});
