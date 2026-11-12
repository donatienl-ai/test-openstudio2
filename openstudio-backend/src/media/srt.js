'use strict';
/**
 * Validation et décalage de fichiers SRT. Fonctions pures.
 */

const TS = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

function parseTs(s) {
  const m = TS.exec(s.trim());
  if (!m) return null;
  const [, h, mi, se, ms] = m.map(Number);
  if (mi > 59 || se > 59) return null;
  return ((h * 60 + mi) * 60 + se) * 1000 + ms;
}

function formatTs(totalMs) {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3_600_000);
  const mi = Math.floor((ms % 3_600_000) / 60_000);
  const se = Math.floor((ms % 60_000) / 1000);
  const mss = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(mi)}:${p(se)},${p(mss, 3)}`;
}

/**
 * Analyse un SRT. Renvoie { cues, errors }.
 * Règles : numérotation séquentielle, horodatage HH:MM:SS,mmm --> HH:MM:SS,mmm, début < fin, au moins une ligne de texte.
 */
function parseSrt(content) {
  const errors = [];
  const cues = [];
  const text = String(content || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { cues, errors: ['Fichier SRT vide'] };

  const blocks = text.split(/\n{2,}/);
  blocks.forEach((block, i) => {
    const lines = block.split('\n');
    const n = i + 1;
    if (lines.length < 3) {
      errors.push(`Bloc ${n} : incomplet (numéro, horodatage et texte attendus)`);
      return;
    }
    const index = Number(lines[0].trim());
    if (!Number.isInteger(index) || index !== n) errors.push(`Bloc ${n} : numérotation attendue ${n}, trouvée "${lines[0].trim()}"`);
    const parts = lines[1].split('-->');
    if (parts.length !== 2) {
      errors.push(`Bloc ${n} : ligne d'horodatage invalide`);
      return;
    }
    const start = parseTs(parts[0]);
    const end = parseTs(parts[1].trim().split(/\s+/)[0]);
    if (start === null || end === null) {
      errors.push(`Bloc ${n} : format attendu HH:MM:SS,mmm`);
      return;
    }
    if (start >= end) errors.push(`Bloc ${n} : le début doit précéder la fin`);
    const body = lines.slice(2).join('\n').trim();
    if (!body) errors.push(`Bloc ${n} : aucun texte`);
    cues.push({ index: n, start, end, text: body });
  });
  return { cues, errors };
}

function validateSrt(content) {
  const { errors, cues } = parseSrt(content);
  return { valid: errors.length === 0, errors, count: cues.length };
}

/** Applique un décalage global (ms) et renvoie le SRT réécrit. Les sous-titres passés avant 0 sont supprimés. */
function shiftSrt(content, offsetMs) {
  const { cues, errors } = parseSrt(content);
  if (errors.length) throw new Error(`SRT invalide : ${errors.slice(0, 3).join(' ; ')}`);
  const out = [];
  for (const c of cues) {
    const start = c.start + offsetMs;
    const end = c.end + offsetMs;
    if (end <= 0) continue;
    out.push({ start: Math.max(0, start), end, text: c.text });
  }
  return out.map((c, i) => `${i + 1}\n${formatTs(c.start)} --> ${formatTs(c.end)}\n${c.text}\n`).join('\n');
}

module.exports = { parseSrt, validateSrt, shiftSrt, parseTs, formatTs };
