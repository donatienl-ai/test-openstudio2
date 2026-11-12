'use strict';
/**
 * Vérification des webhooks OpusClip (https://help.opus.pro/api-reference/webhook.md)
 *  - X-Opus-Signature : HMAC-SHA256(secretKey, rawBody + salt), en hexadécimal
 *  - X-Opus-Salt      : 8 octets aléatoires en hex, nouveaux à chaque envoi
 *  - X-Opus-Timestamp : heure d'envoi (Unix, secondes)
 */
const crypto = require('crypto');

const MAX_SKEW_SEC = 5 * 60;

/**
 * @param {Buffer|string} rawBody  corps BRUT (avant JSON.parse)
 * @param {object} headers         en-têtes (noms en minuscules)
 * @param {string} secret
 * @param {(salt: string) => Promise<boolean>} [isSaltSeen]  renvoie true si le salt a déjà été vu
 * @param {number} [nowSec]
 * @returns {Promise<{ok: boolean, reason?: string, salt?: string}>}
 */
async function verifyOpusWebhook(rawBody, headers, secret, isSaltSeen, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, reason: 'secret absent' };
  const signature = String(headers['x-opus-signature'] || '');
  const salt = String(headers['x-opus-salt'] || '');
  const ts = Number(headers['x-opus-timestamp']);

  if (!signature || !salt || !Number.isFinite(ts)) return { ok: false, reason: 'en-têtes manquants' };
  if (!/^[0-9a-f]+$/i.test(salt)) return { ok: false, reason: 'salt invalide' };
  if (Math.abs(nowSec - ts) > MAX_SKEW_SEC) return { ok: false, reason: 'horodatage hors délai' };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([body, Buffer.from(salt, 'utf8')]))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature invalide' };

  if (isSaltSeen && (await isSaltSeen(salt))) return { ok: false, reason: 'salt déjà utilisé (rejeu)' };
  return { ok: true, salt };
}

/** Utilitaire de test : produit des en-têtes signés valides. */
function signForTest(rawBody, secret, salt = crypto.randomBytes(8).toString('hex'), ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(rawBody), Buffer.from(salt, 'utf8')]))
    .digest('hex');
  return { 'x-opus-signature': sig, 'x-opus-salt': salt, 'x-opus-timestamp': String(ts) };
}

module.exports = { verifyOpusWebhook, signForTest, MAX_SKEW_SEC };
