'use strict';
/**
 * Client HTTP de l'API Upload-Post (https://docs.upload-post.com).
 * Appels serveur à serveur uniquement : la clé UPLOAD_POST_API_KEY n'est jamais envoyée au navigateur.
 */
const config = require('../config');

class UploadPostError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.name = 'UploadPostError';
    this.status = status;
    this.code = code || null;
    this.body = body;
  }
}

async function request(method, path, { query, body, form } = {}) {
  if (!config.social.apiKey) throw new UploadPostError('UPLOAD_POST_API_KEY manquante', 0, 'NOT_CONFIGURED');
  const url = new URL(config.social.baseUrl + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, v);
  const headers = { Authorization: `Apikey ${config.social.apiKey}` };
  let payload;
  if (form) payload = form; // FormData : le Content-Type multipart est posé par fetch
  else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new UploadPostError(`Upload-Post injoignable : ${e.message}`, 0, 'NETWORK');
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 300) };
  }
  if (!res.ok || data.success === false) {
    const code = data.error_code || data.code || null;
    throw new UploadPostError(data.message || data.error || `Upload-Post : erreur ${res.status}`, res.status, code, data);
  }
  return data;
}

// --- Profils ---------------------------------------------------------------
/** Crée le profil ; 409 (déjà existant) est considéré comme un succès. */
async function createProfile(username) {
  try {
    return await request('POST', '/uploadposts/users', { body: { username } });
  } catch (e) {
    if (e.status === 409) return { success: true, existed: true };
    throw e;
  }
}
async function getProfile(username) {
  const data = await request('GET', `/uploadposts/users/${encodeURIComponent(username)}`);
  return data.profile || null;
}

// --- Connexion des comptes (Connect API, authentifiée par la clé API côté serveur) ---
async function startOAuth(platform, profile, redirectUrl) {
  return request('POST', `/uploadposts/oauth/${encodeURIComponent(platform)}/start`, {
    body: { profile, redirect_url: redirectUrl },
  });
}

// --- Pages Facebook ----------------------------------------------------------
async function getFacebookPages(profile) {
  return request('GET', '/uploadposts/users/facebook-page', { query: { profile_username: profile } });
}
async function pinFacebookPage(profile, pageId) {
  return request('POST', '/uploadposts/users/facebook-page', { body: { profile_username: profile, facebook_page_id: pageId } });
}

// --- Publication -------------------------------------------------------------
/**
 * POST /api/upload (multipart). fields : objet { nom: valeur | tableau } (platform[] etc.).
 * La vidéo est passée par URL (champ `video`).
 */
async function uploadVideo(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => form.append(k, String(x)));
    else form.append(k, String(v));
  }
  return request('POST', '/upload', { form });
}
async function getStatus({ requestId, jobId }) {
  return request('GET', '/uploadposts/status', { query: { request_id: requestId, job_id: jobId } });
}
async function getPostAnalytics(requestId, platform) {
  return request('GET', `/uploadposts/post-analytics/${encodeURIComponent(requestId)}`, { query: { platform } });
}

module.exports = {
  UploadPostError,
  request,
  createProfile,
  getProfile,
  startOAuth,
  getFacebookPages,
  pinFacebookPage,
  uploadVideo,
  getStatus,
  getPostAnalytics,
};
