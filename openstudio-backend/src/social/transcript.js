'use strict';
/**
 * Texte prononcé dans un clip OpusClip, limité à la durée réellement livrée.
 * Les clips exportables portent `screenplay.chapters[].lines[].words[]` avec des temps absolus
 * (secondes dans la vidéo source) et `timeRanges` (millisecondes). À défaut : `clip.text`.
 */
function clipTranscript(clip, maxSec) {
  if (!clip) return '';
  const start = Array.isArray(clip.timeRanges) && clip.timeRanges[0] ? Number(clip.timeRanges[0][0]) / 1000 : null;
  const words = [];
  for (const ch of (clip.screenplay && clip.screenplay.chapters) || []) {
    for (const line of ch.lines || []) {
      if (line.type && line.type !== 'verbal') continue;
      for (const w of line.words || []) if (w && w.text && Array.isArray(w.tr)) words.push(w);
    }
  }
  if (words.length && start != null) {
    const limit = maxSec ? start + Number(maxSec) + 0.05 : Infinity;
    const kept = words.filter((w) => Number(w.tr[1]) <= limit).map((w) => w.text);
    if (kept.length) return kept.join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  }
  return String(clip.text || '').replace(/__silence/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { clipTranscript };
