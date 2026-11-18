'use strict';
/**
 * Double authentification par code à 6 chiffres (TOTP, RFC 6238), compatible avec
 * Google Authenticator, Microsoft Authenticator, 1Password, etc. Aucune dépendance.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SEC = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Clé de double authentification invalide');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuf, counter, digits = DIGITS, algo = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, secretBuf).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function codeAt(secretB32, timeMs = Date.now()) {
  return hotp(base32Decode(secretB32), Math.floor(timeMs / 1000 / STEP_SEC));
}

/**
 * Vérifie un code en tolérant un décalage d'horloge de ±30 s.
 * Renvoie le compteur utilisé (pour refuser qu'un même code serve deux fois), ou null.
 */
function verifyCode(secretB32, code, { timeMs = Date.now(), lastCounter = null, window = 1 } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretB32);
  const now = Math.floor(timeMs / 1000 / STEP_SEC);
  for (let w = -window; w <= window; w++) {
    const counter = now + w;
    if (lastCounter !== null && counter <= lastCounter) continue;
    const expected = Buffer.from(hotp(secret, counter));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) return counter;
  }
  return null;
}

/** Lien à scanner ou à saisir dans l'application d'authentification. */
function otpauthUri(secretB32, accountEmail, issuer = 'OpenStudio admin') {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SEC}`;
}

module.exports = { newSecret, verifyCode, codeAt, otpauthUri, base32Encode, base32Decode, hotp };
