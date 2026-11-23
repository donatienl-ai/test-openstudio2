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

const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Position d'un logo. Plusieurs logos dans le même coin se rangent côte à côte :
 * `shift` = décalage horizontal (px) vers l'intérieur de l'image.
 */
function overlayPosition(position, marginRatio, shift = 0) {
  const m = `W*${marginRatio}`;
  const left = shift ? `${m}+${shift}` : m;
  const right = shift ? `W-w-${m}-${shift}` : `W-w-${m}`;
  switch (position) {
    case 'top-right':
      return { x: right, y: m };
    case 'bottom-left':
      return { x: left, y: `H-h-${m}` };
    case 'bottom-right':
      return { x: right, y: `H-h-${m}` };
    case 'top-left':
    default:
      return { x: left, y: m };
  }
}

/**
 * Décalages des logos partageant un coin. L'ordre de la liste = ordre de gauche à droite
 * (entreprise puis média) : à droite, le dernier logo est collé au bord.
 */
function cornerShifts(logos, logoWidth) {
  const gap = Math.round(logoWidth * 0.2);
  const step = logoWidth + gap;
  const byCorner = {};
  logos.forEach((l, i) => { const pos = POSITIONS.includes(l.position) ? l.position : 'top-left'; (byCorner[pos] = byCorner[pos] || []).push(i); });
  const shifts = new Array(logos.length).fill(0);
  for (const [pos, idx] of Object.entries(byCorner)) {
    const right = pos.endsWith('right');
    idx.forEach((i, k) => { shifts[i] = (right ? idx.length - 1 - k : k) * step; });
  }
  return shifts;
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
  const shifts = cornerShifts(logos, logoWidth);
  logos.forEach((logo, i) => {
    const inIdx = i + 1;
    const l = `lg${inIdx}`;
    const out = `v${inIdx}`;
    parts.push(`[${inIdx}:v]scale=${logoWidth}:-1,format=rgba[${l}]`);
    const { x, y } = overlayPosition(logo.position, marginRatio, shifts[i]);
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
 * @param {number} [p.maxDurationSec]  coupe la vidéo à cette durée exacte (fondu sonore de fin)
 */
async function renderFinal({ input, output, logos, widthRatio, marginRatio, subtitles = null, maxDurationSec = null, startSec = 0 }) {
  const size = logos.length ? await probeVideoSize(input) : null;
  if (logos.length && !size) throw new Error('Vidéo illisible : dimensions introuvables');
  const { filter, outLabel } = buildFilterGraph({ logos, widthRatio, marginRatio, subtitles, videoWidth: size && size.width });
  // Mémoire limitée sur Render (512 Mo en offre gratuite) : peu de threads et une petite anticipation x264.
  const args = ['-hide_banner', '-y', '-filter_complex_threads', '1', ...(startSec > 0 ? ['-ss', String(startSec)] : []), '-i', input];
  for (const l of logos) args.push('-i', l.path);
  args.push(
    '-filter_complex', filter,
    '-map', `[${outLabel}]`,
    '-map', '0:a?',
    ...(maxDurationSec ? ['-t', String(maxDurationSec), '-af', `afade=t=out:st=${Math.max(0, maxDurationSec - 0.3).toFixed(2)}:d=0.3`] : []),
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

/** La vidéo a-t-elle une piste son ? */
async function hasAudio(input) {
  const { stderr } = await run(['-hide_banner', '-i', input], { timeoutMs: 120_000 });
  return /Stream #[^\n]*Audio:/.test(stderr);
}

/**
 * Filtergraph de l'habillage d'ouverture et de fin (fonction pure, testée).
 * Entrées : 0 = vidéo, 1 = première image de la vidéo (PNG bouclé sur introSec), 2 = logo d'ouverture, 3 = logo de fin.
 * Ouverture : logo sur la première image floutée, couleurs d'origine (ni assombrie ni fondu au noir).
 * Fin : fondu vers un fond uni (bleu nuit OpenMedias) avec le logo de fin, sans fondu au noir.
 */
function buildBumperGraph({ width, height, mainSec, introSec, outroSec, fadeSec, logoWidthRatio, fps = 30, audio, outroColor = '#24244A' }) {
  const W = width - (width % 2);
  const H = height - (height % 2);
  const lw = Math.max(2, Math.round((W * logoWidthRatio) / 2) * 2);
  const blur = Math.max(4, Math.round(Math.min(W, H) / 30));
  const norm = `scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p,settb=AVTB`;
  const color = /^#[0-9a-f]{6}$/i.test(outroColor) ? outroColor.replace('#', '0x') : '0x24244A';
  const xfade1 = (introSec - fadeSec).toFixed(3);
  const xfade2 = (introSec + mainSec - 2 * fadeSec).toFixed(3);
  const total = introSec + mainSec + outroSec - 2 * fadeSec;
  const parts = [
    `[0:v]${norm}[main]`,
    // Première image fournie en PNG bouclé (et non extraite ici avec loop=-1, qui bloquait ffmpeg 7.0.2 dès le départ)
    `[1:v]scale=${W}:${H},boxblur=${blur}:2,trim=duration=${introSec},${norm}[ibg]`,
    `[2:v]scale=${lw}:-1,format=rgba[ilogo]`,
    `[ibg][ilogo]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=repeat:shortest=1,format=yuv420p[intro]`,
    `color=c=${color}:s=${W}x${H}:r=${fps}:d=${outroSec},${norm}[obg]`,
    `[3:v]scale=${lw}:-1,format=rgba[ologo]`,
    `[obg][ologo]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=repeat:shortest=1,format=yuv420p[outro]`,
    `[intro][main]xfade=transition=fade:duration=${fadeSec}:offset=${xfade1}[x1]`,
    `[x1][outro]xfade=transition=fade:duration=${fadeSec}:offset=${xfade2}[vout]`,
  ];
  if (audio) {
    const delay = Math.round((introSec - fadeSec) * 1000);
    const end = introSec - fadeSec + mainSec;
    parts.push(`[0:a]aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${Math.max(0, mainSec - fadeSec).toFixed(3)}:d=${fadeSec},adelay=${delay}:all=1,apad,atrim=0:${total.toFixed(3)}[aout]`);
    void end;
  }
  return { filter: parts.join(';'), video: 'vout', audio: audio ? 'aout' : null, totalSec: total };
}

/**
 * Ajoute l'ouverture (logo de l'entreprise sur l'image floutée de la vidéo) et la fin (logo OpenMedias
 * blanc sur le bleu nuit OpenMedias), enchaînées en fondu. La vidéo garde sa durée : l'ensemble dure introSec + vidéo + outroSec - 2 × fondu.
 */
async function addBumpers({ input, output, introLogo, outroLogo, introSec = 2, outroSec = 2, fadeSec = 0.5, logoWidthRatio = 0.4, outroColor }) {
  const [size, mainSec, audio] = await Promise.all([probeVideoSize(input), probeDurationSec(input), hasAudio(input)]);
  if (!size || !mainSec) throw new Error('Vidéo illisible : habillage impossible');
  const g = buildBumperGraph({ width: size.width, height: size.height, mainSec: Math.max(fadeSec * 2 + 0.1, mainSec - 0.05), introSec, outroSec, fadeSec, logoWidthRatio, audio, outroColor });
  // Première image de la vidéo, en PNG : fond flouté de l'ouverture
  const first = `${output}.premiere-image.png`;
  const fr = await run(['-hide_banner', '-y', '-i', input, '-frames:v', '1', first], { timeoutMs: 120_000 });
  if (fr.code !== 0 || !require('fs').existsSync(first)) throw new Error(`habillage : première image illisible (code ${fr.code})`);
  const args = ['-hide_banner', '-y', '-filter_complex_threads', '1',
    '-i', input, '-loop', '1', '-framerate', '30', '-t', String(introSec), '-i', first, '-loop', '1', '-i', introLogo, '-loop', '1', '-i', outroLogo,
    '-filter_complex', g.filter, '-map', `[${g.video}]`];
  if (g.audio) args.push('-map', `[${g.audio}]`);
  args.push('-t', g.totalSec.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-x264-params', 'rc-lookahead=10', '-crf', '20', '-pix_fmt', 'yuv420p',
    ...(g.audio ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', output);
  const { code, stderr } = await run(args);
  require('fs').rmSync(first, { force: true });
  if (code !== 0) throw new Error(`habillage ffmpeg échoué (code ${code}) : ${stderr.slice(-1500)}`);
  return { totalSec: g.totalSec };
}

module.exports = { probeDurationSec, probeVideoSize, buildFilterGraph, buildForceStyle, renderFinal, buildBumperGraph, addBumpers, cornerShifts, POSITIONS, FONTS_DIR, FFMPEG_PATH: FFMPEG };
