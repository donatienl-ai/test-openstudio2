'use strict';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const archiver = require('archiver');

const config = require('./config');
const mapping = require('./opusclip.config');
const db = require('./db');
const orders = require('./orders');
const clients = require('./clients');
const { validateClientVideo } = require('./clientVideos');
const storage = require('./storage');
const worker = require('./worker');
const { tokensMatch, tokenFromRequest, isAdmin } = require('./auth');
const { normalizeOptions, extractProjectId, ValidationError, VIDEO_TYPES } = require('./opusclip/payload');
const { verifyOpusWebhook } = require('./opusclip/webhook');
const { validateSubtitleFile } = require('./media/subtitles');
const { MockPaymentProvider } = require('./payment');

const router = express.Router();
const json = express.json({ limit: '200kb' });

// Paiement : simulé en environnement de test
const payment = new MockPaymentProvider(async (orderId, ref) => {
  const paid = await orders.markPaid(orderId, ref);
  if (paid && VIDEO_TYPES.has(paid.type)) worker.nudge(); // déclenche le traitement OpusClip
  return paid;
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Commande accessible par : jeton de commande, espace client propriétaire, ou équipe. */
async function loadOrder(req, res) {
  const order = await orders.get(req.params.id);
  let allowed = false;
  if (order) {
    if (isAdmin(req) || tokensMatch(order.access_token, tokenFromRequest(req))) allowed = true;
    else if (order.client_id) {
      const client = await clients.fromRequest(req);
      allowed = Boolean(client && client.id === order.client_id);
    }
  }
  if (!allowed) {
    res.status(404).json({ error: 'Commande introuvable' });
    return null;
  }
  return order;
}

async function requireClient(req, res) {
  const client = await clients.fromRequest(req);
  if (!client) res.status(401).json({ error: 'Espace client non reconnu' });
  return client;
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.status(401).json({ error: 'non autorisé' });
  return false;
}

const STATUS_LABELS = {
  draft: 'Brouillon',
  validated: 'Validée — en attente de paiement',
  paid: 'Payée',
  submitting: 'Envoi en cours',
  processing: 'En traitement',
  opus_done: 'Finalisation',
  postprocessing: 'Finalisation',
  ready: 'Prête',
  error: 'En erreur',
  dry_run: 'Test (dry run) — aucune vidéo générée',
};

function publicOrder(order, deliverablesCount = 0) {
  return {
    id: order.id,
    type: order.type,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status] || order.status,
    paymentStatus: order.payment_status,
    options: order.options,
    error: order.status === 'error' ? 'Un problème est survenu, notre équipe a été prévenue.' : null,
    createdAt: order.created_at,
    readyAt: order.ready_at,
    deliverablesCount,
  };
}

function publicVideo(v) {
  const programme = mapping.programmes[v.programme_id];
  return {
    id: v.id,
    title: v.title,
    programmeId: v.programme_id,
    programme: programme ? programme.title : v.programme_id,
    broadcastDate: v.broadcast_date,
  };
}

// ---------------------------------------------------------------------------
// Catalogue (options configurées)
// ---------------------------------------------------------------------------
router.get('/catalog', (req, res) => {
  res.json({
    clientUploads: config.clientUploadsEnabled,
    programmes: Object.entries(mapping.programmes).map(([id, p]) => ({ id, title: p.title })),
    capsules: {
      durations: Object.keys(mapping.capsules.durations).map((d) => `${d} s`),
      formats: Object.keys(mapping.capsules.formats),
      subtitleStyles: Object.keys(mapping.capsules.subtitleStyles),
    },
    subtitles: {
      languages: Object.keys(mapping.subtitles.languages),
      translationEnabled: mapping.subtitles.translationEnabled,
      sizes: Object.keys(mapping.subtitles.style.sizes),
      outlines: Object.keys(mapping.subtitles.style.outlines),
    },
  });
});

// ---------------------------------------------------------------------------
// Espace client
// ---------------------------------------------------------------------------
/** Le client et les vidéos de son package (étape 1 « Vidéo » de la page Capsules). */
router.get('/me', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const videos = await clients.listVideos(client.id);
  res.json({
    client: { id: client.id, name: client.name, company: client.company, hasLogo: Boolean(client.logo_key) },
    videos: videos.map(publicVideo),
    clientUploads: config.clientUploadsEnabled,
  });
}));

/** Mode test : le client ajoute lui-même une vidéo (déjà envoyée via /api/uploads) à son package. */
router.post('/me/videos', json, wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const r = validateClientVideo(req.body, { enabled: config.clientUploadsEnabled, programmes: mapping.programmes });
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const h = await storage.head(r.value.sourceKey);
  if (!h.exists) return res.status(400).json({ error: 'Vidéo introuvable dans le stockage : l’envoi n’est peut-être pas terminé.' });
  if (h.contentType && !/^video\//.test(h.contentType)) return res.status(400).json({ error: 'Ce fichier n’est pas une vidéo.' });
  const v = await clients.addVideo(client.id, r.value);
  res.status(201).json({ video: publicVideo(v) });
}));

router.get('/me/orders', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const list = await orders.listForClient(client.id);
  res.json({ orders: list.map((o) => publicOrder(o)) });
}));

// ---------------------------------------------------------------------------
// Uploads directs navigateur → stockage (URL signée)
// ---------------------------------------------------------------------------
const UPLOAD_KINDS = {
  video: { exts: ['.mp4', '.mov', '.m4v', '.webm', '.mkv'], types: /^video\// },
  transcript: { exts: ['.srt', '.vtt'], types: /^(application\/x-subrip|text\/vtt|text\/plain|text\/srt|application\/octet-stream)?$/ },
  logo: { exts: ['.png', '.jpg', '.jpeg', '.webp'], types: /^image\// },
};
UPLOAD_KINDS.srt = UPLOAD_KINDS.transcript; // compatibilité

router.post('/uploads', json, wrap(async (req, res) => {
  const { kind, fileName, contentType } = req.body || {};
  const spec = UPLOAD_KINDS[kind];
  if (!spec) return res.status(400).json({ error: 'Type de fichier inconnu' });
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!spec.exts.includes(ext)) return res.status(400).json({ error: `Extension non acceptée (${spec.exts.join(', ')})` });
  const ct = String(contentType || '');
  if (!spec.types.test(ct)) return res.status(400).json({ error: 'Type de contenu non accepté' });

  const folder = kind === 'srt' ? 'transcript' : kind;
  const key = `uploads/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}/${folder}${ext}`;
  const uploadUrl = await storage.presignUpload(key, ct || 'application/octet-stream', 3600);
  res.json({ key, uploadUrl, method: 'PUT', headers: { 'Content-Type': ct || 'application/octet-stream' } });
}));

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------
const ORDER_TYPES = ['capsules', 'subtitles', 'visuels', 'publications', 'photo'];

router.post('/orders', json, wrap(async (req, res) => {
  const { type, options, client: contact } = req.body || {};
  if (!ORDER_TYPES.includes(type)) return res.status(400).json({ error: 'Type de commande invalide' });
  const client = await clients.fromRequest(req);
  // Les capsules partent des vidéos du package : l'espace client est obligatoire
  if (type === 'capsules' && !client) return res.status(401).json({ error: 'Espace client requis pour commander des capsules' });
  const order = await orders.create({ type, options: options || {}, client: contact || {}, clientId: client?.id });
  res.status(201).json({ order: publicOrder(order), accessToken: order.access_token });
}));

/** Le client clique sur le bouton de validation final. */
router.post('/orders/:id/validate', wrap(async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (order.status !== 'draft') return res.json({ order: publicOrder(order) });

  let normalized;
  try {
    const context = {};
    if (order.type === 'capsules') context.video = await clients.getVideo(order.client_id, order.options?.videoId);
    normalized = normalizeOptions(order.type, order.options, mapping, context);

    const needsLogo = order.type === 'capsules' || (order.type === 'subtitles' && mapping.logos.onSubtitledVideo);
    if (needsLogo) {
      const client = order.client_id ? await clients.get(order.client_id) : null;
      if (!normalized.clientLogoKey && !client?.logo_key) {
        throw new ValidationError("Le logo de votre entreprise est nécessaire : contactez l'équipe OpenStudio");
      }
    }
    if (order.type === 'subtitles') {
      const v = await storage.head(normalized.videoKey);
      if (!v.exists) throw new ValidationError('La vidéo ajoutée est introuvable');
      if (normalized.transcriptKey) {
        const check = validateSubtitleFile(await storage.getText(normalized.transcriptKey));
        if (!check.valid) throw new ValidationError(`Transcription invalide : ${check.errors.slice(0, 3).join(' ; ')}`);
      }
    }
  } catch (e) {
    if (e instanceof ValidationError) return res.status(422).json({ error: e.message });
    throw e;
  }
  const updated = await orders.markValidated(order.id, normalized, normalized.mode || null);
  res.json({ order: publicOrder(updated || (await orders.get(order.id))) });
}));

/** Paiement simulé (environnement de test). */
router.post('/orders/:id/pay/simulate', wrap(async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (order.status === 'draft') return res.status(409).json({ error: "La commande doit d'abord être validée" });
  await payment.startPayment(order); // idempotent : sans effet si déjà payée
  res.json({ order: publicOrder(await orders.get(order.id)) });
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  const deliverables = await orders.listDeliverables(order.id);
  res.json({ order: publicOrder(order, deliverables.length) });
}));

/** Fichiers prêts avec liens signés (aperçu + téléchargement). */
router.get('/orders/:id/downloads', wrap(async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (order.status !== 'ready') return res.json({ files: [], status: order.status });
  const deliverables = await orders.listDeliverables(order.id);
  const files = await Promise.all(
    deliverables.map(async (d) => ({
      id: d.id,
      fileName: d.file_name,
      title: d.title,
      kind: /\.mp4$/i.test(d.file_name) ? 'video' : path.extname(d.file_name).slice(1),
      durationMs: d.duration_ms,
      sizeBytes: Number(d.size_bytes || 0),
      expiresAt: d.expires_at,
      previewUrl: /\.mp4$/i.test(d.file_name) ? await storage.presignDownload(d.storage_key, d.file_name, 'inline') : null,
      downloadUrl: await storage.presignDownload(d.storage_key, d.file_name, 'attachment'),
    }))
  );
  res.json({ files, linkTtlSec: config.storage.urlTtlSec });
}));

/** Tous les fichiers d'une commande en un zip (flux, sans fichier temporaire). */
router.get('/orders/:id/download.zip', wrap(async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (order.status !== 'ready') return res.status(409).json({ error: 'Commande pas encore prête' });
  const deliverables = await orders.listDeliverables(order.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="openstudio-${order.id.slice(0, 8)}.zip"`);
  const zip = archiver('zip', { store: true }); // vidéos déjà compressées
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  for (const d of deliverables) zip.append(await storage.getStream(d.storage_key), { name: d.file_name });
  await zip.finalize();
}));

// ---------------------------------------------------------------------------
// Webhook OpusClip (le corps BRUT est requis pour vérifier la signature)
// ---------------------------------------------------------------------------
router.post('/webhooks/opusclip', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const result = await verifyOpusWebhook(req.body, req.headers, config.opus.webhookSecret, async (salt) => {
    const r = await db.query('INSERT INTO webhook_salts (salt) VALUES ($1) ON CONFLICT DO NOTHING RETURNING salt', [salt]);
    return r.rowCount === 0; // déjà vu
  });
  if (!result.ok) {
    console.warn(`[webhook] rejeté : ${result.reason}`);
    return res.status(401).json({ error: 'signature invalide' });
  }

  let body = null;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    /* corps non JSON */
  }
  const projectId = extractProjectId(body);
  const order = projectId ? await orders.getByProjectId(projectId) : null;
  if (!order) {
    console.warn('[webhook] projet inconnu', projectId);
    return res.status(200).json({ ok: true }); // 200 pour éviter les renvois inutiles
  }
  await db.logEvent(order.id, 'webhook', body);

  const text = JSON.stringify(body || {}).toUpperCase();
  if (/"(STATUS|STAGE|EVENT|TYPE)"\s*:\s*"[^"]*(FAIL|ERROR)/.test(text)) {
    await orders.fail(order.id, 'OpusClip a signalé un échec (webhook)');
  } else {
    await orders.markOpusDone(order.id, 'webhook');
    worker.nudge();
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Administration (équipe) — Authorization: Bearer <ADMIN_TOKEN>
// ---------------------------------------------------------------------------

/** Créer un client → renvoie son identifiant et son jeton d'espace. */
router.post('/admin/clients', json, wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, company, email, logoKey } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nom du client requis' });
  const c = await clients.create({ name, company, email, logoKey });
  res.status(201).json({ client: { id: c.id, name: c.name, company: c.company }, clientToken: c.access_token });
}));

router.get('/admin/clients', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ clients: await clients.list() });
}));

/** Mettre à jour un client (ex. logo de l'entreprise après upload via /api/uploads kind=logo). */
router.post('/admin/clients/:id', json, wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = await clients.update(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  res.json({ client: { id: c.id, name: c.name, company: c.company, logoKey: c.logo_key } });
}));

/** Ajouter une vidéo au package d'un client (vidéo déjà déposée dans le stockage). */
router.post('/admin/clients/:id/videos', json, wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const client = await clients.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  const { programmeId, title, sourceKey, broadcastDate } = req.body || {};
  if (!mapping.programmes[programmeId]) {
    return res.status(400).json({ error: `Programme inconnu. Disponibles : ${Object.keys(mapping.programmes).join(', ')}` });
  }
  if (!title || !sourceKey) return res.status(400).json({ error: 'title et sourceKey requis' });
  const h = await storage.head(sourceKey);
  if (!h.exists) return res.status(400).json({ error: `Fichier introuvable dans le stockage : ${sourceKey}` });
  const v = await clients.addVideo(client.id, { programmeId, title, sourceKey, broadcastDate });
  res.status(201).json({ video: publicVideo(v) });
}));

router.get('/admin/clients/:id/videos', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ videos: (await clients.listVideos(req.params.id)).map(publicVideo) });
}));

/** Retirer une vidéo du package (elle reste en base mais n'est plus proposée). */
router.post('/admin/clients/:id/videos/:videoId/disable', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await clients.setVideoActive(req.params.id, req.params.videoId, false);
  res.json({ ok: true });
}));

router.get('/admin/orders', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { rows } = await db.query(
    `SELECT o.id, o.type, o.status, o.payment_status, o.opus_project_id, o.estimated_credits, o.error,
            o.created_at, o.updated_at, c.name AS client_name
     FROM orders o LEFT JOIN clients c ON c.id = o.client_id
     ORDER BY o.created_at DESC LIMIT 200`
  );
  const used = await orders.creditsUsed();
  res.json({ orders: rows, credits: { budget: config.opus.creditBudget, used, remaining: config.opus.creditBudget - used } });
}));

router.get('/admin/orders/:id', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const order = await orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'introuvable' });
  const { access_token, ...safe } = order; // eslint-disable-line no-unused-vars
  res.json({ order: safe, events: await orders.listEvents(order.id), deliverables: await orders.listDeliverables(order.id) });
}));

/** Relance une commande en erreur. */
router.post('/admin/orders/:id/retry', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const order = await orders.get(req.params.id);
  if (!order || order.status !== 'error') return res.status(409).json({ error: 'Seules les commandes en erreur peuvent être relancées' });
  const next = order.opus_project_id || order.options?.mode === 'client_file' ? 'opus_done' : 'paid';
  await orders.setStatus(order.id, next, { error: null });
  worker.nudge();
  res.json({ ok: true, status: next });
}));

module.exports = router;
