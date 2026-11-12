// Relais OpusClip. La clé reste ici : elle n'est jamais renvoyée au navigateur ni écrite dans un journal.
// Doc : https://help.opus.pro/api-reference (create-project, get-clips, brand-template, webhook).
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { AppError, MSG } from './errors.js';
import { getStream } from './storage.js';

/* ---------- Options client -> requête OpusClip ---------- */
// Miroir de CAP_OPTIONS côté client (index.html). Toute nouvelle option se traduit ici, et seulement ici.
export const OPUS_MAP = {
  kinds: {
    capsule: { durs: [15, 30, 45, 60] },
    teaser: { durs: [20, 30, 40] }
  },
  fmts: { '9:16': 'portrait', '1:1': 'square', '16:9': 'landscape' },
  // Tranches documentées par OpusClip (secondes). Utilisées tant que l'intervalle libre n'est pas confirmé.
  buckets: [[0, 30], [30, 60], [60, 90], [90, 180]],
  // Type de vidéo (champ « Type » du dépôt admin) -> modèle de découpe.
  basicKinds: ['Émission', 'Interview', 'Plateau TV', 'Plateau'],
  genres: { 'Émission': 'Q&A', 'Interview': 'Q&A', 'Plateau TV': 'Q&A', 'Plateau': 'Q&A', 'Reportage': 'Auto', 'Immersion': 'Auto' },
  teaserPrompt: "Trailer for a French-language TV business show: pick the most gripping, self-contained moments (strong statement, striking figure, emotion, visual action) that make viewers want to watch the full episode, without revealing its conclusion.",
  momentBefore: 30, momentAfter: 90
};

// Tranche(s) contenant la durée demandée. Une durée sur une borne (30, 60) prend les deux tranches voisines.
export function durationBuckets(dur) {
  const hit = OPUS_MAP.buckets.filter(([a, b]) => dur >= a && dur <= b);
  return hit.length ? hit : [OPUS_MAP.buckets[0]];
}

/**
 * Traduit les options choisies par le client en corps de requête POST /api/clip-projects.
 * options = { kind, dur, fmt, style, videoKind, momentSec?, title?, seed? }
 * ctx = { videoUrl, webhookUrl }
 */
export function buildOpusPayload(options, ctx = {}) {
  const o = options || {};
  const kind = o.kind === 'teaser' ? 'teaser' : 'capsule';
  const durs = OPUS_MAP.kinds[kind].durs;
  const dur = durs.includes(Number(o.dur)) ? Number(o.dur) : (kind === 'teaser' ? 30 : 30);
  const fmt = OPUS_MAP.fmts[o.fmt] ? o.fmt : (kind === 'teaser' ? '16:9' : '9:16');
  const style = ['impact', 'classique', 'minimal'].includes(o.style) ? o.style : 'impact';
  const model = kind === 'teaser' || !OPUS_MAP.basicKinds.includes(o.videoKind) ? 'ClipAnything' : 'ClipBasic';

  const curationPref = {
    model,
    clipDurations: CONFIG.opus.durationMode === 'free' ? [[Math.max(0, dur - 5), dur + 10]] : durationBuckets(dur),
    genre: OPUS_MAP.genres[o.videoKind] || 'Auto',
    // Accroche OpusClip désactivée : elle se superposerait aux logos ajoutés par notre serveur.
    enableAutoHook: false
  };
  if (kind === 'teaser') curationPref.customPrompt = OPUS_MAP.teaserPrompt;
  const m = o.momentSec == null || o.momentSec === '' ? NaN : Number(o.momentSec);
  if (Number.isFinite(m) && m >= 0) curationPref.range = { startSec: Math.max(0, Math.floor(m - OPUS_MAP.momentBefore)), endSec: Math.ceil(m + OPUS_MAP.momentAfter) };

  const payload = {
    videoUrl: ctx.videoUrl || '',
    curationPref,
    importPref: { sourceLang: 'fr' },
    renderPref: { layoutAspectRatio: OPUS_MAP.fmts[fmt] }
  };
  const tpl = CONFIG.opus.templates[style];
  if (tpl) payload.brandTemplateId = tpl;
  if (o.title) payload.uploadedVideoAttr = { title: String(o.title).slice(0, 120) };
  if (ctx.webhookUrl) payload.conclusionActions = [{ type: 'WEBHOOK', notifyFailure: true, url: ctx.webhookUrl }];
  return payload;
}

// Copie affichable de la requête (URL signée masquée).
export const redact = p => ({ ...p, videoUrl: p.videoUrl ? '[URL signée masquée]' : '' });

/* ---------- Appels HTTP ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function headers(json = true) {
  const h = { Authorization: `Bearer ${CONFIG.opus.apiKey}`, Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  if (CONFIG.opus.orgId) h['x-opus-org-id'] = CONFIG.opus.orgId;
  return h;
}

async function opusFetch(path, { method = 'GET', body, retries = 2 } = {}) {
  if (!CONFIG.opus.apiKey) throw new AppError('opus-config', MSG.opusConfig, 503);
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(CONFIG.opus.base + path, { method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    } catch (e) {
      if (attempt < retries) { await sleep(3000 * (attempt + 1)); continue; }
      throw new AppError('unavailable', MSG.unavailable, 503);
    }
    if (r.ok) { const t = await r.text(); return t ? JSON.parse(t) : null; }
    let data = null; try { data = await r.json(); } catch (e) {}
    if (r.status === 403 && data && data.code === 'API_MONTHLY_CAP_REACHED') throw new AppError('quota', MSG.quota, 429, { resetAt: data.reset_at });
    if (r.status === 429) {
      // Limite de projets simultanés (X-Cap-Reason: concurrent) ou 30 requêtes/minute : on patiente puis on réessaie.
      if (attempt < retries + 2) { await sleep([5000, 15000, 30000, 45000][attempt] || 45000); continue; }
      throw new AppError('busy', MSG.busy, 429);
    }
    if (r.status >= 500 && attempt < retries) { await sleep(4000 * (attempt + 1)); continue; }
    if (r.status === 404) throw new AppError('not-found', MSG.notFound, 404);
    if (r.status === 401 || r.status === 403) throw new AppError('opus-auth', MSG.opusConfig, 503);
    const why = data && (data.message || data.error) ? String(data.message || data.error).slice(0, 200) : `HTTP ${r.status}`;
    console.warn(`[opus] ${method} ${path.split('?')[0]} refusé : ${why}`);
    throw new AppError('refused', MSG.refused, 422, { opusStatus: r.status });
  }
}

/* ---------- Création de projet ---------- */
export async function createProject(payload) {
  const res = await opusFetch('/clip-projects', { method: 'POST', body: payload });
  const projectId = res && (res.projectId || res.id);
  if (!projectId) throw new AppError('refused', MSG.refused, 422);
  return { projectId, stage: res.stage || null };
}

// Repli : envoi du fichier depuis notre stockage vers OpusClip (doc « Upload Video and Create Clip Project »).
export async function uploadToOpus(storageKey) {
  const link = await opusFetch('/upload-links', { method: 'POST', body: { video: { usecase: 'LocalUpload' } } });
  if (!link || !link.url || !link.uploadId) throw new AppError('refused', MSG.refused, 422);
  const start = await fetch(link.url, { method: 'POST', headers: { 'x-goog-resumable': 'start', 'Content-Length': '0' } });
  const location = start.headers.get('location');
  if (!start.ok || !location) throw new AppError('refused', MSG.refused, 422);
  const { stream, length } = await getStream(storageKey);
  const up = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...(length ? { 'Content-Length': String(length) } : {}) }, body: stream, duplex: 'half' });
  if (!up.ok) throw new AppError('refused', MSG.refused, 422);
  return link.uploadId;
}

/* ---------- Clips ---------- */
// timeRanges : la doc annonce des secondes mais son exemple (192170-211630) ressemble à des millisecondes.
// On choisit l'unité dont la somme des segments est la plus proche de durationMs.
export function rangesToSec(ranges, durationMs) {
  const rs = (Array.isArray(ranges) ? ranges : []).filter(r => Array.isArray(r) && r.length >= 2).map(([a, b]) => [Number(a), Number(b)]);
  if (!rs.length) return null;
  const span = rs.reduce((s, [a, b]) => s + (b - a), 0); const durS = (Number(durationMs) || 0) / 1000;
  const ms = durS ? Math.abs(span / 1000 - durS) < Math.abs(span - durS) : rs[0][0] > 36000;
  const k = ms ? 1000 : 1;
  return { startSec: rs[0][0] / k, endSec: rs[rs.length - 1][1] / k, segments: rs.map(([a, b]) => [a / k, b / k]) };
}

export function normalizeClip(c) {
  const durSec = Math.round((Number(c.durationMs) || 0) / 100) / 10;
  const r = rangesToSec(c.timeRanges, c.durationMs) || { startSec: 0, endSec: durSec, segments: [] };
  return {
    id: String(c.id || ''),
    curationId: String(c.curationId || String(c.id || '').split('.').pop() || ''),
    title: String(c.title || ''),
    description: String(c.description || ''),
    hashtags: String(c.hashtags || ''),
    text: String(c.text || ''),
    startSec: r.startSec, endSec: r.endSec, segments: r.segments,
    durSec,
    previewUrl: String(c.uriForPreview || ''),
    exportUrl: String(c.uriForExport || ''),
    score: null // l'API ne fournit pas de score viral
  };
}

export async function listClips(projectId) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const q = `/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}&pageNum=${page}&pageSize=50`;
    const arr = await opusFetch(q);
    const list = Array.isArray(arr) ? arr : (arr && Array.isArray(arr.data) ? arr.data : []);
    out.push(...list);
    if (list.length < 50) break;
  }
  return out.map(normalizeClip).filter(c => c.id);
}

// Endpoint non documenté : on tente de lire l'étape du projet ; s'il n'existe pas, on s'en passe définitivement.
let projectEndpoint = true;
export async function projectStage(projectId) {
  if (!projectEndpoint) return null;
  try { const p = await opusFetch(`/clip-projects/${encodeURIComponent(projectId)}`, { retries: 0 }); return p && (p.stage || null); }
  catch (e) { if (e.code === 'not-found' || e.code === 'refused') projectEndpoint = false; return null; }
}

/* ---------- Webhook ---------- */
const seenSalts = new Map(); // salt -> horodatage (anti-rejeu, 10 minutes)
export function verifyWebhook(rawBody, hdrs) {
  const secret = CONFIG.opus.apiKey; if (!secret) return false;
  const salt = hdrs['x-opus-salt']; const received = hdrs['x-opus-signature']; const ts = parseInt(hdrs['x-opus-timestamp'], 10);
  if (!received || !salt || Number.isNaN(ts)) return false;
  const expected = crypto.createHmac('sha256', secret).update(Buffer.concat([rawBody, Buffer.from(String(salt))])).digest('hex');
  const a = Buffer.from(String(received), 'hex'), b = Buffer.from(expected, 'hex');
  if (!(a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b))) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) >= 300) return false;
  const now = Date.now(); for (const [s, t] of seenSalts) if (now - t > 600000) seenSalts.delete(s);
  if (seenSalts.has(salt)) return false; seenSalts.set(salt, now);
  return true;
}

// Le contenu du webhook n'est pas documenté : lecture tolérante.
export function readWebhook(body) {
  const b = body || {}; const d = b.data || b.project || b;
  const projectId = d.projectId || d.id || b.projectId || b.id || null;
  const txt = JSON.stringify([d.stage, d.status, b.status, b.event, b.type, d.error, b.error]).toUpperCase();
  const failed = /FAIL|ERROR|STALL/.test(txt) && !/"(COMPLETE|SUCCESS|SUCCEEDED)"/.test(txt);
  return { projectId: projectId ? String(projectId) : null, failed, stage: d.stage || b.status || null };
}
