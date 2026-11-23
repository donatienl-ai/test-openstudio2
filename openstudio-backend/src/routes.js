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
const audit = require('./admin/audit');
const { AttemptLimiter } = require('./admin/limiter');
const credits = require('./credits/service');

// Connexion par code : 10 essais par quart d'heure et par adresse IP
const codeLimiter = new AttemptLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
// « Code oublié ? » : 5 demandes par quart d'heure et par adresse IP, 3 par heure et par e-mail
const forgotIpLimiter = new AttemptLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const forgotMailLimiter = new AttemptLimiter({ max: 3, windowMs: 60 * 60 * 1000 });

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
    creditsCost: order.credits_cost == null ? null : Number(order.credits_cost),
    creditsCharged: Number(order.credits_charged || 0),
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
    durationSec: v.duration_sec == null ? null : Number(v.duration_sec),
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
    client: {
      id: client.id, name: client.name, company: client.company, email: client.email, sector: client.sector || null,
      hasLogo: Boolean(client.logo_key), packageLabel: client.package_label || null,
      firstSeenAt: client.first_seen_at || null, broadcastDate: client.broadcast_date || null,
      // null : pas encore répondu → l'espace client pose la question (fenêtre à la première connexion)
      marketing: client.marketing_optin === undefined ? null : client.marketing_optin,
      // Code d'accès (lecture seule) : affiché dans « Mon accès » pour le retrouver au besoin
      accessCode: require('./admin/client-access').readableCode(client),
      billing: client.billing || null,
    },
    videos: videos.map(publicVideo),
    clientUploads: config.clientUploadsEnabled,
  });
}));

/**
 * Connexion de l'espace client avec le code d'accès (OM-XXXX-XX).
 * Renvoie l'identifiant du client et un jeton de session à garder dans le navigateur.
 */
router.post('/client/login', json, wrap(async (req, res) => {
  if (!codeLimiter.hit(req.ip || 'inconnue')) {
    return res.status(429).json({ error: 'Trop d’essais. Patientez un quart d’heure avant de réessayer.' });
  }
  const code = clients.normalizeCode((req.body || {}).code);
  if (!code) return res.status(400).json({ error: 'Code incomplet : il a la forme OM-XXXX-XX.' });
  const client = await clients.findByCode(code);
  if (!client) return res.status(401).json({ error: 'Ce code ne correspond à aucun espace. Vérifiez la saisie ou contactez votre chargé de projet.' });
  const token = await clients.openSession(client.id, req.get('user-agent'));
  clients.recordVisit(client.id, { force: true });
  await audit.record({ ip: req.ip, auditActorLabel: `Client (${client.name})` }, 'client_connexion', { targetType: 'client', targetId: client.id });
  res.json({ client: { id: client.id }, token });
}));

/**
 * « Code oublié ? » : renvoie le code d'accès par e-mail, à l'adresse enregistrée sur la fiche.
 * Réponse identique que l'adresse soit connue ou non.
 */
router.post('/client/forgot-code', json, wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Indiquez une adresse e-mail valide.' });
  if (!forgotIpLimiter.hit(req.ip || 'inconnue') || !forgotMailLimiter.hit(email)) {
    return res.status(429).json({ error: 'Trop de demandes. Patientez un moment avant de réessayer.' });
  }
  try {
    const r = await require('./admin/client-access').sendForgottenCode(email, { req });
    if (!r.sent && r.reason !== 'inconnu') console.warn(`[code oublié] non envoyé : ${r.reason}`);
  } catch (e) {
    console.error(`[code oublié] échec de l'envoi : ${e.message}`);
  }
  res.json({ ok: true, message: 'Si cette adresse correspond à un espace OpenStudio, votre code vient d’y être envoyé. Pensez à regarder dans les indésirables.' });
}));

/** Déconnexion de l'espace client sur ce navigateur. */
router.post('/client/logout', wrap(async (req, res) => {
  await clients.closeSession(req.get('x-client-token'));
  res.json({ ok: true });
}));

/** Lecture d'une vidéo de son package dans l'espace client (adresse valable 1 heure). */
router.get('/me/videos/:videoId/stream', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const v = await clients.getVideo(client.id, req.params.videoId);
  if (!v) return res.status(404).json({ error: 'Vidéo introuvable' });
  const ext = path.extname(v.source_key) || '.mp4';
  res.json({ url: await storage.presignDownload(v.source_key, `${v.title}${ext}`, 'inline', 3600) });
}));

/** Le client accepte ou refuse d'être contacté pour des campagnes marketing (modifiable ensuite). */
router.post('/me/marketing', json, wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const optin = (req.body || {}).optin;
  if (typeof optin !== 'boolean') return res.status(400).json({ error: 'Réponse attendue : oui ou non.' });
  await clients.update(client.id, { marketingOptin: optin, marketingOptinSource: 'Espace client' });
  await audit.record({ ip: req.ip, auditActorLabel: `Client (${client.name})` }, 'marketing_reponse', {
    targetType: 'client', targetId: client.id, detail: { marketing: optin ? 'oui' : 'non' },
  });
  res.json({ marketing: optin });
}));

/** Informations de facturation (Factures → Modifier) : enregistrées sur la fiche, visibles par l'équipe. */
const BILLING_FIELDS = { company: 120, contact: 120, email: 200, address: 300, postalCode: 12, city: 80, country: 60, vat: 30, siret: 20, po: 60 };
function cleanBilling(body) {
  const b = {};
  for (const [k, max] of Object.entries(BILLING_FIELDS)) b[k] = String((body || {})[k] == null ? '' : body[k]).replace(/\s+/g, ' ').trim().slice(0, max);
  b.email = b.email.toLowerCase();
  if (!b.company) return { error: 'Indiquez la raison sociale à faire figurer sur les factures.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email)) return { error: 'Indiquez l’adresse e-mail qui recevra les factures.' };
  if (!b.address || !b.postalCode || !b.city) return { error: 'Indiquez l’adresse de facturation complète.' };
  if (b.siret && !/^\d{14}$/.test(b.siret.replace(/\s/g, ''))) return { error: 'Le SIRET compte 14 chiffres.' };
  if (b.vat && !/^[A-Z]{2}[A-Z0-9]{2,13}$/i.test(b.vat.replace(/\s/g, ''))) return { error: 'Le numéro de TVA semble incorrect (ex. FR12345678901).' };
  b.siret = b.siret.replace(/\s/g, '');
  b.vat = b.vat.replace(/\s/g, '').toUpperCase();
  if (!b.country) b.country = 'France';
  return { value: b };
}
router.post('/me/billing', json, wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const r = cleanBilling(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  await db.query('UPDATE clients SET billing = $2, billing_updated_at = now() WHERE id = $1', [client.id, JSON.stringify(r.value)]);
  await audit.record({ ip: req.ip, auditActorLabel: `Client (${client.name})` }, 'facturation_modifiee', { targetType: 'client', targetId: client.id, detail: r.value });
  // Factures en attente de cette adresse : créées tout de suite
  require('./invoicing/service').retryPending().catch((e) => console.warn('[facture] reprise :', e.message));
  res.json({ billing: r.value });
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
  await audit.record({ ip: req.ip, auditActorLabel: `Client (${client.name})` }, 'video_ajoutee', {
    targetType: 'client', targetId: client.id,
    detail: { videoId: v.id, title: v.title, programmeId: v.programme_id, programme: (mapping.programmes[v.programme_id] || {}).title },
  });
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
  const context = {};
  try {
    if (order.type === 'capsules' || (order.type === 'subtitles' && order.options?.videoId)) {
      context.video = await clients.getVideo(order.client_id, order.options?.videoId);
    }
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
  // Coût en crédits fixé par le serveur au moment de la validation (jamais par le navigateur)
  if (order.client_id) {
    const cost = credits.costOf(order.type, normalized, { prices: (await credits.settings.get()).prices, durationSec: context.video ? context.video.duration_sec : null });
    if (cost) await db.query('UPDATE orders SET credits_cost = $2 WHERE id = $1', [order.id, cost.credits]);
  }
  res.json({ order: publicOrder(await orders.get(order.id)) });
}));

/**
 * Lancement d'une commande de l'espace client : débit des crédits, puis traitement.
 * Solde insuffisant : 402 avec { code: 'credits_insuffisants', needed, balance }.
 */
async function payOrder(req, res) {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (order.status === 'draft') return res.status(409).json({ error: "La commande doit d'abord être validée" });
  if (order.status === 'validated') {
    if (order.client_id && Number(order.credits_cost) > 0) {
      try {
        await credits.chargeOrder(order, { actor: 'client' });
      } catch (e) {
        if (e instanceof credits.CreditError) return res.status(e.status).json({ error: e.message, code: e.code, needed: e.needed, balance: e.balance });
        throw e;
      }
    }
    await payment.startPayment(order); // idempotent : sans effet si déjà payée
  }
  res.json({ order: publicOrder(await orders.get(order.id)) });
}
router.post('/orders/:id/pay/credits', wrap(payOrder));
/** Ancien nom (paiement simulé) : les commandes de l'espace client y sont aussi débitées en crédits. */
router.post('/orders/:id/pay/simulate', wrap(payOrder));

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

// Création, liste et modification des clients : routes-admin-clients.js (back-office, lot 2)

/** Émissions proposées (back-office). */
router.get('/admin/programmes', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ programmes: Object.entries(mapping.programmes).map(([id, p]) => ({ id, title: p.title })) });
}));

/**
 * Back-office : adresse d'envoi direct d'une vidéo brute vers le stockage (navigateur → bucket).
 * Le fichier est rangé sous clients/<id client>/…, puis rattaché au package par la route suivante.
 */
router.post('/admin/clients/:id/videos/upload', json, wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const client = await clients.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  const { fileName, contentType } = req.body || {};
  const spec = UPLOAD_KINDS.video;
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!spec.exts.includes(ext)) return res.status(400).json({ error: `Format non accepté (${spec.exts.join(', ')}).` });
  const ct = String(contentType || '') || 'video/mp4';
  if (!spec.types.test(ct)) return res.status(400).json({ error: 'Ce fichier n’est pas une vidéo.' });
  const key = `clients/${client.id}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}/video${ext}`;
  const uploadUrl = await storage.presignUpload(key, ct, 6 * 3600);
  res.json({ key, uploadUrl, method: 'PUT', headers: { 'Content-Type': ct } });
}));

/** Ajouter une vidéo au package d'un client (vidéo déjà déposée dans le stockage). */
router.post('/admin/clients/:id/videos', json, wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const client = await clients.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  const { programmeId, sourceKey } = req.body || {};
  const title = String((req.body || {}).title || '').trim().slice(0, 200);
  const broadcastDate = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body || {}).broadcastDate || '')) ? req.body.broadcastDate : null;
  const d = Number((req.body || {}).durationSec);
  const durationSec = Number.isFinite(d) && d > 0 && d < 24 * 3600 ? Math.round(d * 10) / 10 : null;
  if (!mapping.programmes[programmeId]) {
    return res.status(400).json({ error: `Émission inconnue. Disponibles : ${Object.keys(mapping.programmes).join(', ')}` });
  }
  if (!title || !sourceKey) return res.status(400).json({ error: 'Titre et fichier requis.' });
  const h = await storage.head(sourceKey);
  if (!h.exists) return res.status(400).json({ error: 'Fichier introuvable dans le stockage : l’envoi n’est peut-être pas terminé.' });
  if (h.contentType && !/^video\//.test(h.contentType)) return res.status(400).json({ error: 'Ce fichier n’est pas une vidéo.' });
  const v = await clients.addVideo(client.id, { programmeId, title, sourceKey, broadcastDate, durationSec });
  await audit.record(req, 'video_ajoutee', {
    targetType: 'client', targetId: client.id,
    detail: { videoId: v.id, title, programmeId, programme: mapping.programmes[programmeId].title, date: broadcastDate },
  });
  res.status(201).json({ video: publicVideo(v) });
}));

router.get('/admin/clients/:id/videos', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ videos: (await clients.listVideos(req.params.id)).map(publicVideo) });
}));

/** Back-office : lien de visionnage d'une vidéo brute (valable 1 heure). */
router.get('/admin/clients/:id/videos/:videoId/preview', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const v = await clients.getVideo(req.params.id, req.params.videoId);
  if (!v) return res.status(404).json({ error: 'Vidéo introuvable' });
  const ext = path.extname(v.source_key) || '.mp4';
  res.json({ url: await storage.presignDownload(v.source_key, `${v.title}${ext}`, 'inline', 3600) });
}));

/** Retirer une vidéo du package (elle reste en base mais n'est plus proposée). */
router.post('/admin/clients/:id/videos/:videoId/disable', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const removed = await clients.getVideo(req.params.id, req.params.videoId);
  await clients.setVideoActive(req.params.id, req.params.videoId, false);
  await audit.record(req, 'video_retiree', {
    targetType: 'client', targetId: req.params.id,
    detail: { videoId: req.params.videoId, title: removed && removed.title, programme: removed && (mapping.programmes[removed.programme_id] || {}).title },
  });
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
  // Les crédits rendus lors de l'échec sont débités à nouveau
  if (order.client_id && Number(order.credits_cost) > 0 && !Number(order.credits_charged)) {
    try {
      await credits.chargeOrder(order, { actor: 'équipe (relance)' });
    } catch (e) {
      if (e instanceof credits.CreditError) return res.status(409).json({ error: `Relance impossible : ${e.message} Ajoutez des crédits au client (fiche client) puis relancez.` });
      throw e;
    }
  }
  const next = order.opus_project_id || order.options?.mode === 'client_file' ? 'opus_done' : 'paid';
  await orders.setStatus(order.id, next, { error: null });
  await audit.record(req, 'commande_relancee', { targetType: 'order', targetId: order.id, detail: { erreur: order.error } });
  worker.nudge();
  res.json({ ok: true, status: next });
}));

module.exports = router;
