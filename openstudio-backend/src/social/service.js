'use strict';
/**
 * Publication des vidéos OpenStudio sur les réseaux du client (Upload-Post) et suivi des performances.
 * Règle de sécurité : chaque fonction reçoit le client authentifié et ne touche qu'à SES données
 * (profil, vidéos, publications). Les contrôles de propriété sont faits ici, côté serveur.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const mapping = require('../opusclip.config');
const storage = require('../storage');
const up = require('./uploadpost');
const captionsLib = require('./captions');

const PLATFORMS = config.social.platforms;
const PLATFORM_LABELS = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', linkedin: 'LinkedIn', facebook: 'Facebook' };

class SocialError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Traduit une erreur Upload-Post en message clair pour le client. */
function friendly(e, fallback = 'Le service de publication est momentanément indisponible. Réessayez dans quelques minutes.') {
  if (e instanceof SocialError) return e;
  if (e && e.code === 'NOT_CONFIGURED') return new SocialError('La publication sur les réseaux n’est pas encore activée sur OpenStudio.', 503, 'NOT_CONFIGURED');
  if (e && (e.code === 'PROFILE_LIMIT_REACHED' || e.code === 'PROFILE_BLOCKED')) {
    return new SocialError('La publication sur les réseaux est momentanément indisponible (limite du service atteinte). L’équipe OpenStudio a été prévenue.', 503, e.code);
  }
  if (e && e.status === 429) return new SocialError('Trop de demandes en peu de temps : réessayez dans quelques minutes.', 429, 'RATE_LIMITED');
  console.error('[social]', e && e.message, e && e.body ? JSON.stringify(e.body).slice(0, 500) : '');
  return new SocialError(fallback, 502, e && e.code);
}

// ---------------------------------------------------------------------------
// Profil Upload-Post du client (nom du profil = identifiant interne du client)
// ---------------------------------------------------------------------------
async function getProfileRow(clientId) {
  const { rows } = await db.query('SELECT * FROM social_profiles WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

/** Crée le profil au premier besoin (premier clic sur un réseau). Aucune action manuelle. */
async function ensureProfile(client) {
  const row = await getProfileRow(client.id);
  if (row) return row;
  const username = String(client.id);
  try {
    await up.createProfile(username);
  } catch (e) {
    throw friendly(e);
  }
  const { rows } = await db.query(
    `INSERT INTO social_profiles (client_id, username) VALUES ($1, $2)
     ON CONFLICT (client_id) DO UPDATE SET username = EXCLUDED.username RETURNING *`,
    [client.id, username]
  );
  return rows[0];
}

/** État des réseaux du client : connecté, à reconnecter, compte affiché, Page Facebook. */
async function accounts(client) {
  const row = await getProfileRow(client.id);
  const empty = () => Object.fromEntries(PLATFORMS.map((p) => [p, { connected: false, reauthRequired: false }]));
  if (!row) return { platforms: empty(), facebookPage: null, enabled: Boolean(config.social.apiKey) };
  let profile;
  try {
    profile = await up.getProfile(row.username);
  } catch (e) {
    if (e.status === 404) return { platforms: empty(), facebookPage: null, enabled: true };
    throw friendly(e);
  }
  const sa = (profile && profile.social_accounts) || {};
  const platforms = {};
  for (const p of PLATFORMS) {
    const a = sa[p];
    const connected = Boolean(a && typeof a === 'object');
    platforms[p] = {
      connected,
      reauthRequired: Boolean(connected && a.reauth_required),
      handle: connected ? a.handle || null : null,
      displayName: connected ? a.display_name || null : null,
      avatar: connected ? a.social_images || null : null,
    };
  }
  const page = profile && (profile.selected_page_id || row.facebook_page_id)
    ? { id: profile.selected_page_id || row.facebook_page_id, name: profile.selected_page_name || row.facebook_page_name }
    : null;
  return { platforms, facebookPage: page, enabled: true };
}

/** Démarre la connexion d'un réseau : renvoie l'URL de la fenêtre officielle du réseau. */
async function startConnect(client, platform) {
  if (!PLATFORMS.includes(platform)) throw new SocialError('Réseau non proposé', 400);
  const row = await ensureProfile(client);
  try {
    const r = await up.startOAuth(platform, row.username, `${config.publicBaseUrl}/api/social/connected`);
    if (!r.authorize_url) throw new Error('authorize_url absent');
    return { authorizeUrl: r.authorize_url, expiresIn: r.expires_in || 900 };
  } catch (e) {
    throw friendly(e, `La connexion à ${PLATFORM_LABELS[platform]} n’a pas pu démarrer. Réessayez dans quelques minutes.`);
  }
}

/** Pages Facebook du compte connecté + Page épinglée. Une seule Page : épinglée automatiquement. */
async function facebookPages(client) {
  const row = await getProfileRow(client.id);
  if (!row) return { pages: [], selectedId: null };
  let r;
  try {
    r = await up.getFacebookPages(row.username);
  } catch (e) {
    throw friendly(e);
  }
  const pages = (r.pages || []).map((p) => ({ id: String(p.id), name: p.name, picture: p.picture || null }));
  let selectedId = r.selected_page_id ? String(r.selected_page_id) : null;
  if (!selectedId && pages.length === 1) {
    await selectFacebookPage(client, pages[0].id);
    selectedId = pages[0].id;
  }
  return { pages, selectedId };
}

async function selectFacebookPage(client, pageId) {
  const row = await getProfileRow(client.id);
  if (!row) throw new SocialError('Connectez d’abord votre compte Facebook.', 400);
  let r;
  try {
    r = await up.pinFacebookPage(row.username, String(pageId));
  } catch (e) {
    if (e.status === 400) throw new SocialError('Cette Page ne peut pas être utilisée avec le compte Facebook connecté.', 400);
    throw friendly(e);
  }
  await db.query('UPDATE social_profiles SET facebook_page_id = $2, facebook_page_name = $3 WHERE client_id = $1', [client.id, String(pageId), r.facebook_page_name || null]);
  return { id: String(pageId), name: r.facebook_page_name || null };
}

// ---------------------------------------------------------------------------
// Vidéos du client (propriété vérifiée)
// ---------------------------------------------------------------------------
const videoKind = (o) => (o.type === 'subtitles' ? 'subtitles' : o.options && o.options.kind === 'teaser' ? 'teaser' : 'capsules');

/** La vidéo livrée, seulement si elle appartient au client et n'a pas été purgée. */
async function ownedVideo(client, deliverableId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(deliverableId))) throw new SocialError('Vidéo introuvable', 404);
  const { rows } = await db.query(
    `SELECT d.*, o.client_id, o.type AS order_type, o.options AS order_options, o.opus_project_id
     FROM deliverables d JOIN orders o ON o.id = d.order_id
     WHERE d.id = $1 AND o.client_id = $2`,
    [deliverableId, client.id]
  );
  const d = rows[0];
  if (!d) throw new SocialError('Vidéo introuvable', 404);
  return d;
}

function videoContext(client, d) {
  const o = d.order_options || {};
  const programme = mapping.programmes[o.programmeId];
  return {
    title: d.title || o.videoTitle || 'Vidéo',
    kind: videoKind({ type: d.order_type, options: o }),
    programme: programme ? programme.title : null,
    programmeId: o.programmeId || null,
    company: client.company || client.name,
    sector: client.sector || null,
    format: o.format || null,
  };
}

/** Transcription du clip : enregistrée à la livraison ; sinon relue chez OpusClip (projets récents). */
async function transcriptFor(d) {
  if (d.transcript) return d.transcript;
  if (!d.opus_project_id || !d.opus_clip_id) return '';
  try {
    const opus = require('../opusclip/client');
    const clips = await opus.getExportableClips(d.opus_project_id);
    const c = clips.find((x) => String(x.id) === String(d.opus_clip_id));
    const { clipTranscript } = require('./transcript');
    const text = c ? clipTranscript(c, d.duration_ms ? d.duration_ms / 1000 : null) : '';
    if (text) await db.query('UPDATE deliverables SET transcript = $2 WHERE id = $1', [d.id, text]);
    return text;
  } catch (e) {
    console.warn(`[captions] transcription indisponible pour ${d.id} : ${e.message}`);
    return '';
  }
}

/** Légendes par réseau : générées une fois puis relues en base ; « Régénérer » limité. */
async function captions(client, deliverableId, { regenerate = false } = {}) {
  const d = await ownedVideo(client, deliverableId);
  const { rows } = await db.query('SELECT * FROM video_captions WHERE deliverable_id = $1', [d.id]);
  const existing = rows[0];
  const max = config.anthropic.regenerateMax;
  if (existing && !regenerate) return publicCaptions(existing, max);
  if (existing && regenerate && existing.regen_count >= max) {
    throw new SocialError(`Vous avez déjà régénéré ces textes ${max} fois pour cette vidéo.`, 429, 'REGEN_LIMIT');
  }
  const ctx = { ...videoContext(client, d), transcript: await transcriptFor(d) };
  const g = await captionsLib.generateCaptions(ctx);
  const { rows: saved } = await db.query(
    `INSERT INTO video_captions (deliverable_id, captions, source, model, regen_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (deliverable_id) DO UPDATE SET captions = EXCLUDED.captions, source = EXCLUDED.source,
       model = EXCLUDED.model, regen_count = EXCLUDED.regen_count, updated_at = now()
     RETURNING *`,
    [d.id, JSON.stringify(g.captions), g.source, g.model, existing ? existing.regen_count + (regenerate ? 1 : 0) : 0]
  );
  return publicCaptions(saved[0], max);
}

function publicCaptions(row, max) {
  return {
    captions: row.captions,
    source: row.source, // ai | fallback
    regenerationsLeft: Math.max(0, max - row.regen_count),
    limits: captionsLib.limits(),
  };
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------
/** « 2026-11-20T18:30 » (heure de Paris) → Date UTC. */
function parisLocalToDate(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Décalage de Paris à cette date (heure d'été / d'hiver)
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asParis = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asParis - guess));
}

/** Contrôle les textes reçus pour chaque réseau coché. */
function validateTexts(platforms, texts) {
  const lim = captionsLib.limits();
  const out = {};
  for (const p of platforms) {
    const t = (texts && texts[p]) || {};
    out[p] = {};
    for (const f of Object.keys(lim[p])) {
      const v = String(t[f] || '').trim();
      if (v.length > lim[p][f]) throw new SocialError(`${PLATFORM_LABELS[p]} : texte trop long (${v.length} caractères, ${lim[p][f]} au maximum).`, 400);
      out[p][f] = v;
    }
    if (p === 'youtube' && !out.youtube.title) throw new SocialError('YouTube : le titre est obligatoire.', 400);
    if (p !== 'youtube' && !out[p].caption) throw new SocialError(`${PLATFORM_LABELS[p]} : le texte de publication est vide.`, 400);
  }
  return out;
}

/** Champs de POST /api/upload : un texte propre à chaque réseau, en un seul appel. */
function uploadFields({ username, videoUrl, title, platforms, texts, scheduledLocal, publicationId, format }) {
  const f = {
    video: videoUrl,
    user: username,
    title: title.slice(0, 100),
    'platform[]': platforms,
    async_upload: 'true',
    external_id: publicationId,
  };
  if (scheduledLocal) {
    f.scheduled_date = `${scheduledLocal}:00`;
    f.timezone = 'Europe/Paris';
  }
  if (texts.youtube) {
    f.youtube_title = texts.youtube.title;
    f.youtube_description = texts.youtube.description;
  }
  if (texts.instagram) f.instagram_title = texts.instagram.caption;
  if (texts.tiktok) f.tiktok_title = texts.tiktok.caption;
  if (texts.linkedin) {
    f.linkedin_title = title.slice(0, 200);
    f.linkedin_description = texts.linkedin.caption;
  }
  if (texts.facebook) {
    f.facebook_title = title.slice(0, 255);
    f.facebook_description = texts.facebook.caption;
    if (format === '16:9' || format === '1:1') f.facebook_media_type = 'VIDEO'; // les Reels n'acceptent que le vertical
  }
  return f;
}

async function publish(client, input) {
  const d = await ownedVideo(client, input.deliverableId);
  if (d.purged) throw new SocialError('Cette vidéo n’est plus disponible : elle a dépassé sa durée de conservation.', 410);
  const platforms = [...new Set((input.platforms || []).filter((p) => PLATFORMS.includes(p)))];
  if (!platforms.length) throw new SocialError('Cochez au moins un réseau.', 400);

  // Comptes : connectés, à jour, Page Facebook choisie
  const acc = await accounts(client);
  for (const p of platforms) {
    if (!acc.platforms[p].connected) throw new SocialError(`Connectez d’abord votre compte ${PLATFORM_LABELS[p]}.`, 400, 'NOT_CONNECTED');
    if (acc.platforms[p].reauthRequired) throw new SocialError(`Reconnectez votre compte ${PLATFORM_LABELS[p]} avant de publier.`, 400, 'REAUTH_REQUIRED');
  }
  if (platforms.includes('facebook') && !acc.facebookPage) {
    throw new SocialError('Choisissez la Page Facebook sur laquelle publier.', 400, 'FACEBOOK_PAGE_REQUIRED');
  }
  const texts = validateTexts(platforms, input.texts);

  // Programmation (heure de Paris), dans la limite de validité du lien de la vidéo
  let scheduledAt = null;
  if (input.scheduledAt) {
    scheduledAt = parisLocalToDate(input.scheduledAt);
    if (!scheduledAt) throw new SocialError('Date de programmation invalide.', 400);
    if (scheduledAt.getTime() < Date.now() + 5 * 60_000) throw new SocialError('Choisissez une date au moins 5 minutes dans le futur.', 400);
    if (scheduledAt.getTime() > Date.now() + config.social.scheduleMaxDays * 86400_000) {
      throw new SocialError(`La programmation est possible jusqu’à ${config.social.scheduleMaxDays} jours à l’avance.`, 400);
    }
    if (d.expires_at && scheduledAt > new Date(d.expires_at)) throw new SocialError('Cette date dépasse la durée de conservation de la vidéo.', 400);
  }

  const profile = await getProfileRow(client.id);
  const ctx = videoContext(client, d);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO publications (id, client_id, deliverable_id, order_id, video_title, video_kind, programme_id, platforms, texts, scheduled_at, timezone, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'submitting')`,
    [id, client.id, d.id, d.order_id, ctx.title, ctx.kind, ctx.programmeId, platforms, JSON.stringify(texts), scheduledAt, scheduledAt ? 'Europe/Paris' : null]
  );
  for (const p of platforms) {
    await db.query("INSERT INTO publication_targets (publication_id, platform, status) VALUES ($1, $2, $3)", [id, p, scheduledAt ? 'scheduled' : 'pending']);
  }

  // URL signée de la vidéo (bucket privé), valable le temps qu'Upload-Post la récupère
  const videoUrl = await storage.presignDownload(d.storage_key, d.file_name, 'inline', config.social.videoUrlTtlSec);
  try {
    const r = await up.uploadVideo(uploadFields({
      username: profile.username, videoUrl, title: ctx.title, platforms, texts,
      scheduledLocal: scheduledAt ? input.scheduledAt : null, publicationId: id, format: ctx.format,
    }));
    await db.query(
      'UPDATE publications SET request_id = $2, job_id = $3, status = $4, updated_at = now() WHERE id = $1',
      [id, r.request_id || null, r.job_id || null, scheduledAt ? 'scheduled' : 'in_progress']
    );
    if (r.results && typeof r.results === 'object') {
      // Réponse synchrone (envoi terminé très vite)
      for (const [p, res] of Object.entries(r.results)) await applyResult(id, p, { success: res.success, url: res.url, postId: res.post_id || res.publish_id, error: res.error });
    }
  } catch (e) {
    const msg = e.status && e.status < 500 && e.message ? e.message : 'Le service de publication n’a pas répondu.';
    await db.query("UPDATE publications SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, msg.slice(0, 500)]);
    await db.query("UPDATE publication_targets SET status = 'failed', error = $2 WHERE publication_id = $1", [id, msg.slice(0, 500)]);
    throw friendly(e, 'La publication n’a pas pu être envoyée. Réessayez dans quelques minutes.');
  }
  return getPublication(client, id);
}

/** Met à jour un réseau d'une publication, puis le statut global. */
async function applyResult(publicationId, platform, { success, url, postId, error, at } = {}) {
  if (!PLATFORMS.includes(platform)) return;
  await db.query(
    `UPDATE publication_targets SET status = $3, post_url = COALESCE($4, post_url), platform_post_id = COALESCE($5, platform_post_id),
       error = $6, published_at = CASE WHEN $3 = 'published' THEN COALESCE(published_at, $7, now()) ELSE published_at END
     WHERE publication_id = $1 AND platform = $2`,
    [publicationId, platform, success ? 'published' : 'failed', url || null, postId ? String(postId) : null, success ? null : String(error || 'Échec de la publication').slice(0, 500), at ? new Date(at) : null]
  );
  await recomputeStatus(publicationId);
}

async function recomputeStatus(publicationId) {
  const { rows } = await db.query('SELECT status FROM publication_targets WHERE publication_id = $1', [publicationId]);
  const st = rows.map((r) => r.status);
  if (!st.length || st.some((s) => s === 'pending' || s === 'scheduled')) return;
  const status = st.every((s) => s === 'published') ? 'published' : st.every((s) => s === 'failed') ? 'failed' : 'partial';
  await db.query('UPDATE publications SET status = $2, updated_at = now() WHERE id = $1', [publicationId, status]);
}

function publicPublication(p, targets) {
  return {
    id: p.id,
    videoId: p.deliverable_id,
    title: p.video_title,
    kind: p.video_kind,
    status: p.status,
    error: p.error,
    scheduledAt: p.scheduled_at,
    createdAt: p.created_at,
    targets: targets.map((t) => ({
      platform: t.platform,
      status: t.status,
      url: t.post_url,
      error: t.error,
      publishedAt: t.published_at,
    })),
  };
}

async function getPublication(client, id) {
  const { rows } = await db.query('SELECT * FROM publications WHERE id = $1 AND client_id = $2', [id, client.id]);
  if (!rows[0]) throw new SocialError('Publication introuvable', 404);
  const { rows: t } = await db.query('SELECT * FROM publication_targets WHERE publication_id = $1 ORDER BY platform', [id]);
  return publicPublication(rows[0], t);
}

/** Publications du client, éventuellement pour une vidéo. */
async function listPublications(client, { videoId } = {}) {
  const params = [client.id];
  let where = 'client_id = $1';
  if (videoId) {
    params.push(videoId);
    where += ` AND deliverable_id = $${params.length}`;
  }
  const { rows } = await db.query(`SELECT * FROM publications WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  if (!rows.length) return [];
  const { rows: t } = await db.query('SELECT * FROM publication_targets WHERE publication_id = ANY($1::uuid[]) ORDER BY platform', [rows.map((r) => r.id)]);
  return rows.map((p) => publicPublication(p, t.filter((x) => x.publication_id === p.id)));
}

// ---------------------------------------------------------------------------
// Suivi : notification upload_completed (signée) + interrogation de secours
// ---------------------------------------------------------------------------
function verifySignature(rawBody, headers, secret) {
  if (!secret) return { ok: false, reason: 'secret absent' };
  const sig = String(headers['x-upload-post-signature'] || '').replace(/^sha256=/, '');
  const ts = String(headers['x-upload-post-timestamp'] || '');
  if (!sig || !ts) return { ok: false, reason: 'en-têtes de signature absents' };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return { ok: false, reason: 'horodatage trop ancien' };
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'signature invalide' };
}

async function handleWebhook(rawBody, headers) {
  const check = verifySignature(rawBody, headers, config.social.webhookSecret);
  if (!check.ok) return { status: 401, reason: check.reason };
  const delivery = headers['x-upload-post-delivery'];
  if (delivery) {
    const r = await db.query('INSERT INTO social_deliveries (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [String(delivery)]);
    if (!r.rowCount) return { status: 200, duplicate: true };
  }
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, reason: 'JSON invalide' };
  }
  if (body.event !== 'upload_completed') return { status: 200, ignored: body.event }; // reconnexion : lue en direct sur le profil
  const { rows } = await db.query(
    'SELECT * FROM publications WHERE id::text = $1 OR (request_id IS NOT NULL AND request_id = $2) OR (job_id IS NOT NULL AND job_id = $3) LIMIT 1',
    [String(body.external_id || ''), String(body.request_id || ''), String(body.job_id || '')]
  );
  const pub = rows[0];
  if (!pub) return { status: 200, unknown: true };
  if (body.request_id && !pub.request_id) await db.query('UPDATE publications SET request_id = $2 WHERE id = $1', [pub.id, body.request_id]);
  const r = body.result || {};
  await applyResult(pub.id, body.platform, { success: r.success, url: r.url, postId: r.post_id || r.publish_id, error: r.error, at: body.created_at });
  return { status: 200 };
}

/** Secours : interroge le statut des publications en cours (si la notification n'est pas arrivée). */
async function pollPending(limit = 5) {
  const { rows } = await db.query(
    `SELECT * FROM publications
     WHERE status IN ('in_progress', 'scheduled')
       AND (scheduled_at IS NULL OR scheduled_at < now())
       AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => $1))
     ORDER BY updated_at ASC LIMIT $2`,
    [config.social.statusPollSec, limit]
  );
  for (const pub of rows) {
    await db.query('UPDATE publications SET last_polled_at = now() WHERE id = $1', [pub.id]);
    try {
      const s = await up.getStatus({ requestId: pub.request_id, jobId: pub.request_id ? null : pub.job_id });
      if (s.request_id && !pub.request_id) await db.query('UPDATE publications SET request_id = $2 WHERE id = $1', [pub.id, s.request_id]);
      for (const res of s.results || []) {
        if (res.platform) await applyResult(pub.id, res.platform, { success: res.success, url: res.url || res.post_url, postId: res.post_id || res.platform_post_id, error: res.error || (res.success ? null : res.message), at: res.upload_timestamp });
      }
      if (s.status === 'failed' && !(s.results || []).length) {
        await db.query("UPDATE publication_targets SET status = 'failed', error = $2 WHERE publication_id = $1 AND status IN ('pending','scheduled')", [pub.id, s.message || 'Échec de la publication']);
        await recomputeStatus(pub.id);
      }
    } catch (e) {
      console.warn(`[social] statut ${pub.id} : ${e.message}`);
    }
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Performances (statistiques des posts publiés depuis OpenStudio, mises en cache en base)
// ---------------------------------------------------------------------------
const METRIC_ALIASES = {
  views: ['views', 'video_views', 'plays', 'play_count', 'view_count', 'impressions'],
  likes: ['likes', 'like_count', 'reactions', 'reactions_count'],
  comments: ['comments', 'comment_count', 'comments_count'],
  shares: ['shares', 'share_count', 'shares_count', 'reposts'],
};
/** Valeur d'une métrique, ou null si le réseau ne la fournit pas (affichée « — », jamais 0). */
function metric(m, name) {
  if (!m || typeof m !== 'object') return null;
  for (const k of METRIC_ALIASES[name]) {
    const v = m[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

async function refreshStats(pub) {
  if (!pub.request_id) return false;
  let r;
  try {
    r = await up.getPostAnalytics(pub.request_id);
  } catch (e) {
    console.warn(`[social] statistiques ${pub.id} : ${e.message}`);
    return false;
  }
  for (const [platform, s] of Object.entries(r.platforms || {})) {
    if (!PLATFORMS.includes(platform)) continue;
    const m = s.post_metrics || null;
    await db.query(
      `UPDATE publication_targets SET views = $3, likes = $4, comments = $5, shares = $6, stats_error = $7, stats_at = now(),
         post_url = COALESCE(post_url, $8), platform_post_id = COALESCE(platform_post_id, $9)
       WHERE publication_id = $1 AND platform = $2`,
      [pub.id, platform, metric(m, 'views'), metric(m, 'likes'), metric(m, 'comments'), metric(m, 'shares'), s.post_metrics_error || null, s.post_url || null, s.platform_post_id || null]
    );
  }
  return true;
}

/** Actualise les statistiques plus vieilles que `maxAgeHours` (une publication à la fois : limites de l'API). */
async function refreshStale({ clientId = null, maxAgeHours = config.social.statsMaxAgeHours, limit = 20 } = {}) {
  const params = [maxAgeHours, limit];
  let where = '';
  if (clientId) {
    params.push(clientId);
    where = `AND p.client_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT p.* FROM publications p
     WHERE p.status IN ('published', 'partial') AND p.request_id IS NOT NULL ${where}
       AND EXISTS (SELECT 1 FROM publication_targets t WHERE t.publication_id = p.id AND t.status = 'published'
                   AND (t.stats_at IS NULL OR t.stats_at < now() - make_interval(hours => $1::int)))
     ORDER BY p.created_at DESC LIMIT $2`,
    params
  );
  let n = 0;
  for (const p of rows) if (await refreshStats(p)) n += 1;
  return n;
}

/** Bouton « Actualiser » : une fois toutes les 15 minutes par client. */
async function manualRefresh(client) {
  const row = await getProfileRow(client.id);
  if (!row) return { refreshed: 0 };
  const wait = row.stats_refresh_at ? config.social.manualRefreshMinutes * 60_000 - (Date.now() - new Date(row.stats_refresh_at).getTime()) : 0;
  if (wait > 0) throw new SocialError(`Les statistiques ont été actualisées il y a peu. Réessayez dans ${Math.ceil(wait / 60_000)} min.`, 429, 'REFRESH_LIMIT');
  await db.query('UPDATE social_profiles SET stats_refresh_at = now() WHERE client_id = $1', [client.id]);
  return { refreshed: await refreshStale({ clientId: client.id, maxAgeHours: 0, limit: 100 }) };
}

const PERIODS = { '7': 7, '30': 30, '90': 90 };

/** Page « Performances » : indicateurs, filtres et liste par vidéo (les plus vues d'abord). */
async function performance(client, filters = {}) {
  await refreshStale({ clientId: client.id }); // actualisation automatique au-delà de 24 h
  const params = [client.id];
  const where = ["p.client_id = $1", "t.status = 'published'"];
  const days = PERIODS[String(filters.period)] || null;
  if (days) {
    params.push(days);
    where.push(`COALESCE(t.published_at, p.created_at) >= now() - make_interval(days => $${params.length}::int)`);
  }
  if (filters.platform && PLATFORMS.includes(filters.platform)) {
    params.push(filters.platform);
    where.push(`t.platform = $${params.length}`);
  }
  if (['capsules', 'teaser', 'subtitles'].includes(filters.kind)) {
    params.push(filters.kind);
    where.push(`p.video_kind = $${params.length}`);
  }
  if (filters.programme && mapping.programmes[filters.programme]) {
    params.push(filters.programme);
    where.push(`p.programme_id = $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT p.id, p.deliverable_id, p.video_title, p.video_kind, p.programme_id, p.created_at,
            t.platform, t.post_url, t.published_at, t.views, t.likes, t.comments, t.shares, t.stats_at, t.stats_error
     FROM publications p JOIN publication_targets t ON t.publication_id = p.id
     WHERE ${where.join(' AND ')}`,
    params
  );
  const byPub = new Map();
  const sum = (a, b) => (b == null ? a : (a || 0) + Number(b));
  const totals = { publications: 0, views: null, likes: null, comments: null, shares: null };
  let lastUpdate = null;
  for (const r of rows) {
    if (!byPub.has(r.id)) {
      const prog = mapping.programmes[r.programme_id];
      byPub.set(r.id, { id: r.id, videoId: r.deliverable_id, title: r.video_title, kind: r.video_kind, programme: prog ? prog.title : null, publishedAt: r.published_at || r.created_at, views: null, networks: [] });
    }
    const v = byPub.get(r.id);
    if (r.published_at && new Date(r.published_at) < new Date(v.publishedAt)) v.publishedAt = r.published_at;
    v.networks.push({ platform: r.platform, url: r.post_url, views: r.views == null ? null : Number(r.views), likes: r.likes == null ? null : Number(r.likes), comments: r.comments == null ? null : Number(r.comments), shares: r.shares == null ? null : Number(r.shares), unavailable: r.stats_error || null });
    v.views = sum(v.views, r.views);
    for (const k of ['views', 'likes', 'comments', 'shares']) totals[k] = sum(totals[k], r[k]);
    if (r.stats_at && (!lastUpdate || new Date(r.stats_at) > lastUpdate)) lastUpdate = new Date(r.stats_at);
  }
  const videos = [...byPub.values()].sort((a, b) => (b.views || 0) - (a.views || 0));
  totals.publications = videos.length;
  const prof = await getProfileRow(client.id);
  const nextManual = prof && prof.stats_refresh_at ? new Date(new Date(prof.stats_refresh_at).getTime() + config.social.manualRefreshMinutes * 60_000) : null;
  return {
    totals,
    videos,
    lastUpdate,
    manualRefreshAvailableAt: nextManual && nextManual > new Date() ? nextManual : null,
    programmes: Object.entries(mapping.programmes).map(([id, p]) => ({ id, title: p.title })),
  };
}

module.exports = {
  SocialError,
  PLATFORMS,
  PLATFORM_LABELS,
  friendly,
  ensureProfile,
  accounts,
  startConnect,
  facebookPages,
  selectFacebookPage,
  ownedVideo,
  captions,
  publish,
  applyResult,
  listPublications,
  getPublication,
  verifySignature,
  handleWebhook,
  pollPending,
  metric,
  refreshStats,
  refreshStale,
  manualRefresh,
  performance,
  parisLocalToDate,
  uploadFields,
  validateTexts,
};
