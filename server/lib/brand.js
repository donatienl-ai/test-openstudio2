// Habillage OpenMedias ajouté après OpusClip : logos, mention du média, accroche facultative, jingle, son normalisé.
// Référence visuelle : tRecord() dans index.html (position et taille des logos, ombre portée).
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CONFIG } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FONT_BOLD = path.join(here, '..', 'assets', 'DMSans-ExtraBold.ttf');
export const FONT_REGULAR = path.join(here, '..', 'assets', 'DMSans-Regular.ttf');

/* Habillage : table des positions par format. Valeurs en fraction de la largeur (W) ou de la hauteur (H).
   Copie identique dans index.html (BRAND_LAYOUT) pour l'aperçu CSS : modifier les deux ensemble. */
export const BRAND_LAYOUT = {
  formats: {
    '9:16': { W: 1080, H: 1920, topH: 0.08 }, // sous la zone haute masquée par les interfaces des réseaux
    '1:1': { W: 1080, H: 1080, topH: null },  // null : marge identique au bord gauche
    '16:9': { W: 1920, H: 1080, topH: null }
  },
  marginW: 0.045,     // marge latérale
  logoHW: 0.055,      // hauteur du logo de l'entreprise
  mediaScale: 1.15,   // le logo du média est 15 % plus haut (comme tRecord)
  maxWW: 0.34,        // largeur maximale d'un logo
  textW: 0.032,       // taille du texte quand il n'y a pas de logo (nom du client, mention du média)
  shadow: { opacity: 0.45, blurW: 0.012 },
  hook: { sizeW: 0.05, yH: { '9:16': 0.17, '1:1': 0.17, '16:9': 0.24 }, maxWW: 0.8 },
  lumaThreshold: 150  // au-dessus : fond clair, on prend le logo « pour fond clair » s'il existe
};

export function layoutFor(fmt) {
  const f = BRAND_LAYOUT.formats[fmt]; if (!f) throw new Error('format inconnu');
  const { W, H } = f; const m = Math.round(W * BRAND_LAYOUT.marginW);
  return { W, H, margin: m, top: f.topH != null ? Math.round(H * f.topH) : m, logoH: Math.round(W * BRAND_LAYOUT.logoHW), maxW: Math.round(W * BRAND_LAYOUT.maxWW), blur: W * BRAND_LAYOUT.shadow.blurW, text: Math.round(W * BRAND_LAYOUT.textW) };
}

/* ---------- Outils FFmpeg ---------- */
export function run(cmd, args, { timeoutMs = CONFIG.render.timeoutMs, onStdout, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', out = []; const t = setTimeout(() => { p.kill('SIGKILL'); reject(Object.assign(new Error('délai dépassé'), { code: 'timeout' })); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
    p.stdout.on('data', d => { out.push(d); if (onStdout) onStdout(d.toString()); });
    p.stderr.on('data', d => { err = (err + d.toString()).slice(-6000); });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err }); else reject(Object.assign(new Error(`${cmd} a échoué (${code})`), { stderr: err })); });
  });
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 60000 });
  const j = JSON.parse(stdout.toString());
  const v = (j.streams || []).find(s => s.codec_type === 'video'); const a = (j.streams || []).find(s => s.codec_type === 'audio');
  return { duration: Number(j.format && j.format.duration) || Number(v && v.duration) || 0, width: v ? v.width : 0, height: v ? v.height : 0, hasAudio: !!a };
}

async function measureLoudness(file) {
  const r = CONFIG.render;
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `loudnorm=I=${r.loudnessI}:TP=${r.truePeak}:LRA=${r.lra}:print_format=json`, '-f', 'null', '-'], { timeoutMs: 5 * 60000 });
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/); if (!m) return null;
  const j = JSON.parse(m[0]); if (!isFinite(Number(j.input_i))) return null; return j;
}
function loudnormFilter(meas) {
  const r = CONFIG.render; const base = `loudnorm=I=${r.loudnessI}:TP=${r.truePeak}:LRA=${r.lra}`;
  if (!meas || Number(meas.input_i) < -70) return base; // silence ou mesure impossible : passe simple
  return `${base}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true`;
}

// Luminosité moyenne (0-255) de la zone où sera posé le logo du média, sur 3 images de l'extrait.
async function zoneLuma(file, fmt, rect, duration) {
  const { W, H } = layoutFor(fmt); const vals = [];
  for (const f of [0.15, 0.5, 0.85]) {
    try {
      const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, duration * f)), '-i', file, '-frames:v', '1',
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=1:1:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], { timeoutMs: 60000 });
      if (stdout.length) vals.push(stdout[0]);
    } catch (e) {}
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/* ---------- Logos : redimensionnement + ombre portée (sharp) ---------- */
export async function logoSize(src, targetH, maxW) {
  const meta = await sharp(src, { density: 300 }).metadata();
  let w = Math.round(meta.width * targetH / meta.height), h = targetH;
  if (w > maxW) { w = maxW; h = Math.max(1, Math.round(meta.height * w / meta.width)); }
  return { w, h };
}

export async function makeBadge(src, out, { targetH, maxW, blur, opacity = BRAND_LAYOUT.shadow.opacity }) {
  const { w, h } = await logoSize(src, targetH, maxW);
  const logo = await sharp(src, { density: 300 }).ensureAlpha().resize(w, h, { fit: 'fill' }).png().toBuffer();
  const pad = Math.ceil(blur * 2.5) + 2; const sigma = Math.max(0.4, blur / 2);
  const shadow = await sharp(logo).linear([0, 0, 0, opacity], [0, 0, 0, 0]).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).blur(sigma).png().toBuffer();
  await sharp(shadow).composite([{ input: logo, left: pad, top: pad }]).png().toFile(out);
  return { path: out, w, h, pad };
}

// Conversion d'un logo SVG (ou autre) en PNG transparent haute définition.
export async function toPng(buf, maxSide = 2400) {
  return sharp(buf, { density: 300 }).ensureAlpha().resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

/* ---------- Texte (drawtext) ---------- */
const esc = p => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
function wrapLines(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur); return lines.slice(0, 3);
}
const hex = c => /^#?[0-9a-f]{6}$/i.test(String(c || '')) ? '0x' + String(c).replace('#', '') : '0x3B3BFA';

/**
 * Habille un extrait OpusClip.
 * o = { clip, out, fmt, tmp, clientLogo?, clientName, media: { logoLight?, logoDark?, logoAllowed, mention, name, accent },
 *       jingle?, jinglePos ('debut'|'fin'|'both'|'aucun'), hook?, onProgress?(0..1), timeoutMs? }
 */
export async function brandClip(o) {
  const L = layoutFor(o.fmt); const { W, H, margin, top } = L;
  const info = await probe(o.clip); if (!info.duration) throw new Error('extrait illisible');
  const inputs = ['-i', o.clip]; let n = 1; const f = []; const txt = [];
  const shadowPx = Math.max(1, Math.round(W * 0.002));

  f.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30[v0]`);
  let cur = 'v0'; let k = 0;
  const overlay = (inp, x, y) => { const nx = `v${++k}`; f.push(`[${cur}][${inp}:v]overlay=${x}:${y}:format=auto[${nx}]`); cur = nx; };
  const draw = async (text, { x, y, size, font = FONT_BOLD, extra = '' }) => {
    const file = path.join(o.tmp, `t${txt.length}.txt`); await writeFile(file, String(text)); txt.push(file);
    const nx = `v${++k}`;
    f.push(`[${cur}]drawtext=fontfile='${esc(font)}':textfile='${esc(file)}':expansion=none:fontsize=${size}:fontcolor=white:x=${x}:y=${y}:shadowcolor=black@${BRAND_LAYOUT.shadow.opacity}:shadowx=${shadowPx}:shadowy=${shadowPx}${extra}[${nx}]`);
    cur = nx;
  };

  // Logo de l'entreprise, en haut à gauche ; à défaut, son nom en texte.
  if (o.clientLogo) {
    const b = await makeBadge(o.clientLogo, path.join(o.tmp, 'client.png'), { targetH: L.logoH, maxW: L.maxW, blur: L.blur });
    inputs.push('-i', b.path); overlay(n++, margin - b.pad, top - b.pad);
  } else if (o.clientName) {
    await draw(o.clientName, { x: margin, y: top, size: L.text });
  }

  // Logo du média, en haut à droite ; logo interdit ou absent : mention en texte (« Vu dans BFM Business »).
  const md = o.media || {}; const mH = Math.round(L.logoH * BRAND_LAYOUT.mediaScale);
  let mediaLogo = null;
  if (md.logoAllowed !== false && (md.logoLight || md.logoDark)) {
    mediaLogo = md.logoLight || md.logoDark;
    if (md.logoLight && md.logoDark) {
      const s = await logoSize(md.logoLight, mH, L.maxW);
      const luma = await zoneLuma(o.clip, o.fmt, { x: W - margin - s.w, y: top, w: s.w, h: s.h }, info.duration);
      if (luma != null && luma > BRAND_LAYOUT.lumaThreshold) mediaLogo = md.logoDark;
    }
  }
  if (mediaLogo) {
    const b = await makeBadge(mediaLogo, path.join(o.tmp, 'media.png'), { targetH: mH, maxW: L.maxW, blur: L.blur });
    inputs.push('-i', b.path); overlay(n++, W - margin - b.w - b.pad, top - b.pad);
  } else {
    const label = (md.mention || md.name || '').trim();
    if (label) await draw(label, { x: `${W - margin}-text_w`, y: top, size: L.text });
  }

  // Accroche facultative (même rendu que le Studio) : bandeau à la couleur du média, sous les logos.
  if (o.hook && String(o.hook).trim()) {
    const fs = Math.round(W * BRAND_LAYOUT.hook.sizeW); const maxChars = Math.max(8, Math.floor(W * BRAND_LAYOUT.hook.maxWW / (fs * 0.56)));
    const lines = wrapLines(String(o.hook).trim().slice(0, 80), maxChars); const y0 = Math.round(H * BRAND_LAYOUT.hook.yH[o.fmt]);
    for (const [i, line] of lines.entries()) await draw(line, { x: '(w-text_w)/2', y: Math.round(y0 + i * fs * 1.35 - fs / 2), size: fs, extra: `:box=1:boxcolor=${hex(md.accent)}:boxborderw=${Math.round(fs * 0.3)}:shadowx=0:shadowy=0` });
  }
  f.push(`[${cur}]format=yuv420p[vmain]`);

  // Son de l'extrait, normalisé (deux passes).
  const audio = (idx, inf, meas, label) => {
    if (inf.hasAudio) f.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${loudnormFilter(meas)},aresample=48000[${label}]`);
    else f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${inf.duration.toFixed(3)}[${label}]`);
  };
  audio(0, info, info.hasAudio ? await measureLoudness(o.clip) : null, 'amain');

  // Jingle d'intro et/ou d'outro, recadré en mode « cover » s'il n'est pas au bon format, au même niveau sonore.
  const pos = o.jingle && ['debut', 'fin', 'both'].includes(o.jinglePos) ? o.jinglePos : null;
  let vOut = 'vmain', aOut = 'amain', jDur = 0;
  if (pos) {
    const ji = await probe(o.jingle); jDur = ji.duration; const jIdx = n++; inputs.push('-i', o.jingle);
    f.push(`[${jIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,format=yuv420p[vj]`);
    audio(jIdx, ji, ji.hasAudio ? await measureLoudness(o.jingle) : null, 'aj');
    if (pos === 'both') {
      f.push('[vj]split[vj1][vj2]', '[aj]asplit[aj1][aj2]', '[vj1][aj1][vmain][amain][vj2][aj2]concat=n=3:v=1:a=1[vout][aout]');
    } else if (pos === 'debut') f.push('[vj][aj][vmain][amain]concat=n=2:v=1:a=1[vout][aout]');
    else f.push('[vmain][amain][vj][aj]concat=n=2:v=1:a=1[vout][aout]');
    vOut = 'vout'; aOut = 'aout';
  }

  const total = info.duration + jDur * (pos === 'both' ? 2 : pos ? 1 : 0);
  const args = ['-hide_banner', '-y', ...inputs, '-filter_complex', f.join(';'), '-map', `[${vOut}]`, '-map', `[${aOut}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', o.out];
  await run('ffmpeg', args, {
    timeoutMs: o.timeoutMs, signal: o.signal,
    onStdout: s => { const m = s.match(/out_time_us=(\d+)/g); if (m && o.onProgress && total) o.onProgress(Math.min(0.99, Number(m[m.length - 1].split('=')[1]) / 1e6 / total)); }
  });
  return { width: W, height: H, duration: total, mediaLogo: mediaLogo ? (mediaLogo === md.logoDark && md.logoLight ? 'fonce' : 'clair') : 'texte' };
}
