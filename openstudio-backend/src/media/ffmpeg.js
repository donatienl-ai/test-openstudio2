'use strict';
/**
 * Post-traitement ffmpeg : incrustation des logos (émission + client) et, en mode SRT client,
 * incrustation des sous-titres dans le style choisi.
 * Utilise ffmpeg-static (binaire embarqué → pas de dépendance système sur Render).
 */
const { spawn } = require('child_process');
const path = require('path');

let FFMPEG = 'ffmpeg';
try {
  FFMPEG = require('ffmpeg-static') || 'ffmpeg';
} catch {
  /* ffmpeg système en secours */
}

const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

function run(args, { timeoutMs = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stderr });
    });
  });
}

/** Durée d'une vidéo (secondes) — fichier local ou URL HTTP(S). null si inconnue. */
async function probeDurationSec(input) {
  const { stderr, code } = await run(['-hide_banner', '-i', input], { timeoutMs: 120_000 });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) {
    // Diagnostic : dernières lignes de ffmpeg (sans l'URL signée)
    console.error(`[ffmpeg] durée introuvable (binaire ${FFMPEG}, code ${code}) : ${stderr.replace(/https?:\/\/\S+/g, '<url>').trim().split('\n').slice(-3).join(' | ')}`);
    return null;
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Dimensions d'affichage d'une vidéo (largeur × hauteur), rotation des vidéos de téléphone comprise.
 * null si la vidéo ne peut pas être lue.
 */
async function probeVideoSize(input) {
  const { stderr } = await run(['-hide_banner', '-i', input], { timeoutMs: 120_000 });
  const m = /Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  if (!m) return null;
  let width = Number(m[1]);
  let height = Number(m[2]);
  const rot = /rotat(?:e|ion of)\s*:?\s*(-?\d+(?:\.\d+)?)/i.exec(stderr);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  return { width, height };
}

/** Échappement d'une valeur dans un filtergraph ffmpeg (entre apostrophes). */
function q(value) {
  return `'${String(value).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

function overlayPosition(position, marginRatio) {
  const m = `W*${marginRatio}`;
  switch (position) {
    case 'top-right':
      return { x: `W-w-${m}`, y: m };
    case 'bottom-left':
      return { x: m, y: `H-h-${m}` };
    case 'bottom-right':
      return { x: `W-w-${m}`, y: `H-h-${m}` };
    case 'top-left':
    default:
      return { x: m, y: m };
  }
}

/**
 * Construit le filtergraph (fonction pure, testée).
 * Chaque logo (image fixe) est redimensionné UNE fois à partir de la largeur de la vidéo, puis
 * superposé et maintenu jusqu'à la dernière image (eof_action=repeat). L'ancien appariement image
 * par image (scale2ref) s'arrêtait après la première image du logo : la vidéo perdait son image.
 * @param {object} p
 * @param {Array<{position: string}>} p.logos  logos dans l'ordre des entrées 1, 2…
 * @param {number} p.widthRatio
 * @param {number} p.marginRatio
 * @param {null|{srtPath: string, forceStyle: string}} p.subtitles
 * @param {number} [p.videoWidth]  largeur d'affichage de la vidéo source (obligatoire s'il y a des logos)
 * @returns {{filter: string, outLabel: string}}
 */
function buildFilterGraph({ logos, widthRatio, marginRatio, subtitles, videoWidth }) {
  const parts = [];
  let current = '0:v';
  if (logos.length && !(videoWidth > 0)) throw new Error('Largeur de la vidéo inconnue : impossible de placer les logos');
  const logoWidth = Math.max(2, Math.round((videoWidth * widthRatio) / 2) * 2);
  logos.forEach((logo, i) => {
    const inIdx = i + 1;
    const l = `lg${inIdx}`;
    const out = `v${inIdx}`;
    parts.push(`[${inIdx}:v]scale=${logoWidth}:-1,format=rgba[${l}]`);
    const { x, y } = overlayPosition(logo.position, marginRatio);
    parts.push(`[${current}][${l}]overlay=x=${x}:y=${y}:eof_action=repeat:format=auto[${out}]`);
    current = out;
  });
  if (subtitles) {
    parts.push(
      `[${current}]subtitles=filename=${q(subtitles.srtPath)}:fontsdir=${q(FONTS_DIR)}:force_style=${q(subtitles.forceStyle)}[vsub]`
    );
    current = 'vsub';
  }
  if (!parts.length) {
    parts.push('[0:v]null[vout]');
    current = 'vout';
  }
  return { filter: parts.join(';'), outLabel: current };
}

/** Style ASS pour libass à partir des choix du client. */
function buildForceStyle({ fontName, fontSize, outline, outlineColour, primaryColour }) {
  return [
    `FontName=${fontName}`,
    `FontSize=${fontSize}`,
    `PrimaryColour=${primaryColour}`,
    `OutlineColour=${outlineColour}`,
    `BorderStyle=1`,
    `Outline=${outline}`,
    `Shadow=0`,
    `Alignment=2`,
    `MarginV=24`,
  ].join(',');
}

/**
 * Applique logos (+ sous-titres éventuels) et ré-encode en H.264.
 * @param {object} p
 * @param {string} p.input
 * @param {string} p.output
 * @param {Array<{path: string, position: string}>} p.logos
 * @param {number} p.widthRatio
 * @param {number} p.marginRatio
 * @param {null|{srtPath: string, forceStyle: string}} [p.subtitles]
 */
async function renderFinal({ input, output, logos, widthRatio, marginRatio, subtitles = null }) {
  const size = logos.length ? await probeVideoSize(input) : null;
  if (logos.length && !size) throw new Error('Vidéo illisible : dimensions introuvables');
  const { filter, outLabel } = buildFilterGraph({ logos, widthRatio, marginRatio, subtitles, videoWidth: size && size.width });
  // Mémoire limitée sur Render (512 Mo en offre gratuite) : peu de threads et une petite anticipation x264.
  const args = ['-hide_banner', '-y', '-filter_complex_threads', '1', '-i', input];
  for (const l of logos) args.push('-i', l.path);
  args.push(
    '-filter_complex', filter,
    '-map', `[${outLabel}]`,
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-threads', '2',
    '-x264-params', 'rc-lookahead=10',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    output
  );
  const { code, stderr } = await run(args);
  if (code !== 0) throw new Error(`ffmpeg a échoué (code ${code}) : ${stderr.slice(-1500)}`);
}

module.exports = { probeDurationSec, probeVideoSize, buildFilterGraph, buildForceStyle, renderFinal, FONTS_DIR, FFMPEG_PATH: FFMPEG };
