'use strict';
/**
 * Client HTTP de l'API OpusClip.
 * Doc : https://help.opus.pro/llms.txt
 *  - POST /api/upload-links            → { url, uploadId }
 *  - POST <url> (x-goog-resumable)     → header location
 *  - PUT  <location>                   → envoi du fichier
 *  - POST /api/clip-projects           → création du projet (videoUrl = URL publique OU uploadId)
 *  - GET  /api/clip-projects/{id}      → détails du projet
 *  - GET  /api/exportable-clips        → clips d'un projet
 *  - GET  /api/transcripts            → transcription (mots horodatés) de la vidéo source
 *  - GET  /api/brand-templates?q=mine  → templates de l'organisation
 */
const config = require('../config');

// --- Limiteur de débit : 30 requêtes / minute / clé (fenêtre glissante) ---
const callTimes = [];
async function rateLimit() {
  const limit = config.opus.rateLimitPerMinute;
  for (;;) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] >= 60_000) callTimes.shift();
    if (callTimes.length < limit) {
      callTimes.push(now);
      return;
    }
    await sleep(60_000 - (now - callTimes[0]) + 50);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class OpusError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Appel à l'API OpusClip avec limitation + retries exponentiels sur 429 / 5xx / erreurs réseau. */
async function opusRequest(method, path, { body, query, retries = 4 } = {}) {
  if (!config.opus.apiKey) throw new OpusError('OPUSCLIP_API_KEY manquante', 0);
  const url = new URL(path, config.opus.baseUrl);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));

  let attempt = 0;
  for (;;) {
    await rateLimit();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.opus.apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      if (attempt >= retries) throw new OpusError(`Réseau : ${netErr.message}`, 0);
      await sleep(backoff(attempt++));
      continue;
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (res.ok) return { data, headers: res.headers, status: res.status };

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt++));
      continue;
    }
    throw new OpusError(`OpusClip ${method} ${url.pathname} → ${res.status}`, res.status, data);
  }
}

function backoff(attempt) {
  return Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

// ---------------------------------------------------------------------------

async function createUploadLink() {
  const { data } = await opusRequest('POST', '/api/upload-links', {
    body: { video: { usecase: 'LocalUpload' } },
  });
  if (!data?.url || !data?.uploadId) throw new OpusError('Réponse upload-links inattendue', 0, data);
  return { url: data.url, uploadId: data.uploadId };
}

/**
 * Envoie un fichier vers OpusClip (GCS, upload résumable) à partir d'un flux lisible.
 * @param {ReadableStream|import('stream').Readable} stream
 * @param {number} sizeBytes
 * @returns {Promise<string>} uploadId à utiliser comme videoUrl
 */
async function uploadVideo(stream, sizeBytes) {
  const { url, uploadId } = await createUploadLink();

  // Étape 2 : ouverture de la session résumable (requête vers GCS, pas vers l'API Opus)
  const startRes = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-resumable': 'start', 'Content-Length': '0' },
  });
  const location = startRes.headers.get('location');
  if (!startRes.ok || !location) {
    throw new OpusError(`Ouverture de session d'upload impossible (${startRes.status})`, startRes.status);
  }

  // Étape 3 : envoi du fichier
  const putRes = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(sizeBytes ? { 'Content-Length': String(sizeBytes) } : {}),
    },
    body: stream,
    duplex: 'half',
  });
  if (!putRes.ok) {
    throw new OpusError(`Upload de la vidéo échoué (${putRes.status})`, putRes.status, await putRes.text());
  }
  return uploadId;
}

async function createProject(payload) {
  const { data } = await opusRequest('POST', '/api/clip-projects', { body: payload });
  const projectId = data?.id || data?.projectId || data?.data?.id;
  if (!projectId) throw new OpusError('Réponse de création de projet sans identifiant', 0, data);
  return { projectId, raw: data };
}

async function getProject(projectId) {
  const { data } = await opusRequest('GET', `/api/clip-projects/${encodeURIComponent(projectId)}`);
  return data;
}

/** Récupère TOUS les clips exportables d'un projet (pagination). */
async function getExportableClips(projectId) {
  const all = [];
  const pageSize = 50;
  for (let pageNum = 1; pageNum <= 100; pageNum++) {
    const { data } = await opusRequest('GET', '/api/exportable-clips', {
      query: { q: 'findByProjectId', projectId, pageNum, pageSize },
    });
    const items = Array.isArray(data) ? data : data?.data || data?.list || data?.items || [];
    all.push(...items);
    if (items.length < pageSize) break;
  }
  return all;
}

/**
 * Transcription de la vidéo source d'un projet.
 * Renvoie un tableau de paragraphes { start, end, text, speaker?, words: [{ word, start, end, isFillerWord }] }
 * (temps en secondes), ou null si la transcription n'est pas encore disponible.
 */
async function getTranscript(projectId) {
  const { data } = await opusRequest('GET', '/api/transcripts', { query: { q: 'findByProjectId', projectId } });
  const list = Array.isArray(data) ? data : data?.data;
  const transcript = Array.isArray(list) ? list[0] : null;
  return Array.isArray(transcript) && transcript.length ? transcript : null;
}

async function listBrandTemplates() {
  const { data } = await opusRequest('GET', '/api/brand-templates', { query: { q: 'mine' } });
  return Array.isArray(data) ? data : data?.data || data?.list || [];
}

module.exports = {
  OpusError,
  opusRequest,
  createUploadLink,
  uploadVideo,
  createProject,
  getProject,
  getExportableClips,
  getTranscript,
  listBrandTemplates,
};
