'use strict';
/**
 * Sous-titres : lecture .srt / .vtt, construction depuis la transcription OpusClip (mots horodatés),
 * découpage des phrases trop longues, export .srt / .vtt. Fonctions pures.
 * Une « cue » = { start: ms, end: ms, text: string }.
 */
const { parseSrt, formatTs } = require('./srt');

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
const VTT_TS = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/;

function parseVttTs(s) {
  const m = VTT_TS.exec(String(s).trim());
  if (!m) return null;
  const h = Number(m[1] || 0);
  const mi = Number(m[2]);
  const se = Number(m[3]);
  if (mi > 59 || se > 59) return null;
  return ((h * 60 + mi) * 60 + se) * 1000 + Number(m[4]);
}

function parseVtt(content) {
  const errors = [];
  const cues = [];
  const text = String(content || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!/^WEBVTT/.test(text)) return { cues, errors: ['En-tête WEBVTT manquant'] };
  const blocks = text.split(/\n{2,}/).slice(1);
  let n = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) continue;
    n += 1;
    const [a, rest] = lines[tsIdx].split('-->');
    const start = parseVttTs(a);
    const end = parseVttTs(String(rest).trim().split(/\s+/)[0]);
    if (start === null || end === null) {
      errors.push(`Sous-titre ${n} : horodatage attendu HH:MM:SS.mmm`);
      continue;
    }
    if (start >= end) errors.push(`Sous-titre ${n} : le début doit précéder la fin`);
    const body = lines
      .slice(tsIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '') // balises de style VTT
      .trim();
    if (!body) errors.push(`Sous-titre ${n} : aucun texte`);
    cues.push({ start, end, text: body });
  }
  if (!cues.length && !errors.length) errors.push('Aucun sous-titre trouvé');
  return { cues, errors };
}

/** Lit un fichier .srt ou .vtt (détection automatique). */
function parseSubtitleFile(content) {
  const text = String(content || '').replace(/^﻿/, '').trimStart();
  if (text.startsWith('WEBVTT')) return { format: 'vtt', ...parseVtt(text) };
  const { cues, errors } = parseSrt(text);
  return { format: 'srt', cues: cues.map(({ start, end, text: t }) => ({ start, end, text: t })), errors };
}

function validateSubtitleFile(content) {
  const r = parseSubtitleFile(content);
  return { valid: r.errors.length === 0, errors: r.errors, count: r.cues.length, format: r.format };
}

// ---------------------------------------------------------------------------
// Construction depuis la transcription OpusClip
// GET /api/transcripts → data[0] = [{ start, end, text, words: [{ word, start, end, isFillerWord }] }]
// (temps en secondes)
// ---------------------------------------------------------------------------
const SENTENCE_END = /[.!?…]["»”)]?$/;
const SOFT_BREAK = /[,;:]["»”)]?$/;

/**
 * @param {Array} paragraphs  transcription OpusClip
 * @param {object} opts { split: boolean, maxCharsPerLine, maxLines, maxCueDurationSec, dropFillers }
 */
function cuesFromTranscript(paragraphs, opts) {
  const maxChars = opts.maxCharsPerLine * opts.maxLines;
  const maxDur = opts.maxCueDurationSec * 1000;
  const cues = [];

  for (const p of paragraphs || []) {
    const words = (p.words || []).filter((w) => w && w.word && !(opts.dropFillers && w.isFillerWord));
    if (!words.length) {
      if (p.text) cues.push({ start: Math.round(p.start * 1000), end: Math.round(p.end * 1000), text: p.text.trim() });
      continue;
    }
    let cur = null;
    const flush = () => {
      if (cur && cur.words.length) cues.push({ start: cur.start, end: cur.end, text: cur.words.join(' ') });
      cur = null;
    };
    for (const w of words) {
      const ws = Math.round(w.start * 1000);
      const we = Math.round(w.end * 1000);
      const token = String(w.word).trim();
      if (!cur) cur = { start: ws, end: we, words: [] };
      const nextLen = cur.words.join(' ').length + (cur.words.length ? 1 : 0) + token.length;
      if (opts.split && cur.words.length && (nextLen > maxChars || we - cur.start > maxDur)) {
        flush();
        cur = { start: ws, end: we, words: [] };
      }
      cur.words.push(token);
      cur.end = we;
      const len = cur.words.join(' ').length;
      // Coupe en fin de phrase, ou sur une virgule si la ligne est déjà bien remplie
      if (SENTENCE_END.test(token) || (opts.split && SOFT_BREAK.test(token) && len > maxChars * 0.6)) flush();
    }
    flush();
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Découpage des phrases trop longues (fichiers importés)
// ---------------------------------------------------------------------------
function splitLongCues(cues, { maxCharsPerLine, maxLines, maxCueDurationSec }) {
  const maxChars = maxCharsPerLine * maxLines;
  const maxDur = maxCueDurationSec * 1000;
  const out = [];
  for (const c of cues) {
    const text = c.text.replace(/\s+/g, ' ').trim();
    const dur = c.end - c.start;
    if (text.length <= maxChars && dur <= maxDur) {
      out.push({ ...c, text });
      continue;
    }
    const parts = Math.max(Math.ceil(text.length / maxChars), Math.ceil(dur / maxDur));
    const words = text.split(' ');
    const target = text.length / parts;
    const chunks = [];
    let buf = [];
    for (const w of words) {
      const candidate = [...buf, w].join(' ');
      if (buf.length && (candidate.length > maxChars || (buf.join(' ').length >= target && chunks.length < parts - 1))) {
        chunks.push(buf.join(' '));
        buf = [];
      }
      buf.push(w);
    }
    if (buf.length) chunks.push(buf.join(' '));
    // Répartition du temps au prorata du nombre de caractères
    const total = chunks.reduce((s, x) => s + x.length, 0);
    let t = c.start;
    chunks.forEach((chunk, i) => {
      const end = i === chunks.length - 1 ? c.end : Math.round(t + (dur * chunk.length) / total);
      out.push({ start: t, end, text: chunk });
      t = end;
    });
  }
  return out;
}

/** Retour à la ligne : au plus `maxLines` lignes de ~maxCharsPerLine, coupées de façon équilibrée. */
function wrapText(text, maxCharsPerLine, maxLines) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxCharsPerLine || maxLines < 2) return t;
  const words = t.split(' ');
  let best = t;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.abs(a.length - b.length) + (a.length > maxCharsPerLine || b.length > maxCharsPerLine ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

function shiftCues(cues, offsetMs) {
  if (!offsetMs) return cues;
  return cues
    .map((c) => ({ ...c, start: Math.max(0, c.start + offsetMs), end: c.end + offsetMs }))
    .filter((c) => c.end > 0);
}

/** Pipeline complet : décalage → découpage (option) → retour à la ligne. */
function prepareCues(cues, { split, offsetMs = 0, maxCharsPerLine, maxLines, maxCueDurationSec }) {
  let out = shiftCues(cues, offsetMs);
  if (split) out = splitLongCues(out, { maxCharsPerLine, maxLines, maxCueDurationSec });
  return out.map((c) => ({ ...c, text: split ? wrapText(c.text, maxCharsPerLine, maxLines) : c.text }));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${formatTs(c.start)} --> ${formatTs(c.end)}\n${c.text}\n`).join('\n');
}

function toVtt(cues) {
  const ts = (ms) => formatTs(ms).replace(',', '.');
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n')}`;
}

module.exports = {
  parseVtt,
  parseSubtitleFile,
  validateSubtitleFile,
  cuesFromTranscript,
  splitLongCues,
  wrapText,
  shiftCues,
  prepareCues,
  toSrt,
  toVtt,
};
