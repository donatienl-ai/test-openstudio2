// Stockage S3 ou Cloudflare R2 (même API). Les fichiers ne transitent pas par le navigateur du client.
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { CONFIG, storageReady } from './config.js';
import { AppError, MSG } from './errors.js';

let client = null;
function s3() {
  if (!storageReady()) throw new AppError('storage', MSG.storage, 503);
  if (!client) {
    const st = CONFIG.storage;
    client = new S3Client({
      region: st.region || 'auto',
      ...(st.endpoint ? { endpoint: st.endpoint } : {}),
      forcePathStyle: !!st.endpoint,
      credentials: { accessKeyId: st.accessKeyId, secretAccessKey: st.secretAccessKey }
    });
  }
  return client;
}
const Bucket = () => CONFIG.storage.bucket;

export async function presignPut(Key, ContentType, expiresIn = 3600) {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: Bucket(), Key, ContentType }), { expiresIn });
}

export async function presignGet(Key, expiresIn = 3600, downloadName) {
  const cmd = new GetObjectCommand({
    Bucket: Bucket(), Key,
    ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/[^\w.\-]+/g, '_')}"` } : {})
  });
  return getSignedUrl(s3(), cmd, { expiresIn });
}

export async function exists(Key) {
  try { await s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key })); return true; }
  catch (e) { if (e && (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound')) return false; throw e; }
}

export async function head(Key) {
  return s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key }));
}

export async function put(Key, Body, ContentType) {
  return s3().send(new PutObjectCommand({ Bucket: Bucket(), Key, Body, ContentType }));
}

export async function getStream(Key) {
  const r = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key }));
  return { stream: r.Body, length: r.ContentLength, type: r.ContentType };
}

export async function getBuffer(Key) {
  const { stream } = await getStream(Key);
  const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks);
}

export async function download(Key, path) {
  const { stream } = await getStream(Key); await pipeline(stream, createWriteStream(path)); return path;
}

export async function putJson(Key, obj) { return put(Key, JSON.stringify(obj), 'application/json'); }
export async function getJson(Key) {
  try { return JSON.parse((await getBuffer(Key)).toString('utf8')); }
  catch (e) { if (e && (e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey')) return null; throw e; }
}
