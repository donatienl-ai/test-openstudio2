'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const subs = require('../src/media/subtitles');

const opts = { maxCharsPerLine: 42, maxLines: 2, maxCueDurationSec: 6 };

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Bonjour à <b>tous</b>

NOTE commentaire ignoré

00:00:03.500 --> 00:00:05.000 align:center
Bienvenue
`;

test('lecture .vtt (balises et notes ignorées, numéro facultatif)', () => {
  const r = subs.parseSubtitleFile(VTT);
  assert.equal(r.format, 'vtt');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.cues, [
    { start: 1000, end: 3000, text: 'Bonjour à tous' },
    { start: 3500, end: 5000, text: 'Bienvenue' },
  ]);
});

test('lecture .srt et validation', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:02,500 --> 00:00:03,000\nB\n';
  const r = subs.validateSubtitleFile(srt);
  assert.equal(r.valid, true);
  assert.equal(r.format, 'srt');
  assert.equal(r.count, 2);
  assert.equal(subs.validateSubtitleFile('WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nX').valid, false);
});

test('export .srt et .vtt', () => {
  const cues = [{ start: 1000, end: 2500, text: 'Bonjour' }];
  assert.equal(subs.toSrt(cues), '1\n00:00:01,000 --> 00:00:02,500\nBonjour\n');
  assert.equal(subs.toVtt(cues), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nBonjour\n');
});

test('découpage des phrases trop longues : morceaux ≤ 84 caractères, temps répartis sans trou', () => {
  const long = "En 2014, on jetait encore 80 % de nos chutes de plastique, aujourd'hui nous en recyclons la quasi-totalité grâce à une nouvelle filière locale.";
  const out = subs.splitLongCues([{ start: 0, end: 9000, text: long }], opts);
  assert.ok(out.length >= 2);
  for (const c of out) assert.ok(c.text.length <= 84, c.text);
  assert.equal(out[0].start, 0);
  assert.equal(out.at(-1).end, 9000);
  for (let i = 1; i < out.length; i++) assert.equal(out[i].start, out[i - 1].end);
  assert.equal(out.map((c) => c.text).join(' '), long);
});

test('retour à la ligne équilibré sur 2 lignes', () => {
  const t = subs.wrapText('En 2014, on jetait encore 80 % de nos chutes de plastique.', 42, 2);
  const lines = t.split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.length <= 42);
});

test('option désactivée : sous-titres conservés tels quels', () => {
  const cues = [{ start: 0, end: 20000, text: 'x '.repeat(80).trim() }];
  const out = subs.prepareCues(cues, { ...opts, split: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, cues[0].text);
});

test('décalage de synchronisation', () => {
  const out = subs.prepareCues([{ start: 1000, end: 2000, text: 'A' }, { start: 3000, end: 4000, text: 'B' }], { ...opts, split: false, offsetMs: -1500 });
  assert.deepEqual(out, [
    { start: 0, end: 500, text: 'A' },
    { start: 1500, end: 2500, text: 'B' },
  ]);
});

test('transcription OpusClip (mots horodatés en secondes) → sous-titres', () => {
  const words = 'Bonjour à tous. Aujourd’hui nous parlons de recyclage du plastique dans nos usines, et de la filière locale que nous avons créée.'
    .split(' ')
    .map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.35, isFillerWord: false }));
  const paragraphs = [{ id: 0, start: 0, end: words.at(-1).end, text: '', words }];

  const cut = subs.cuesFromTranscript(paragraphs, { ...opts, split: true });
  assert.equal(cut[0].text, 'Bonjour à tous.'); // coupe en fin de phrase
  assert.equal(cut[0].start, 0);
  for (const c of cut) {
    assert.ok(c.text.length <= 84, c.text);
    assert.ok(c.end - c.start <= 6000 + 400);
  }

  const whole = subs.cuesFromTranscript(paragraphs, { ...opts, split: false });
  assert.equal(whole.length, 2); // une phrase = un sous-titre
});
