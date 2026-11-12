'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOptions,
  buildProjectPayload,
  interpretProjectStatus,
  extractProjectId,
  estimateCredits,
  ValidationError,
} = require('../src/opusclip/payload');
const real = require('../src/opusclip.config');

const hook = 'https://api.example.com/api/webhooks/opusclip';
const ID = 'abcdef12-0000-0000-0000-000000000000';
const video = { id: 'v1', title: 'Passage du 12 mars', programme_id: 'bfm-business', source_key: 'clients/c1/bfm.mp4' };

// ---------------------------------------------------------------------------
// Capsules vidéo
// ---------------------------------------------------------------------------
test('capsules : libellés de la page acceptés tels quels → payload OpusClip', () => {
  for (const [duration, range] of [['15 s', [[10, 20]]], ['30 s', [[25, 35]]], ['45 s', [[40, 50]]], ['60 s', [[55, 65]]]]) {
    for (const [format, expected] of [['Vertical 9:16', 'portrait'], ['Carré 1:1', 'square'], ['Horizontal 16:9', 'landscape']]) {
      for (const style of ['Impact', 'Classique', 'Discret']) {
        const options = normalizeOptions('capsules', { videoId: 'v1', duration, format, subtitleStyle: style }, real, { video });
        const p = buildProjectPayload({ id: ID, type: 'capsules', options }, 'upload-xyz', real, hook);
        assert.equal(p.videoUrl, 'upload-xyz');
        assert.equal(p.renderPref.layoutAspectRatio, expected);
        assert.deepEqual(p.curationPref.clipDurations, range);
        assert.equal(p.brandTemplateId, real.capsules.subtitleStyles[style.toLowerCase()]);
      }
    }
  }
});

test('capsules : la vidéo du package fixe le programme, la source et la langue', () => {
  const options = normalizeOptions('capsules', { videoId: 'v1', duration: '30', format: '9:16', subtitleStyle: 'impact' }, real, { video });
  assert.equal(options.programmeId, 'bfm-business');
  assert.equal(options.sourceKey, 'clients/c1/bfm.mp4');
  const p = buildProjectPayload({ id: ID, type: 'capsules', options }, 'u', real, hook);
  assert.equal(p.importPref.sourceLang, 'fr');
  assert.equal(p.curationPref.skipCurate, false);
  assert.equal(p.uploadedVideoAttr.title, 'BFM Business — Passage du 12 mars — commande abcdef12');
  assert.deepEqual(p.conclusionActions, [{ type: 'WEBHOOK', url: hook, notifyFailure: true }]);
});

test('capsules : vidéo hors du package du client → refusée', () => {
  assert.throws(
    () => normalizeOptions('capsules', { videoId: 'v-autre', duration: '30 s', format: '9:16', subtitleStyle: 'impact' }, real, { video: null }),
    /ne fait pas partie de votre espace/
  );
});

test('capsules : option non proposée → erreur explicite', () => {
  assert.throws(() => normalizeOptions('capsules', { videoId: 'v1', duration: '20 s', format: '9:16', subtitleStyle: 'impact' }, real, { video }), /Durée non proposée/);
  assert.throws(() => normalizeOptions('capsules', { videoId: 'v1', duration: '30 s', format: '4:3', subtitleStyle: 'impact' }, real, { video }), ValidationError);
  assert.throws(() => normalizeOptions('capsules', { videoId: 'v1', duration: '30 s', format: '9:16', subtitleStyle: 'Néon' }, real, { video }), /Aucun template/);
});

// ---------------------------------------------------------------------------
// Sous-titres
// ---------------------------------------------------------------------------
test('sous-titres avec fichier .srt/.vtt : traitement local, aucun projet OpusClip', () => {
  const options = normalizeOptions('subtitles', {
    videoKey: 'v.mp4', transcriptKey: 't.vtt', spokenLanguage: 'Français', subtitleLanguage: 'Français',
    splitLongLines: true, size: 'Moyenne', outline: 'Moyen',
  }, real);
  assert.equal(options.mode, 'client_file');
  assert.equal(options.spokenLanguage, 'fr');
  assert.equal(options.size, 'moyenne');
  assert.throws(() => buildProjectPayload({ id: ID, type: 'subtitles', options }, 'u', real, hook), /traitement local/);
});

test('sous-titres sans fichier : transcription OpusClip, vidéo entière sans découpage', () => {
  const options = normalizeOptions('subtitles', { videoKey: 'v.mp4', spokenLanguage: 'en', subtitleLanguage: 'en' }, real);
  assert.equal(options.mode, 'opus_transcript');
  assert.equal(options.splitLongLines, true); // activé par défaut, comme sur la page
  assert.equal(options.size, real.subtitles.style.defaultSize);
  const p = buildProjectPayload({ id: ID, type: 'subtitles', options }, 'up-1', real, hook);
  assert.equal(p.curationPref.skipCurate, true);
  assert.equal(p.importPref.sourceLang, 'en');
  assert.equal(p.brandTemplateId, undefined);
});

test('sous-titres : traduction (langue ≠ langue parlée) refusée tant qu’elle n’est pas branchée', () => {
  assert.throws(
    () => normalizeOptions('subtitles', { videoKey: 'v.mp4', spokenLanguage: 'fr', subtitleLanguage: 'Anglais' }, real),
    /traduction/
  );
});

test('sous-titres : découpage désactivable, vidéo obligatoire', () => {
  const o = normalizeOptions('subtitles', { videoKey: 'v.mp4', spokenLanguage: 'fr', splitLongLines: false }, real);
  assert.equal(o.splitLongLines, false);
  assert.throws(() => normalizeOptions('subtitles', { spokenLanguage: 'fr' }, real), /Aucune vidéo/);
});

// ---------------------------------------------------------------------------
// Autres types
// ---------------------------------------------------------------------------
test('visuels et publications : jamais de projet OpusClip', () => {
  for (const type of ['visuels', 'publications']) {
    assert.deepEqual(normalizeOptions(type, { a: 1 }, real), { a: 1 });
    assert.throws(() => buildProjectPayload({ id: 'x', type, options: {} }, 'u', real, hook), ValidationError);
  }
});

test('interprétation du statut de projet', () => {
  assert.equal(interpretProjectStatus({ status: 'COMPLETED' }), 'done');
  assert.equal(interpretProjectStatus({ stage: 'failed' }), 'failed');
  assert.equal(interpretProjectStatus({ data: { stage: 'CURATING' } }), 'running');
  assert.equal(interpretProjectStatus({ foo: 1 }), 'unknown');
});

test('extraction de l’identifiant de projet du webhook', () => {
  assert.equal(extractProjectId({ projectId: 'P1' }), 'P1');
  assert.equal(extractProjectId({ data: { projectId: 'P2' } }), 'P2');
  assert.equal(extractProjectId(null), null);
});

test('estimation des crédits', () => {
  assert.equal(estimateCredits(61, 1), 2);
  assert.equal(estimateCredits(null, 1), 0);
});

test('sous-titres : programme facultatif pour le logo du média', () => {
  const o = normalizeOptions('subtitles', { videoKey: 'v.mp4', spokenLanguage: 'fr', programmeId: 'bfm' }, real);
  assert.equal(o.programmeId, 'bfm');
  assert.equal(normalizeOptions('subtitles', { videoKey: 'v.mp4', spokenLanguage: 'fr' }, real).programmeId, null);
  assert.throws(() => normalizeOptions('subtitles', { videoKey: 'v.mp4', spokenLanguage: 'fr', programmeId: 'tf1' }, real), /Programme inconnu/);
  assert.equal(real.logos.onSubtitledVideo, true);
});
