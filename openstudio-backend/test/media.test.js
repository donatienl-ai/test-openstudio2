'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateSrt, shiftSrt } = require('../src/media/srt');
const { buildFilterGraph, buildForceStyle, renderFinal, probeDurationSec, probeVideoSize, FFMPEG_PATH } = require('../src/media/ffmpeg');

const SRT = `1
00:00:01,000 --> 00:00:02,500
Bonjour à tous

2
00:00:03,000 --> 00:00:04,000
Bienvenue
`;

test('SRT valide', () => {
  const r = validateSrt(SRT);
  assert.equal(r.valid, true);
  assert.equal(r.count, 2);
});

test('SRT invalide : numérotation, format, début >= fin', () => {
  const bad = `1\n00:00:02,000 --> 00:00:01,000\nA\n\n3\n00:00:03,000 --> 00:00:04,000\nB\n\n3\n0:00:05 --> 00:00:06,000\nC`;
  const r = validateSrt(bad);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /début/.test(e)));
  assert.ok(r.errors.some((e) => /numérotation/.test(e)));
  assert.ok(r.errors.some((e) => /HH:MM:SS/.test(e)));
});

test('SRT : décalage de synchronisation', () => {
  const out = shiftSrt(SRT, -1500);
  assert.match(out, /^1\n00:00:00,000 --> 00:00:01,000\nBonjour à tous/);
  assert.match(out, /2\n00:00:01,500 --> 00:00:02,500\nBienvenue/);
  assert.match(shiftSrt(SRT, 2000), /00:00:03,000 --> 00:00:04,500/);
});

test('filtergraph : deux logos + sous-titres', () => {
  const { filter, outLabel } = buildFilterGraph({
    logos: [{ position: 'top-left' }, { position: 'top-right' }],
    widthRatio: 0.14,
    marginRatio: 0.03,
    subtitles: { srtPath: '/tmp/s.srt', forceStyle: 'FontName=Montserrat,FontSize=22' },
    videoWidth: 1080,
  });
  assert.equal(outLabel, 'vsub');
  // Logos redimensionnés une seule fois (14 % de 1080 px), puis maintenus jusqu'à la fin de la vidéo.
  assert.match(filter, /\[1:v\]scale=152:-1,format=rgba\[lg1\]/);
  assert.match(filter, /\[0:v\]\[lg1\]overlay=x=W\*0.03:y=W\*0.03:eof_action=repeat/);
  assert.match(filter, /\[v1\]\[lg2\]overlay=x=W-w-W\*0.03/);
  assert.doesNotMatch(filter, /scale2ref/);
  assert.match(filter, /force_style='FontName=Montserrat,FontSize=22'/);
});

test('style ASS', () => {
  const s = buildForceStyle({ fontName: 'Roboto', fontSize: 22, outline: 2, outlineColour: '&H000000', primaryColour: '&HFFFFFF' });
  assert.match(s, /FontName=Roboto,FontSize=22/);
  assert.match(s, /Outline=2/);
});

// Test d'intégration réel (exécuté seulement si ffmpeg est disponible)
const hasFfmpeg = spawnSync(FFMPEG_PATH, ['-version']).status === 0;
test('rendu réel : logos + sous-titres incrustés', { skip: !hasFfmpeg && 'ffmpeg absent' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-test-'));
  const input = path.join(dir, 'in.mp4');
  const logo1 = path.join(dir, 'l1.png');
  const logo2 = path.join(dir, 'l2.png');
  const srt = path.join(dir, 's.srt');
  const output = path.join(dir, 'out.mp4');
  spawnSync(FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=duration=5', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', input]);
  spawnSync(FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=red:size=400x200', '-frames:v', '1', logo1]);
  spawnSync(FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', 'color=blue:size=300x300', '-frames:v', '1', logo2]);
  fs.writeFileSync(srt, shiftSrt(SRT, 0));

  await renderFinal({
    input,
    output,
    logos: [{ path: logo1, position: 'top-left' }, { path: logo2, position: 'top-right' }],
    widthRatio: 0.14,
    marginRatio: 0.03,
    subtitles: { srtPath: srt, forceStyle: buildForceStyle({ fontName: 'DejaVu Sans', fontSize: 22, outline: 2, outlineColour: '&H000000', primaryColour: '&HFFFFFF' }) },
  });
  assert.ok(fs.statSync(output).size > 10_000);
  const d = await probeDurationSec(output);
  assert.ok(d > 4.5 && d < 5.5, `durée ${d}`);
  // La vidéo garde toutes ses images (5 s à 25 i/s), pas seulement le son.
  const count = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', output, '-map', '0:v', '-f', 'null', '-']).stderr.toString();
  const frames = Number((/frame=\s*(\d+)/g.exec(count.split('frame=').slice(-1).map((x) => 'frame=' + x)[0]) || [])[1]);
  assert.ok(frames >= 120, `images vidéo : ${frames}`);
  assert.deepEqual(await probeVideoSize(output), { width: 1080, height: 1920 });
  // Les deux logos sont visibles au début, au milieu et à la fin de la vidéo.
  const pixel = (t, x, y) => [...spawnSync(FFMPEG_PATH, ['-v', 'error', '-ss', String(t), '-i', output, '-frames:v', '1',
    '-vf', `crop=4:4:${x}:${y},scale=1:1,format=rgb24`, '-f', 'rawvideo', 'pipe:1']).stdout];
  for (const t of [0.2, 2.5, 4.8]) {
    const [r1, g1, b1] = pixel(t, 100, 65);   // logo 1 (rouge, en haut à gauche)
    const [r2, g2, b2] = pixel(t, 970, 105);  // logo 2 (bleu, en haut à droite)
    assert.ok(r1 > 200 && g1 < 70 && b1 < 70, `logo gauche absent à ${t} s : ${r1},${g1},${b1}`);
    assert.ok(b2 > 200 && r2 < 70 && g2 < 70, `logo droit absent à ${t} s : ${r2},${g2},${b2}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
