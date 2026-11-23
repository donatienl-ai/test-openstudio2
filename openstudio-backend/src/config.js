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
  // Environnement : « recette » (tests sur Render, garde-fous actifs) ou « production »
  appEnv: (process.env.APP_ENV || 'production').trim().toLowerCase() === 'recette' ? 'recette' : 'production',
  frontendOrigins: (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Adresse de l'espace client, utilisée dans les liens d'accès envoyés aux clients
  clientSiteUrl: (process.env.CLIENT_SITE_URL || (process.env.FRONTEND_ORIGIN || '').split(',')[0] || '').trim().replace(/\/$/, ''),

  // E-mails (Mailjet) : mêmes réglages que l'ancien serveur server/
  mail: {
    apiKey: (process.env.MAILJET_API_KEY || '').trim(),
    secretKey: (process.env.MAILJET_SECRET_KEY || '').trim(),
    fromEmail: (process.env.MAILJET_FROM_EMAIL || 'communication@openmedias.fr').trim(),
    fromName: (process.env.MAILJET_FROM_NAME || 'OpenMedias').trim(),
    sandbox: process.env.MAILJET_SANDBOX === '1',
    // Tests : tous les e-mails partent vers cette adresse. Obligatoire tant que MAIL_ALLOW_REAL_RECIPIENTS n'est pas à 1.
    redirectTo: (process.env.MAIL_REDIRECT_TO || '').trim(),
    allowRealRecipients: process.env.MAIL_ALLOW_REAL_RECIPIENTS === '1',
    apiUrl: (process.env.MAILJET_API_URL || 'https://api.mailjet.com/v3.1/send').trim(),
    // Modèle Mailjet du lien d'accès client (variables : nom, entreprise, lien, date_diffusion). Vide : texte simple.
    templateClientAccess: num(process.env.MJ_TPL_CLIENT_ACCESS, 0),
    templateCreditsRecharge: num(process.env.MJ_TPL_CREDITS_RECHARGE, 0),
    // Envoi automatique du lien d'accès le jour de la diffusion, entre ces heures (heure de Paris)
    accessSendFromHour: num(process.env.CLIENT_ACCESS_SEND_HOUR, 8),
    accessSendUntilHour: 20,
    // Alertes « diffusion incomplète » (vidéo ou e-mail manquant) : J-2 (vendredi si week-end) et jour J
    teamAlertEmail: (process.env.TEAM_ALERT_EMAIL || '').trim(),
    // Équipe compta : e-mail à chaque montage payé (à défaut : TEAM_ALERT_EMAIL)
    accountingEmail: (process.env.ACCOUNTING_EMAIL || process.env.TEAM_ALERT_EMAIL || '').trim(),
    // Images des e-mails (dossier email/ du site client) : adresse publique, sans barre finale
    get assetsUrl() {
      return (process.env.EMAIL_ASSETS_URL || ((process.env.APP_ENV || '').trim().toLowerCase() === 'recette' ? 'https://openstudio-recette.onrender.com/email' : 'https://test-openstudio3.onrender.com/email')).trim().replace(/\/+$/, '');
    },
  },

  // Planning de diffusion (dashboard) : route d'export en lecture seule + clé partagée
  // (= OPENSTUDIO_EXPORT_KEY côté dashboard). Vides : pas de lecture du planning.
  planning: {
    exportUrl: (process.env.PLANNING_EXPORT_URL || '').trim(),
    exportKey: (process.env.PLANNING_EXPORT_KEY || '').trim(),
    syncMinutes: num(process.env.PLANNING_SYNC_MIN, 60),
  },

  // Google Drive : un dossier par client et par diffusion, vidéos déposées par les monteurs importées
  // automatiquement (src/driveSync.js). Vides : désactivé.
  drive: {
    credentialsJson: (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim(),
    rootFolderId: (process.env.DRIVE_ROOT_FOLDER_ID || '').trim(),
    intervalMin: num(process.env.DRIVE_SYNC_MIN, 5),
    settleMin: num(process.env.DRIVE_SETTLE_MIN, 2), // délai sans modification avant d'importer un fichier
  },

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
    // Double authentification (code à 6 chiffres) : désactivée par défaut, ADMIN_REQUIRE_2FA=true pour l'exiger
    require2fa: String(process.env.ADMIN_REQUIRE_2FA || '').trim().toLowerCase() === 'true',
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

  // Factures : Pennylane dès qu'un jeton est configuré (ou PENNYLANE_MOCK=1 pour simuler) ; sinon facture Stripe.
  invoicing: {
    pennylaneKey: (process.env.PENNYLANE_API_KEY || '').trim(),
    pennylaneMock: process.env.PENNYLANE_MOCK === '1',
    get provider() {
      return this.pennylaneKey || this.pennylaneMock ? 'pennylane' : 'stripe';
    },
  },
  // Adresse du back-office, pour les liens dans les e-mails à l'équipe (facultatif)
  adminUrl: (process.env.ADMIN_URL || '').trim().replace(/\/+$/, ''),

  anthropic: {
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: (process.env.CAPTIONS_MODEL || 'claude-opus-5-5').trim(),
    regenerateMax: 5,
  },
};

// Recette : aucun effet réel possible (paiements, e-mails, factures, vidéos OpusClip)
if (config.appEnv === 'recette') {
  const warn = (m) => console.warn(`[recette] ${m}`);
  if (/^sk_live_/.test(config.stripe.secretKey)) { warn('clé Stripe LIVE refusée : paiement simulé'); config.stripe.secretKey = ''; }
  if (config.mail.allowRealRecipients) { warn('MAIL_ALLOW_REAL_RECIPIENTS ignoré : e-mails envoyés à MAIL_REDIRECT_TO seulement'); config.mail.allowRealRecipients = false; }
  if (config.invoicing.pennylaneKey && process.env.PENNYLANE_RECETTE_ALLOWED !== '1') { warn('factures Pennylane simulées (PENNYLANE_RECETTE_ALLOWED=1 pour un compte Pennylane de test)'); config.invoicing.pennylaneKey = ''; config.invoicing.pennylaneMock = true; }
  if (!config.invoicing.pennylaneKey) config.invoicing.pennylaneMock = true;
}

module.exports = config;
