'use strict';
/**
 * Règles des dossiers Drive et du choix de la vidéo à importer (sans base ni Drive : testées dans
 * test/driveSync.test.js). Utilisées par src/driveSync.js.
 */
const path = require('path');

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.mxf', '.webm', '.mkv'];


/** Nom du dossier d'une diffusion, ex. « 2026-12-03 – BFM Business 1&2 – Plateau TV ». */
function diffusionFolderName(d) {
  const date = d.state === 'date_pending' || !d.dateDiffusion ? 'date à fixer' : d.dateDiffusion;
  const media = [d.media, d.sousMedia].filter(Boolean).join(' ');
  return [date, media, d.format].filter(Boolean).join(' – ').replace(/[\\/]/g, '-');
}

/** Nom du dossier d'un client. */
function clientFolderName(name) {
  return String(name || 'Client sans nom').trim().replace(/[\\/]/g, '-');
}

/** Où doit se trouver le dossier d'une diffusion : chez le client, ou dans « Annulées ». */
const expectedParent = (d) => (d.state === 'cancelled' ? 'cancelled' : 'client');

/** Émission OpenStudio (logos, voir opusclip.config programmes) correspondant au média du planning. */
function programmeFor(media) {
  const m = String(media || '').toLowerCase();
  if (m.includes('business')) return 'bfm-business';
  if (m.startsWith('bfm')) return 'bfm';
  if (m.includes('capital')) return 'capital';
  // Médias sans logo configuré (Le Figaro, TIME…) : identifiant lisible, à ajouter dans opusclip.config
  return m.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'openmedias';
}

const isVideo = (f) => /^video\//.test(f.mimeType || '') || VIDEO_EXTS.includes(path.extname(f.name || '').toLowerCase());

/**
 * Vidéo à importer dans un dossier : la plus récente, non vide, et stable (pas modifiée depuis `settleMs`,
 * pour ne pas prendre un fichier encore en cours d'envoi). null si aucune.
 */
function pickVideo(files, { now = Date.now(), settleMs = 2 * 60 * 1000 } = {}) {
  return (files || [])
    .filter((f) => isVideo(f) && Number(f.size) > 0 && now - Date.parse(f.modifiedTime) >= settleMs)
    .sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime))[0] || null;
}

module.exports = { VIDEO_EXTS, diffusionFolderName, clientFolderName, expectedParent, programmeFor, isVideo, pickVideo };
