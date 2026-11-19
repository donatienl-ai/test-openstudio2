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

  // Planning de diffusion (dashboard) : route d'export en lecture seule + clé partagée (OPENSTUDIO_EXPORT_KEY côté dashboard)
  planning: {
    exportUrl: (process.env.PLANNING_EXPORT_URL || '').trim(),
    exportKey: (process.env.PLANNING_EXPORT_KEY || '').trim(),
    syncMinutes: num(process.env.PLANNING_SYNC_MIN, 60),
  },

  // Google Drive : dossiers des diffusions + import des vidéos (src/driveSync.js)
  drive: {
    credentialsJson: (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim(),
    rootFolderId: (process.env.DRIVE_ROOT_FOLDER_ID || '').trim(),
    intervalMin: num(process.env.DRIVE_SYNC_MIN, 5),
    settleMin: num(process.env.DRIVE_SETTLE_MIN, 2), // délai sans modification avant d'importer un fichier
  },

  // E-mails du jour de diffusion (src/broadcastDay.js), via Mailjet. Tant que MAIL_ALLOW_REAL_RECIPIENTS n'est pas à 1,
  // tout part vers MAIL_REDIRECT_TO.
  mail: {
    apiKey: (process.env.MAILJET_API_KEY || '').trim(),
    secretKey: (process.env.MAILJET_SECRET_KEY || '').trim(),
    fromEmail: (process.env.MAILJET_FROM_EMAIL || '').trim(),
    fromName: process.env.MAILJET_FROM_NAME || 'OpenMedias',
    redirectTo: (process.env.MAIL_REDIRECT_TO || '').trim(),
    allowRealRecipients: process.env.MAIL_ALLOW_REAL_RECIPIENTS === '1',
    teamEmail: (process.env.TEAM_ALERT_EMAIL || '').trim(),
    sendHour: num(process.env.MAIL_SEND_HOUR, 8),
    siteUrl: (process.env.CLIENT_SITE_URL || (process.env.FRONTEND_ORIGIN || '').split(',')[0] || '').trim(),
    templates: {
      first: (process.env.MJ_TPL_DIFFUSION_FIRST || '').trim() || null,
      next: (process.env.MJ_TPL_DIFFUSION_NEXT || '').trim() || null,
      alert: (process.env.MJ_TPL_TEAM_ALERT || '').trim() || null,
    },
  },

  // Codes de connexion des espaces clients (src/loginCodes.js). Secret propre aux codes : le changer rend
  // tous les codes existants invalides. Essais ratés limités par adresse IP.
  loginCodes: {
    secret: (process.env.LOGIN_CODE_SECRET || '').trim(),
    maxFails: num(process.env.LOGIN_MAX_FAILS, 10),
    windowMin: num(process.env.LOGIN_FAIL_WINDOW_MIN, 15),
  },

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
