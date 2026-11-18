'use strict';
/**
 * Import de clients depuis un fichier CSV (export Excel ou Google Sheets, séparateur ; ou ,).
 * Colonnes reconnues (l'ordre n'a pas d'importance, majuscules et accents indifférents) :
 *   nom | entreprise | email | date de diffusion | package | notes
 */

const HEADERS = {
  name: ['nom', 'contact', 'nom du contact', 'client', 'name'],
  company: ['entreprise', 'societe', 'société', 'raison sociale', 'company'],
  email: ['email', 'e-mail', 'mail', 'adresse e-mail', 'adresse email', 'courriel'],
  broadcastDate: ['date de diffusion', 'date diffusion', 'date_diffusion', 'diffusion', 'date'],
  packageLabel: ['package', 'formule', 'offre', 'pack'],
  notes: ['notes', 'note', 'commentaire', 'commentaires', 'remarques'],
};

const MAX_ROWS = 500;

const simplify = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

/** Découpe un CSV en lignes de cellules (guillemets, retours à la ligne dans une cellule, ; ou ,). */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** « 12/01/2027 », « 12/01/27 », « 2027-01-12 » → « 2027-01-12 » ; null si vide ; false si illisible. */
function parseDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let y, m, d;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (r) [, y, m, d] = r.map(Number);
  else {
    r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (!r) return false;
    [, d, m, y] = r.map(Number);
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/**
 * Analyse le fichier : renvoie les lignes prêtes à créer et les problèmes ligne par ligne.
 * existingEmails : adresses déjà présentes en base (en minuscules), signalées comme doublons.
 */
function analyse(text, { existingEmails = new Set() } = {}) {
  const table = parseCsv(text);
  if (!table.length) return { error: 'Le fichier est vide.' };
  const head = table[0].map(simplify);
  const col = {};
  for (const [field, names] of Object.entries(HEADERS)) {
    const idx = head.findIndex((h) => names.map(simplify).includes(h));
    if (idx !== -1) col[field] = idx;
  }
  if (col.name === undefined && col.company === undefined) {
    return { error: 'Colonnes introuvables : la première ligne doit contenir au moins « nom » ou « entreprise » (et idéalement « email » et « date de diffusion »).' };
  }
  const body = table.slice(1);
  if (body.length > MAX_ROWS) return { error: `Fichier trop long : ${MAX_ROWS} clients au maximum par import.` };
  const seen = new Set();
  const rows = body.map((cells, i) => {
    const get = (f) => (col[f] === undefined ? '' : String(cells[col[f]] || '').trim());
    const line = i + 2;
    const problems = [];
    const name = get('name') || get('company');
    const email = get('email').toLowerCase();
    const date = parseDate(get('broadcastDate'));
    if (!name) problems.push('nom manquant');
    if (email && !isEmail(email)) problems.push('e-mail invalide');
    if (date === false) problems.push('date illisible (format attendu : JJ/MM/AAAA)');
    if (email && existingEmails.has(email)) problems.push('déjà présent dans le back-office');
    if (email && seen.has(email)) problems.push('en double dans le fichier');
    if (email) seen.add(email);
    return {
      line,
      client: {
        name,
        company: get('company') || null,
        email: email || null,
        broadcastDate: date || null,
        packageLabel: get('packageLabel') || null,
        notes: get('notes') || null,
      },
      warnings: [!email ? 'pas d’e-mail : le lien ne pourra pas partir automatiquement' : null, !date && date !== false ? 'pas de date de diffusion' : null].filter(Boolean),
      problems,
    };
  });
  return {
    columns: Object.keys(col),
    rows,
    ready: rows.filter((r) => !r.problems.length).length,
    rejected: rows.filter((r) => r.problems.length).length,
  };
}

module.exports = { parseCsv, parseDate, analyse, MAX_ROWS };
