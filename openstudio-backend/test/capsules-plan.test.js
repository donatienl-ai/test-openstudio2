'use strict';
/** Livraison des capsules : toujours 3 propositions quand c'est possible, titres tirés de ce qui est dit. */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANTHROPIC_API_KEY = '';
const { planCapsules } = require('../src/pipeline');
const { keywords, keywordTitle, capsuleTitle } = require('../src/media/keywords');
const { clipTranscript } = require('../src/social/transcript');
const mapping = require('../src/opusclip.config');

const c = (id, ms) => ({ id, durationMs: ms });

test('3 capsules : extraits assez longs en priorité', () => {
  const plan = planCapsules([c('a', 31000), c('b', 40000), c('c', 33000), c('d', 45000)], 30, 1, 3);
  assert.deepEqual(plan.map((p) => [p.clip.id, p.startSec]), [['a', 0], ['b', 0], ['c', 0]]);
});

test('3 capsules : s’il manque des extraits, la suite d’un extrait long en fournit une de plus', () => {
  // Deux extraits seulement, dont un de 70 s : la 3ᵉ capsule est prise de 30 s à 60 s dans cet extrait
  const plan = planCapsules([c('a', 70000), c('b', 32000), c('court', 12000)], 30, 1, 3);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((p) => [p.clip.id, p.startSec, p.part]), [['a', 0, 1], ['b', 0, 1], ['a', 30, 2]]);
  // Un seul extrait de 50 s pour des capsules de 15 s : 3 parties successives
  assert.deepEqual(planCapsules([c('x', 50000)], 15, 1, 3).map((p) => p.startSec), [0, 15, 30]);
  // Teaser : une seule vidéo
  assert.equal(planCapsules([c('a', 70000), c('b', 32000)], 15, 1, 1).length, 1);
  // Rien d'assez long : rien n'est livré (erreur explicite plus haut)
  assert.equal(planCapsules([c('court', 9000)], 30, 1, 3).length, 0);
});

test('OpusClip : fourchettes de durée larges (assez d’extraits pour 3 capsules)', () => {
  for (const [d, range] of Object.entries(mapping.capsules.durations)) {
    assert.equal(range[0][0], Number(d), 'jamais plus court que la durée choisie');
    assert.ok(range[0][1] >= Number(d) * 1.5, `${d} s : fourchette d'au moins +50 %`);
  }
  assert.equal(mapping.capsules.maxClips, 3);
});

test('titre : mots-clés de ce qui est dit', () => {
  const t = "Bonjour. Alors nous, on recycle les plastiques industriels. Ces plastiques deviennent des granulés, et ces granulés repartent chez les industriels. C'est vraiment le cœur du recyclage.";
  const k = keywords(t);
  assert.deepEqual(k, ['plastiques', 'industriels', 'granulés']);
  assert.ok(!k.includes('bonjour') && !k.includes('vraiment') && !k.includes('alors'));
  assert.equal(keywordTitle(t), 'Plastiques · Industriels · Granulés');
  assert.equal(keywordTitle('Oui merci.'), '', 'trop peu de texte : pas de titre inventé');
});

test('titre : IA si la clé est là, mots-clés sinon, titre OpusClip en dernier recours', async () => {
  const t = 'Nous recyclons les plastiques industriels en granulés pour toute la filière plasturgie française.';
  let sent = null;
  const fake = { messages: { create: async (r) => { sent = r; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title: 'Recycler les plastiques industriels en granulés' }) }] }; } } };
  assert.equal(await capsuleTitle(t, 'Moment 1', { programme: 'BFM Business' }, { client: fake }), 'Recycler les plastiques industriels en granulés');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.match(sent.messages[0].content, /BFM Business/);
  const broken = { messages: { create: async () => { throw new Error('API indisponible'); } } };
  assert.match(await capsuleTitle(t, 'Moment 1', {}, { client: broken }), /Plastiques|Granulés|Industriels/);
  assert.equal(await capsuleTitle('', 'Moment 1'), 'Moment 1');
});

test('transcription d’une partie d’extrait (capsule tirée de la suite)', () => {
  const w = (text, a, b) => ({ text, tr: [a, b] });
  const clip = { timeRanges: [[100000, 170000]], screenplay: { chapters: [{ lines: [{ type: 'verbal', words: [w('Premier', 100, 101), w('sujet.', 101, 102), w('Second', 131, 132), w('sujet.', 132, 133)] }] }] } };
  assert.equal(clipTranscript(clip, 30), 'Premier sujet.');
  assert.equal(clipTranscript(clip, 30, 30), 'Second sujet.');
  assert.equal(clipTranscript({ text: 'Texte sans horodatage' }, 30, 30), '', 'pas de texte faux pour une seconde partie');
});
