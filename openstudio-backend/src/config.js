'use strict';
require('dotenv').config();

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const config = {
  port: num(process.env.PORT, 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  frontendOrigins: (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),

  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: bool(process.env.DATABASE_SSL, true),

  opus: {
    apiKey: process.env.OPUSCLIP_API_KEY || '',
    webhookSecret: process.env.OPUSCLIP_WEBHOOK_SECRET || process.env.OPUSCLIP_API_KEY || '',
    baseUrl: 'https://api.opus.pro',
    dryRun: bool(process.env.OPUSCLIP_DRY_RUN, true),
    // Tests : clients dont les commandes partent réellement chez OpusClip malgré OPUSCLIP_DRY_RUN=true
    // (voir src/opusclip/mode.js). Lu à chaque usage : modifiable sans redéployer le code.
    get liveClients() {
      return (process.env.OPUSCLIP_LIVE_CLIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
    },
    get liveMaxMinutes() {
      return num(process.env.OPUSCLIP_LIVE_MAX_MINUTES, 10);
    },
    creditBudget: num(process.env.OPUSCLIP_CREDIT_BUDGET, 0),
    creditsPerMinute: num(process.env.OPUSCLIP_CREDITS_PER_MINUTE, 1),
    pollIntervalSec: num(process.env.OPUSCLIP_POLL_INTERVAL_SEC, 120),
    timeoutMin: num(process.env.OPUSCLIP_TIMEOUT_MIN, 240),
    rateLimitPerMinute: 30,
  },

  storage: {
    bucket: (process.env.STORAGE_BUCKET || '').trim() || '',
    endpoint: (process.env.STORAGE_ENDPOINT || '').trim() || undefined,
    region: (process.env.STORAGE_REGION || '').trim() || 'auto',
    accessKeyId: (process.env.STORAGE_ACCESS_KEY || '').trim() || '',
    secretAccessKey: (process.env.STORAGE_SECRET_KEY || '').trim() || '',
    urlTtlSec: num(process.env.DOWNLOAD_URL_TTL_SEC, 900),
    retentionDays: num(process.env.FILE_RETENTION_DAYS, 30),
  },

  // Tests uniquement : le client peut déposer lui-même une vidéo dans son espace (en production : l'équipe).
  clientUploadsEnabled: bool(process.env.CLIENT_UPLOADS_ENABLED, false),
  // Tests uniquement : nom d'un client de test créé (s'il n'existe pas) au démarrage ; son lien d'accès est écrit dans les logs.
  testClientName: (process.env.TEST_CLIENT_NAME || '').trim(),

  workerIntervalSec: num(process.env.WORKER_INTERVAL_SEC, 10),
};

module.exports = config;
