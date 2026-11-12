// Serveur OpenStudio (Render) : stockage des fichiers, relais OpusClip, habillage OpenMedias.
// La route /ai/json existante (rédaction par IA) n'est pas réimplémentée ici.
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG, storageReady, opusReady } from './lib/config.js';
import { AppError, MSG, sendError } from './lib/errors.js';
import * as store from './lib/storage.js';
import * as state from './lib/state.js';
import { buildOpusPayload, redact, createProject, uploadToOpus, listClips, projectStage, verifyWebhook, readWebhook } from './lib/opus.js';
import { brandClip, toPng, BRAND_LAYOUT } from './lib/brand.js';
import { enqueue, position, isActive } from './lib/queue.js';
import { startEmails } from './lib/emails.js';
import { eventsRouter } from './lib/eventsApi.js';
import { createLogger } from './lib/log.js';
import { videoGeneratedEvent } from './lib/journeys/activation.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------- CORS : uniquement l'origine du site ---------- */
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // appels serveur à serveur (webhook OpusClip, curl)
    if (!CONFIG.siteOrigins.length) return cb(null, true); // à éviter en production : renseigner SITE_ORIGIN
    cb(null, CONFIG.siteOrigins.includes(origin));
  },
  methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'X-Admin-Secret'], maxAge: 600
}));

const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => sendError(res, e));
const hash = obj => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'fichier';
const safe = s => String(s || '').replace(/[^\w\-]/g, '_').slice(0, 80) || 'x';

/* ---------- Webhook OpusClip (corps brut nécessaire pour vérifier la signature) ---------- */
app.post('/opus/webhook', express.raw({ type: '*/*', limit: '1mb' }), h(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyWebhook(raw, req.headers)) return res.status(401).json({ error: 'Signature invalide.' });
  let body = {}; try { body = JSON.parse(raw.toString('utf8')); } catch (e) {}
  const w = readWebhook(body);
  if (w.projectId) {
    await state.patch('projects', w.projectId, { status: w.failed ? 'failed' : 'done', stage: w.stage, webhookAt: new Date().toISOString(), error: w.failed ? MSG.refused : null });
    console.info(`[opus] webhook reçu pour ${w.projectId} : ${w.failed ? 'échec' : 'terminé'}`);
  }
  res.json({ ok: true });
}));

app.use(express.json({ limit: '1mb' }));

/* ---------- Emails automatiques (Mailjet) ---------- */
let EMAILS = null;
app.use(eventsRouter({ getEngine: () => EMAILS && EMAILS.engine, log: createLogger() }));

// Protection facultative des dépôts (désactivée tant que ADMIN_SECRET est vide).
const adminGuard = (req, res, next) => {
  if (CONFIG.adminSecret && req.get('X-Admin-Secret') !== CONFIG.adminSecret) return res.status(401).json({ error: 'Dépôt non autorisé.' });
  next();
};

app.get(['/', '/health'], (req, res) => res.json({ ok: true, storage: storageReady(), opus: opusReady(), webhook: !!CONFIG.publicUrl }));

/* ---------- Stockage ---------- */
const KINDS = {
  video: { prefix: 'raw', type: /^video\//, max: () => CONFIG.storage.maxVideoMb, ttl: 6 * 3600 },
  logo: { prefix: 'logos', type: /^image\/(png|svg\+xml|jpeg|webp)$/, max: () => CONFIG.storage.maxImageMb, ttl: 900 },
  jingle: { prefix: 'jingles', type: /^video\//, max: () => CONFIG.storage.maxJingleMb, ttl: 3600 }
};

app.post('/storage/upload-url', adminGuard, h(async (req, res) => {
  const { kind, name, type, size, owner } = req.body || {}; const k = KINDS[kind];
  if (!k || !type || !k.type.test(type)) throw new AppError('bad-type', kind === 'logo' ? 'Format de logo non pris en charge : PNG, SVG, JPEG ou WebP.' : 'Format non pris en charge : envoyez une vidéo (MP4 de préférence).', 400);
  if (Number(size) > k.max() * 1e6) throw new AppError('too-big', `Fichier trop lourd : ${k.max() >= 1000 ? k.max() / 1000 + ' Go' : k.max() + ' Mo'} maximum.`, 400);
  const key = `${k.prefix}/${safe(owner)}/${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${slug(name)}`;
  const url = await store.presignPut(key, type, k.ttl);
  res.json({ key, url, method: 'PUT', headers: { 'Content-Type': type } });
}));

// Après l'envoi d'un logo : contrôle du fichier et conversion SVG -> PNG transparent.
app.post('/storage/logo-finalize', adminGuard, h(async (req, res) => {
  const { key } = req.body || {}; if (!key || !String(key).startsWith('logos/')) throw new AppError('bad', MSG.badRequest, 400);
  const buf = await store.getBuffer(key);
  const isPng = buf.slice(1, 4).toString() === 'PNG';
  if (isPng) return res.json({ key });
  const png = await toPng(buf).catch(() => { throw new AppError('bad-logo', "Ce logo n'a pas pu être lu. Essayez un PNG transparent.", 400); });
  const pngKey = String(key).replace(/\.[a-z0-9]+$/i, '') + '.png';
  await store.put(pngKey, png, 'image/png');
  res.json({ key: pngKey, converted: true });
}));

// Lien de lecture temporaire (vidéo brute, logo, jingle) : utile après un rechargement de la page.
app.get('/storage/read-url', h(async (req, res) => {
  const key = String(req.query.key || '');
  if (!/^(raw|logos|jingles)\//.test(key) || key.includes('..')) throw new AppError('bad', MSG.badRequest, 400);
  res.json({ url: await store.presignGet(key, 6 * 3600), expiresIn: 6 * 3600 });
}));

/* ---------- OpusClip ---------- */
function pickOptions(o = {}) {
  return {
    kind: o.kind === 'teaser' ? 'teaser' : 'capsule', dur: Number(o.dur) || 30, fmt: String(o.fmt || ''), style: String(o.style || 'impact'),
    videoKind: String(o.videoKind || ''), momentSec: Number.isFinite(Number(o.momentSec)) && o.momentSec !== null && o.momentSec !== '' ? Number(o.momentSec) : null,
    title: String(o.title || '').slice(0, 120), seed: Number(o.seed) || 0
  };
}
const webhookUrl = () => CONFIG.publicUrl ? CONFIG.publicUrl + '/opus/webhook' : '';
const STEP = { PENDING: 0, QUEUED: 0, IMPORT: 1, CURATE: 1, REFINE: 2, RENDER: 3, UPLOAD: 3, COMPLETE: 4 };

app.post('/opus/projects', h(async (req, res) => {
  const { videoId, storageKey, options, dryRun } = req.body || {};
  if (!storageKey || !String(storageKey).startsWith('raw/')) throw new AppError('bad', 'Cette vidéo n’est pas encore prête : attendez la fin de son envoi.', 400);
  const opts = pickOptions(options);
  if (dryRun) return res.json({ dryRun: true, request: redact(buildOpusPayload(opts, { videoUrl: 'x', webhookUrl: webhookUrl() })) });
  if (!opusReady()) throw new AppError('opus-config', MSG.opusConfig, 503);

  // Un projet OpusClip par combinaison (vidéo + type + options) : on réutilise celui qui existe déjà.
  const cacheKey = hash({ storageKey, ...opts });
  const idx = await state.load('pindex', cacheKey);
  if (idx && idx.projectId) {
    const p = await state.load('projects', idx.projectId);
    if (p && p.status !== 'failed') return res.json({ projectId: idx.projectId, status: p.status, cached: true, request: p.request });
  }
  try { await store.head(storageKey); } catch (e) { throw new AppError('missing', 'La vidéo est introuvable dans le stockage : demandez à l’équipe OpenMedias de la déposer à nouveau.', 404); }

  const videoUrl = await store.presignGet(storageKey, CONFIG.opus.videoUrlTtl);
  let payload = buildOpusPayload(opts, { videoUrl, webhookUrl: webhookUrl() }); let via = 'url'; let created;
  try { created = await createProject(payload); }
  catch (e) {
    if (e.code !== 'refused' || !CONFIG.opus.uploadFallback) throw e;
    console.info('[opus] URL signée refusée : envoi du fichier par upload-links');
    payload = { ...payload, videoUrl: await uploadToOpus(storageKey) }; via = 'upload';
    created = await createProject(payload);
  }
  const request = redact(payload);
  await state.save('projects', created.projectId, { projectId: created.projectId, status: 'running', stage: created.stage, createdAt: new Date().toISOString(), videoId, storageKey, options: opts, via, request });
  await state.save('pindex', cacheKey, { projectId: created.projectId });
  console.info(`[opus] projet ${created.projectId} créé (${via})`);
  res.json({ projectId: created.projectId, status: 'running', request, via });
}));

const lastCheck = new Map();
app.get('/opus/projects/:id/status', h(async (req, res) => {
  const id = String(req.params.id);
  let p = (await state.load('projects', id)) || { projectId: id, status: 'running' };
  if (p.status === 'running' && Date.now() - (lastCheck.get(id) || 0) > CONFIG.opus.statusPollMs) {
    lastCheck.set(id, Date.now());
    const stage = await projectStage(id);
    if (stage) p.stage = stage;
    // Pas d'endpoint de statut documenté : le projet est terminé au webhook, ou dès que des clips sont disponibles.
    if (!stage || stage === 'COMPLETE') {
      const clips = await listClips(id).catch(() => []);
      if (clips.length) { p.status = 'done'; p.clips = clips; clipCache.set(id, { t: Date.now(), clips }); }
    }
    p = await state.save('projects', id, p);
  }
  res.json({ projectId: id, status: p.status, stage: p.stage || null, step: p.status === 'done' ? 4 : (STEP[p.stage] ?? null), error: p.status === 'failed' ? (p.error || MSG.refused) : null, createdAt: p.createdAt || null });
}));

const clipCache = new Map();
async function getClips(id, fresh) {
  const c = clipCache.get(id);
  if (!fresh && c && Date.now() - c.t < 60000) return c.clips;
  const clips = await listClips(id);
  clipCache.set(id, { t: Date.now(), clips });
  if (clips.length) await state.patch('projects', id, { status: 'done', clips });
  return clips;
}

app.get('/opus/projects/:id/clips', h(async (req, res) => {
  const id = String(req.params.id); const dur = Number(req.query.dur);
  let clips = await getClips(id);
  if (dur > 0 && CONFIG.opus.durationMode === 'buckets') {
    // Tranches fixes : on remonte les clips les plus proches de la durée demandée (par paliers de 5 s), ordre OpusClip ensuite.
    clips = clips.map((c, i) => ({ c, i, d: Math.floor(Math.abs(c.durSec - dur) / 5) })).sort((a, b) => a.d - b.d || a.i - b.i).map(x => x.c);
  }
  res.json({ projectId: id, clips: clips.map(({ exportUrl, ...c }) => ({ ...c, exportUrl: exportUrl ? 'serveur' : '' })) });
}));

/* ---------- Habillage ---------- */
const progressMem = new Map();
async function findClip(projectId, clipId, fresh) {
  const clips = await getClips(projectId, fresh);
  return clips.find(c => c.id === clipId || c.curationId === clipId);
}
async function fetchToFile(url, file) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60000) });
  if (!r.ok || !r.body) throw Object.assign(new Error(`téléchargement de l'extrait : HTTP ${r.status}`), { status: r.status });
  await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
}

async function renderJob(jobId) {
  const job = await state.load('renders', jobId); if (!job) return; const s = job.spec;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'om-'));
  try {
    await state.patch('renders', jobId, { status: 'running', startedAt: new Date().toISOString(), error: null });
    progressMem.set(jobId, 0.02);
    const clipPath = path.join(tmp, 'clip.mp4');
    let clip = await findClip(s.projectId, s.clipId);
    if (!clip || !clip.exportUrl) throw new Error('extrait introuvable chez OpusClip');
    try { await fetchToFile(clip.exportUrl, clipPath); }
    catch (e) { clip = await findClip(s.projectId, s.clipId, true); if (!clip) throw e; await fetchToFile(clip.exportUrl, clipPath); } // lien OpusClip renouvelé
    progressMem.set(jobId, 0.1);
    const dl = async (key, name) => key ? store.download(key, path.join(tmp, name + (path.extname(key) || '.png'))).catch(() => null) : null;
    const md = s.media || {};
    const [clientLogo, logoLight, logoDark] = await Promise.all([dl(s.clientLogoKey, 'client-src'), dl(md.logoLightKey, 'media-light'), dl(md.logoDarkKey, 'media-dark')]);
    const jingle = md.jingleKey && md.jinglePos && md.jinglePos !== 'aucun' ? await dl(md.jingleKey, 'jingle') : null;
    const out = path.join(tmp, 'final.mp4');
    await brandClip({
      clip: clipPath, out, fmt: s.fmt, tmp, clientLogo, clientName: s.clientName,
      media: { name: md.name, mention: md.mention, accent: md.accent, logoAllowed: md.logoAllowed !== false, logoLight, logoDark },
      jingle, jinglePos: md.jinglePos, hook: s.hook, timeoutMs: CONFIG.render.timeoutMs,
      onProgress: p => progressMem.set(jobId, 0.1 + p * 0.85)
    });
    const size = (await stat(out)).size;
    await store.put(job.key, await readFile(out), 'video/mp4');
    await state.patch('renders', jobId, { status: 'done', size, finishedAt: new Date().toISOString() });
    console.info(`[habillage] ${jobId} terminé (${Math.round(size / 1e5) / 10} Mo)`);
  } catch (e) {
    console.warn(`[habillage] ${jobId} en échec : ${e.message}${e.stderr ? '\n' + e.stderr.slice(-1200) : ''}`);
    await state.patch('renders', jobId, { status: 'failed', error: e.code === 'timeout' ? MSG.timeout : MSG.brand });
  } finally {
    progressMem.delete(jobId); rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Emails : premier téléchargement d'une vidéo habillée -> événement serveur video.generated (une fois par vidéo).
function notifyVideoGenerated(job) {
  const ev = EMAILS && EMAILS.engine && videoGeneratedEvent(job);
  if (ev) EMAILS.engine.ingest(ev).catch(e => console.error(JSON.stringify({ level: 'error', msg: 'video.generated_error', error: e.message })));
}

async function jobView(job) {
  const v = { jobId: job.jobId, status: job.status, progress: job.status === 'done' ? 1 : (progressMem.get(job.jobId) || 0), position: Math.max(0, position(job.jobId)), warn: job.warn || null, error: job.status === 'failed' ? job.error : null, fileName: job.fileName };
  if (job.status === 'done') { v.url = await store.presignGet(job.key, CONFIG.render.downloadTtl, job.fileName); v.expiresIn = CONFIG.render.downloadTtl; v.fileKey = job.key; notifyVideoGenerated(job); }
  return v;
}

app.post('/render/brand', h(async (req, res) => {
  const b = req.body || {}; const fmt = String(b.fmt || '');
  if (!b.projectId || !b.clipId || !BRAND_LAYOUT.formats[fmt]) throw new AppError('bad', MSG.badRequest, 400);
  const m = b.media || {}; const jingles = m.jingles && typeof m.jingles === 'object' ? m.jingles : {};
  const jingleKey = m.jingleKey || jingles[fmt] || jingles['16:9'] || jingles['9:16'] || jingles['1:1'] || null;
  const spec = {
    projectId: String(b.projectId), clipId: String(b.clipId), fmt,
    clientLogoKey: b.clientLogoKey || null, clientName: String(b.clientName || '').slice(0, 80),
    media: {
      name: String(m.name || '').slice(0, 80), mention: String(m.mention || '').slice(0, 80), accent: String(m.accent || ''),
      logoAllowed: m.logoAllowed !== false, logoLightKey: m.logoLightKey || m.logoKey || null, logoDarkKey: m.logoDarkKey || null,
      jingleKey, jinglePos: ['debut', 'fin', 'both', 'aucun'].includes(m.jinglePos) ? m.jinglePos : 'aucun'
    },
    hook: String(b.hook || '').slice(0, 80)
  };
  // Cache : même clip, même format, même version des logos -> même fichier.
  const ver = hash(spec); const jobId = 'r' + ver.slice(0, 24);
  const key = `renders/${safe(spec.projectId)}/${safe(spec.clipId)}/${fmt.replace(':', 'x')}-${ver.slice(0, 16)}.mp4`;
  const fileName = String(b.fileName || '').replace(/[^\w.\-]+/g, '_').slice(0, 120) || `video_${fmt.replace(':', 'x')}.mp4`;
  // Identité du client (pour l'événement video.generated) : hors de la clé de cache.
  const cl = b.client && typeof b.client === 'object' && /^[\w.:-]{1,120}$/.test(String(b.client.id || '')) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.client.email || ''))
    ? { id: String(b.client.id), email: String(b.client.email).slice(0, 200), name: String(b.client.name || '').slice(0, 120), contact: String(b.client.contact || '').slice(0, 120) } : null;
  const warn = jingleKey && !jingles[fmt] && !m.jingleKey && spec.media.jinglePos !== 'aucun' ? `Jingle recadré : aucune version ${fmt} n'est disponible pour ce média.` : null;

  let job = await state.load('renders', jobId);
  if (job && cl && !job.client) job = await state.patch('renders', jobId, { client: cl });
  if (job && job.status === 'done' && await store.exists(job.key)) return res.json(await jobView({ ...job, fileName }));
  if (job && isActive(jobId)) return res.json(await jobView(job));
  job = await state.save('renders', jobId, { jobId, status: 'queued', key, fileName, spec, warn, client: cl, createdAt: new Date().toISOString() });
  enqueue(jobId, () => renderJob(jobId));
  res.json(await jobView(job));
}));

app.get('/render/:jobId', h(async (req, res) => {
  const id = String(req.params.jobId); let job = await state.load('renders', id);
  if (!job) throw new AppError('not-found', 'Ce fichier est introuvable : relancez le téléchargement.', 404);
  // Tâche interrompue par un redémarrage du serveur, ou fichier final disparu : on la relance.
  if ((job.status === 'queued' || job.status === 'running') && !isActive(id)) { job = await state.patch('renders', id, { status: 'queued' }); enqueue(id, () => renderJob(id)); }
  if (job.status === 'done' && !(await store.exists(job.key))) { job = await state.patch('renders', id, { status: 'queued' }); enqueue(id, () => renderJob(id)); }
  res.json(await jobView(job)); // en cas de lien expiré, chaque appel génère une nouvelle URL signée
}));

app.use((req, res) => res.status(404).json({ error: MSG.notFound }));

startEmails().then(e => { EMAILS = e; }).catch(e => console.error(JSON.stringify({ level: 'error', msg: 'emails.start_failed', error: e.message })));

app.listen(CONFIG.port, () => {
  console.info(`OpenStudio : serveur prêt sur le port ${CONFIG.port}`);
  console.info(`  stockage ${storageReady() ? 'configuré' : 'NON configuré'}, OpusClip ${opusReady() ? 'configuré' : 'NON configuré'}, webhook ${CONFIG.publicUrl ? 'actif' : 'inactif (PUBLIC_URL vide)'}`);
  if (!CONFIG.siteOrigins.length) console.warn('  SITE_ORIGIN vide : toutes les origines sont acceptées. À renseigner avant la mise en ligne.');
});
