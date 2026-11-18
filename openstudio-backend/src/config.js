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

  // Back-office de l'équipe (application séparée du site client)
  admin: {
    // Adresse du back-office, sans barre finale (ex. https://admin.openstudio.fr) : CORS et liens d'activation
    origin: (process.env.ADMIN_ORIGIN || '').trim().replace(/\/$/, ''),
    // Clé de chiffrement des secrets de double authentification (32 caractères minimum, ne jamais la changer)
    encryptionKey: (process.env.ADMIN_ENCRYPTION_KEY || '').trim(),
    // Premier démarrage : compte super admin créé automatiquement, lien d'activation écrit dans les logs
    bootstrapEmail: (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim(),
    bootstrapName: (process.env.ADMIN_BOOTSTRAP_NAME || '').trim(),
    sessionHours: num(process.env.ADMIN_SESSION_HOURS, 12),
    inviteHours: num(process.env.ADMIN_INVITE_HOURS, 72),
    // Transition : ancien jeton technique, accepté tant qu'il est renseigné (à retirer avant la production)
    legacyToken: (process.env.ADMIN_TOKEN || '').trim(),
  },

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

  // Publication sur les réseaux sociaux (Upload-Post). La clé ne quitte jamais le serveur.
  social: {
    apiKey: (process.env.UPLOAD_POST_API_KEY || '').trim(),
    webhookSecret: (process.env.UPLOAD_POST_WEBHOOK_SECRET || '').trim(),
    baseUrl: 'https://api.upload-post.com/api',
    platforms: ['youtube', 'instagram', 'tiktok', 'linkedin', 'facebook'],
    scheduleMaxDays: num(process.env.SOCIAL_SCHEDULE_MAX_DAYS, 7), // = durée max d'une URL signée du stockage
    videoUrlTtlSec: 7 * 24 * 3600,
    statsMaxAgeHours: 24, // statistiques actualisées à l'ouverture de « Performances » au-delà
    manualRefreshMinutes: 15, // bouton « Actualiser » : une fois par quart d'heure et par client
    statusPollSec: 120, // secours si la notification upload_completed n'arrive pas
  },

  // Légendes générées par Claude (clé côté serveur uniquement)
  // Paiement par carte (Stripe Checkout). Sans clé : paiement simulé (tests).
  stripe: {
    secretKey: (process.env.STRIPE_SECRET_KEY || '').trim(),
    webhookSecret: (process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
    vatRate: num(process.env.VAT_RATE, 0.2), // TVA appliquée aux prix HT
    get mock() {
      return !this.secretKey;
    },
  },

  anthropic: {
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: (process.env.CAPTIONS_MODEL || 'claude-opus-5-5').trim(),
    regenerateMax: 5,
  },
};

module.exports = config;
