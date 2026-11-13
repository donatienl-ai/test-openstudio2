'use strict';
/**
 * Stockage objet compatible S3 (Cloudflare R2 ou AWS S3).
 * Interface volontairement réduite pour pouvoir changer de fournisseur.
 */
const fs = require('fs');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('./config');

const s3 = new S3Client({
  region: config.storage.region,
  endpoint: config.storage.endpoint,
  forcePathStyle: Boolean(config.storage.endpoint),
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
});
const Bucket = config.storage.bucket;

/** URL signée pour un envoi direct depuis le navigateur (PUT). */
function presignUpload(key, contentType, ttlSec = 3600) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn: ttlSec });
}

/** URL signée de lecture. disposition = 'attachment' (téléchargement) ou 'inline' (aperçu). */
function presignDownload(key, fileName, disposition = 'attachment', ttlSec = config.storage.urlTtlSec) {
  const safeName = String(fileName || 'video.mp4').replace(/["\\\r\n]/g, '');
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentDisposition: `${disposition}; filename="${safeName}"`,
    }),
    { expiresIn: ttlSec }
  );
}

async function head(key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return { exists: true, size: Number(r.ContentLength || 0), contentType: r.ContentType };
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return { exists: false };
    throw e;
  }
}

async function getStream(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  return r.Body; // Readable (Node)
}

/** Lecture partielle d'un objet (octets start..end inclus). */
async function readRange(key, start, end) {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${start}-${end}` }));
  return Buffer.from(await r.Body.transformToByteArray());
}

async function getText(key) {
  const body = await getStream(key);
  return body.transformToString('utf8');
}

async function downloadToFile(key, filePath) {
  const body = await getStream(key);
  await pipeline(body, fs.createWriteStream(filePath));
}

async function uploadFile(key, filePath, contentType = 'video/mp4') {
  const { size } = fs.statSync(filePath);
  await s3.send(
    new PutObjectCommand({ Bucket, Key: key, Body: fs.createReadStream(filePath), ContentType: contentType, ContentLength: size })
  );
  return size;
}

async function remove(key) {
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

/**
 * Règle CORS du bucket : autorise le site à envoyer (PUT) et lire (GET/HEAD) via les URL signées.
 * Backblaze B2 : la console web ne sait créer que des règles de lecture ; la règle d'envoi passe par l'API.
 * Si le bucket a déjà des règles « natives » B2 (posées depuis la console), Backblaze refuse : il faut
 * d'abord choisir « Ne partager aucun fichier » dans la console.
 */
const storageStatus = { cors: 'non vérifié', corsError: null };

async function ensureCors(origins) {
  if (!origins.length) { storageStatus.cors = 'ignoré (FRONTEND_ORIGIN vide)'; return storageStatus; }
  const wanted = [...origins].sort().join(',');
  try {
    const cur = await s3.send(new GetBucketCorsCommand({ Bucket }));
    const rule = (cur.CORSRules || []).find((r) => (r.AllowedMethods || []).includes('PUT'));
    if (rule && [...(rule.AllowedOrigins || [])].sort().join(',') === wanted) {
      storageStatus.cors = 'ok (déjà en place)'; storageStatus.corsError = null; return storageStatus;
    }
  } catch (e) { /* aucune règle S3 : on la crée */ }
  try {
    await s3.send(new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: { CORSRules: [{
        AllowedOrigins: origins,
        AllowedMethods: ['PUT', 'GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      }] },
    }));
    storageStatus.cors = 'ok (règle créée)'; storageStatus.corsError = null;
  } catch (e) {
    storageStatus.cors = 'échec';
    storageStatus.corsError = `${e.name || 'Erreur'}: ${String(e.message || '').slice(0, 200)}`;
  }
  return storageStatus;
}

module.exports = { storageStatus, ensureCors, readRange, presignUpload, presignDownload, head, getStream, getText, downloadToFile, uploadFile, remove };
