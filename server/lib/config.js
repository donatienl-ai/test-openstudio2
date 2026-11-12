// Configuration lue dans les variables d'environnement (Render > Environment).
// Aucune valeur secrète n'est écrite dans le code ni dans les journaux.
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

export const CONFIG = {
  port: num('PORT', 10000),
  // Origine(s) du site autorisée(s) par CORS, séparées par des virgules.
  siteOrigins: env('SITE_ORIGIN').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
  // Adresse publique de ce serveur (pour l'URL du webhook déclarée à OpusClip).
  publicUrl: env('PUBLIC_URL').replace(/\/$/, ''),

  opus: {
    apiKey: env('OPUSCLIP_API_KEY'),
    orgId: env('OPUSCLIP_ORG_ID'),
    base: env('OPUSCLIP_API_BASE', 'https://api.opus.pro/api'),
    templates: {
      impact: env('OPUS_TPL_IMPACT'),
      classique: env('OPUS_TPL_CLASSIQUE'),
      minimal: env('OPUS_TPL_MINIMAL')
    },
    // "buckets" : tranches fixes documentées ([0,30], [30,60]…). "free" : intervalle libre autour de la durée,
    // à n'activer qu'après un appel de test concluant.
    durationMode: env('OPUS_DURATION_MODE', 'buckets') === 'free' ? 'free' : 'buckets',
    // Durée de validité de l'URL signée transmise à OpusClip (7 jours maximum pour une signature S3/R2).
    videoUrlTtl: Math.min(num('OPUS_VIDEO_URL_TTL', 604800), 604800),
    // Si OpusClip refuse l'URL signée, le serveur envoie lui-même le fichier chez OpusClip (upload-links).
    uploadFallback: env('OPUS_UPLOAD_FALLBACK', '1') !== '0',
    statusPollMs: num('OPUS_STATUS_POLL_MS', 60000)
  },

  storage: {
    endpoint: env('STORAGE_ENDPOINT'),            // R2 : https://<compte>.r2.cloudflarestorage.com ; vide pour AWS S3
    region: env('STORAGE_REGION', 'auto'),
    bucket: env('STORAGE_BUCKET'),
    accessKeyId: env('STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: env('STORAGE_SECRET_ACCESS_KEY'),
    maxVideoMb: num('MAX_VIDEO_MB', 10240),
    maxImageMb: num('MAX_IMAGE_MB', 15),
    maxJingleMb: num('MAX_JINGLE_MB', 500)
  },

  render: {
    timeoutMs: num('RENDER_TIMEOUT_MS', 15 * 60 * 1000),
    downloadTtl: num('DOWNLOAD_URL_TTL', 24 * 3600),
    loudnessI: -14, truePeak: -1, lra: 11
  },

  // Facultatif. Vide par défaut : pendant la phase de tests internes, les dépôts ne demandent pas de mot de passe.
  adminSecret: env('ADMIN_SECRET')
};

export const storageReady = () => !!(CONFIG.storage.bucket && CONFIG.storage.accessKeyId && CONFIG.storage.secretAccessKey);
export const opusReady = () => !!CONFIG.opus.apiKey;
