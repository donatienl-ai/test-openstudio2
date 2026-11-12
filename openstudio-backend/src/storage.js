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

module.exports = { presignUpload, presignDownload, head, getStream, getText, downloadToFile, uploadFile, remove };
