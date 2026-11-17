'use strict';
/**
 * Routes « réseaux sociaux » (Upload-Post) et « Performances ».
 * Toutes les routes client exigent la session (X-Client-Id + X-Client-Token) ; la propriété des
 * vidéos et des publications est vérifiée dans src/social/service.js.
 */
const express = require('express');
const config = require('./config');
const clients = require('./clients');
const social = require('./social/service');

const router = express.Router();
const json = express.json({ limit: '200kb' });

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    if (e instanceof social.SocialError) return res.status(e.status).json({ error: e.message, code: e.code || undefined });
    return next(e);
  });

async function requireClient(req, res) {
  const client = await clients.fromRequest(req);
  if (!client) res.status(401).json({ error: 'Espace client non reconnu' });
  return client;
}

// --- Comptes connectés ---------------------------------------------------------
router.get('/social/accounts', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  if (!config.social.apiKey) return res.json({ enabled: false, platforms: {}, facebookPage: null });
  res.json(await social.accounts(client));
}));

/** Démarre la connexion : crée le profil Upload-Post si besoin et renvoie l'URL officielle du réseau. */
router.post('/social/connect/:platform', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  res.json(await social.startConnect(client, req.params.platform));
}));

/**
 * Retour de la fenêtre de connexion (redirect_url donné à Upload-Post).
 * Transmet connect_status / platform / error_code à la page OpenStudio qui a ouvert la fenêtre, puis la ferme.
 * Aucune donnée sensible : seulement le résultat de la tentative.
 */
router.get('/social/connected', (req, res) => {
  const pick = (v, re) => (typeof v === 'string' && re.test(v) ? v : '');
  const msg = {
    type: 'openstudio-social-connect',
    connect_status: pick(req.query.connect_status, /^(success|cancelled|error)$/),
    platform: pick(req.query.platform, /^[a-z-]{2,20}$/),
    error_code: pick(req.query.error_code, /^[A-Z_]{2,40}$/),
  };
  const origins = config.frontendOrigins;
  const back = `${origins[0] || ''}/?social_connect=${encodeURIComponent(msg.connect_status)}&platform=${encodeURIComponent(msg.platform)}&error_code=${encodeURIComponent(msg.error_code)}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenStudio</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1A1A2E;background:#F4F3EF}p{font-size:15px}</style></head>
<body><p>Retour à OpenStudio…</p><script>
(function () {
  var msg = ${JSON.stringify(msg)};
  var origins = ${JSON.stringify(origins)};
  if (window.opener && !window.opener.closed) {
    origins.forEach(function (o) { try { window.opener.postMessage(msg, o); } catch (e) {} });
    setTimeout(function () { window.close(); }, 150);
  } else {
    location.replace(${JSON.stringify(back)});
  }
})();
</script></body></html>`);
});

router.get('/social/facebook/pages', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  res.json(await social.facebookPages(client));
}));

router.post('/social/facebook/page', json, wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  res.json({ page: await social.selectFacebookPage(client, String((req.body || {}).pageId || '')) });
}));

// --- Légendes par réseau --------------------------------------------------------
router.get('/social/videos/:id/captions', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  res.json(await social.captions(client, req.params.id));
}));

router.post('/social/videos/:id/captions/regenerate', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  res.json(await social.captions(client, req.params.id, { regenerate: true }));
}));

// --- Publications ---------------------------------------------------------------
router.post('/social/publications', json, wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const b = req.body || {};
  const pub = await social.publish(client, {
    deliverableId: b.videoId,
    platforms: Array.isArray(b.platforms) ? b.platforms : [],
    texts: b.texts || {},
    scheduledAt: b.scheduledAt || null, // « AAAA-MM-JJTHH:MM », heure de Paris
  });
  res.status(201).json({ publication: pub });
}));

router.get('/social/publications', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const videoId = typeof req.query.video === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.video) ? req.query.video : null;
  res.json({ publications: await social.listPublications(client, { videoId }) });
}));

router.get('/social/publications/:id', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Publication introuvable' });
  res.json({ publication: await social.getPublication(client, req.params.id) });
}));

// --- Performances ---------------------------------------------------------------
router.get('/social/performance', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  const q = req.query;
  res.json(await social.performance(client, { period: q.period, platform: q.platform, kind: q.kind, programme: q.programme }));
}));

router.post('/social/performance/refresh', wrap(async (req, res) => {
  const client = await requireClient(req, res);
  if (!client) return;
  res.json(await social.manualRefresh(client));
}));

// --- Notifications Upload-Post (corps brut : signature HMAC) ---------------------
router.post('/webhooks/upload-post', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const r = await social.handleWebhook(req.body || Buffer.alloc(0), req.headers);
  if (r.status === 401) console.warn(`[webhook upload-post] rejeté : ${r.reason}`);
  res.status(r.status).json({ ok: r.status === 200 });
}));

module.exports = router;
