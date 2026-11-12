// Test local de l'habillage, sans OpusClip ni stockage : node scripts/test-brand.js [dossier de sortie]
// Génère un faux extrait, de faux logos et un faux jingle, puis produit les cas de la liste de tests.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { brandClip, run, probe } from '../lib/brand.js';

const out = path.resolve(process.argv[2] || 'test-out'); await mkdir(out, { recursive: true });
const p = f => path.join(out, f);
const svgLogo = (txt, fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160"><rect x="4" y="4" width="592" height="152" rx="24" fill="none" stroke="${fill}" stroke-width="8"/><text x="300" y="108" font-family="sans-serif" font-size="84" font-weight="700" text-anchor="middle" fill="${fill}">${txt}</text></svg>`);
await sharp(svgLogo('ECOVAL', '#1C7A51')).png().toFile(p('logo-client.png'));
await sharp(svgLogo('MÉDIA', '#FFFFFF')).png().toFile(p('logo-media-clair.png'));
await sharp(svgLogo('MÉDIA', '#111137')).png().toFile(p('logo-media-fonce.png'));

const gen = (file, w, h, d, color, tone) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=30:d=${d}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000:duration=${d}`, '-filter_complex', `[0:v]drawbox=x=0:y=0:w=iw:h=ih*0.25:color=${color}@1:t=fill[v]`, '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', p(file)]);
await gen('clip-916.mp4', 1080, 1920, 6, 'black', 440);
await gen('clip-11.mp4', 1080, 1080, 6, 'white', 440);
await gen('clip-169.mp4', 1920, 1080, 6, 'black', 440);
await gen('jingle-169.mp4', 1920, 1080, 2, 'red', 880);
await gen('jingle-916.mp4', 1080, 1920, 2, 'red', 880);

const media = { name: 'BFM Business', mention: 'Vu dans BFM Business', accent: '#3B3BFA', logoAllowed: true, logoLight: p('logo-media-clair.png'), logoDark: p('logo-media-fonce.png') };
const cases = [
  ['deux-logos-916', { clip: p('clip-916.mp4'), fmt: '9:16', clientLogo: p('logo-client.png'), media }],
  ['deux-logos-11-fond-clair', { clip: p('clip-11.mp4'), fmt: '1:1', clientLogo: p('logo-client.png'), media }],
  ['deux-logos-169', { clip: p('clip-169.mp4'), fmt: '16:9', clientLogo: p('logo-client.png'), media }],
  ['client-sans-logo-916', { clip: p('clip-916.mp4'), fmt: '9:16', clientName: 'Ecoval Industrie', media }],
  ['logo-media-interdit-916', { clip: p('clip-916.mp4'), fmt: '9:16', clientLogo: p('logo-client.png'), media: { ...media, logoAllowed: false } }],
  ['accroche-916', { clip: p('clip-916.mp4'), fmt: '9:16', clientLogo: p('logo-client.png'), media, hook: 'Notre secret : la formation en interne' }],
  ['jingle-bon-format-916', { clip: p('clip-916.mp4'), fmt: '9:16', clientLogo: p('logo-client.png'), media, jingle: p('jingle-916.mp4'), jinglePos: 'both' }],
  ['jingle-mauvais-format-916', { clip: p('clip-916.mp4'), fmt: '9:16', clientLogo: p('logo-client.png'), media, jingle: p('jingle-169.mp4'), jinglePos: 'debut' }]
];
for (const [name, o] of cases) {
  const t0 = Date.now(); const file = p(`${name}.mp4`);
  const r = await brandClip({ ...o, clientName: o.clientName || 'Ecoval Industrie', out: file, tmp: out });
  const info = await probe(file);
  const at = o.jingle && o.jinglePos !== 'fin' ? 3 : 1;
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=iw/2:-1', p(`${name}.png`)]);
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-']);
  const lufs = (stderr.match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/) || [])[1];
  console.log(`${name}: ${info.width}x${info.height}, ${info.duration.toFixed(1)} s, logo média ${r.mediaLogo}, ${lufs} LUFS, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
