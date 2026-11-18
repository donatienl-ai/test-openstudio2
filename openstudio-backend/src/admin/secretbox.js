'use strict';
/**
 * Chiffrement des secrets de double authentification en base (AES-256-GCM).
 * La clé est dérivée de ADMIN_ENCRYPTION_KEY : sans elle, une copie de la base ne suffit pas
 * pour générer les codes de l'équipe.
 */
const crypto = require('crypto');

function keyFrom(secret) {
  if (!secret || String(secret).length < 32) {
    throw new Error('ADMIN_ENCRYPTION_KEY manquante ou trop courte (32 caractères minimum)');
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function seal(plain, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function open(sealed, secret) {
  const [v, iv, tag, enc] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Secret chiffré illisible');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { seal, open };
