'use strict';
/**
 * Accès minimal à l'API Google Drive v3 avec un compte de service (sans dépendance : JWT signé avec crypto).
 * Le compte de service est membre du Drive partagé « OpenStudio – Vidéos clients » : il ne voit que ce Drive.
 *
 * Variables : GOOGLE_SERVICE_ACCOUNT_JSON (contenu du fichier de clé JSON) et DRIVE_ROOT_FOLDER_ID
 * (identifiant du Drive partagé, ou d'un dossier dedans).
 */
const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const SCOPE = 'https://www.googleapis.com/auth/drive';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function parseCredentials(json) {
  let c;
  try {
    c = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON illisible (JSON invalide)');
  }
  if (!c || !c.client_email || !c.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON incomplet (client_email / private_key)');
  return { email: c.client_email, key: c.private_key.replace(/\\n/g, '\n'), tokenUri: c.token_uri || 'https://oauth2.googleapis.com/token' };
}

/** Assertion JWT signée (RS256) pour obtenir un jeton d'accès. */
function signedAssertion(cred, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: cred.email, scope: SCOPE, aud: cred.tokenUri, iat: nowSec, exp: nowSec + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(cred.key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

/** Échappe une valeur dans une requête Drive (q=…). */
const q = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function createDrive({ credentialsJson, fetchImpl = fetch }) {
  const cred = parseCredentials(credentialsJson);
  let token = null;
  let tokenExp = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const res = await fetchImpl(cred.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(cred) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Google : connexion refusée (${data.error_description || data.error || res.status})`);
    token = data.access_token;
    tokenExp = Date.now() + (data.expires_in || 3600) * 1000;
    return token;
  }

  async function call(method, path, { query = {}, body, raw = false } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries({ supportsAllDrives: 'true', ...query })) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) {
      if (!res.ok) throw new Error(`Drive : HTTP ${res.status}`);
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Drive : ${(data.error && data.error.message) || `HTTP ${res.status}`}`);
    return data;
  }

  return {
    /** Dossier enfant ; appProperties = étiquettes invisibles qui relient le dossier à OpenStudio. */
    createFolder(name, parentId, appProperties = {}) {
      return call('POST', '/files', { query: { fields: 'id,name,parents' }, body: { name, mimeType: FOLDER, parents: [parentId], appProperties } });
    },
    /** Dossier déjà créé par OpenStudio (retrouvé par son étiquette), ou null. */
    async findFolderByProperty(key, value) {
      const r = await call('GET', '/files', {
        query: {
          q: `mimeType = '${FOLDER}' and trashed = false and appProperties has { key='${q(key)}' and value='${q(value)}' }`,
          includeItemsFromAllDrives: 'true',
          fields: 'files(id,name,parents)',
          pageSize: '10',
        },
      });
      return (r.files || [])[0] || null;
    },
    /** Renomme et/ou déplace un dossier. */
    updateFolder(id, { name, addParent, removeParent } = {}) {
      return call('PATCH', `/files/${encodeURIComponent(id)}`, {
        query: { addParents: addParent, removeParents: removeParent, fields: 'id,name,parents' },
        body: name ? { name } : {},
      });
    },
    getFile(id) {
      return call('GET', `/files/${encodeURIComponent(id)}`, { query: { fields: 'id,name,parents,trashed' } });
    },
    /** Fichiers (hors dossiers) d'un dossier. */
    async listFiles(folderId) {
      const r = await call('GET', '/files', {
        query: {
          q: `'${q(folderId)}' in parents and trashed = false and mimeType != '${FOLDER}'`,
          includeItemsFromAllDrives: 'true',
          fields: 'files(id,name,mimeType,size,modifiedTime)',
          orderBy: 'modifiedTime desc',
          pageSize: '50',
        },
      });
      return r.files || [];
    },
    /** Télécharge un fichier dans un fichier local (flux : aucun chargement complet en mémoire). */
    async downloadToFile(fileId, filePath) {
      const res = await call('GET', `/files/${encodeURIComponent(fileId)}`, { query: { alt: 'media' }, raw: true });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(filePath));
    },
  };
}

module.exports = { createDrive, parseCredentials, signedAssertion, FOLDER };
