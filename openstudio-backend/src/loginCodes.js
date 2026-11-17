'use strict';
/**
 * Codes de connexion des espaces clients (format OM-XXXX-XX, celui de l'écran de connexion).
 *
 * - Générés au hasard (crypto.randomInt) : 31^6 ≈ 887 millions de combinaisons, sans caractères ambigus
 *   (pas de 0/O, 1/I/L). Rien ne dépend du nom de l'entreprise ni de la date de diffusion : impossible à deviner.
 * - En base : une empreinte HMAC-SHA256 (recherche à la connexion) et une copie chiffrée AES-256-GCM, gardée
 *   jusqu'à l'envoi du mail du jour J pour pouvoir y insérer le code (puis effacée par la tâche d'envoi).
 * - Les essais ratés sont limités par adresse IP (createRateLimiter).
 *
 * Module sans dépendance (ni base, ni express) : testé dans test/loginCodes.test.js.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIX = 'OM';

function randomChars(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

/**
 * Nouveau code, ex. « OM-7KX4-M9 ». Le bloc central n'est jamais uniquement composé de chiffres : ce format
 * (OM-JJMM-XX) est celui des codes de démonstration de index.html, vérifiés avant le serveur.
 */
function generate() {
  let mid;
  do mid = randomChars(4);
  while (/^\d{4}$/.test(mid));
  return `${PREFIX}-${mid}-${randomChars(2)}`;
}

/**
 * Remet une saisie au format canonique (majuscules, tirets), comme normCode() dans index.html.
 * Renvoie null si ce n'est pas un code complet.
 */
function normalize(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^OM[A-Z0-9]{6}$/.test(s)) return null;
  return `${s.slice(0, 2)}-${s.slice(2, 6)}-${s.slice(6, 8)}`;
}

function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('LOGIN_CODE_SECRET manquant ou trop court (16 caractères minimum)');
  }
}

/** Empreinte stockée en base ; la même saisie donne toujours la même empreinte. */
function hash(code, secret) {
  requireSecret(secret);
  return crypto.createHmac('sha256', secret).update(`login-code:${code}`).digest('hex');
}

const encKey = (secret) => crypto.createHash('sha256').update(`login-code-enc:${secret}`).digest();

/** Copie chiffrée du code (iv.tag.texte, en base64url). */
function encrypt(code, secret) {
  requireSecret(secret);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(secret), iv);
  const data = Buffer.concat([c.update(code, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

/** Code en clair, ou null si la copie est absente ou illisible (secret changé, données altérées). */
function decrypt(blob, secret) {
  if (!blob) return null;
  requireSecret(secret);
  try {
    const [iv, tag, data] = String(blob).split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Limite les essais ratés : au-delà de `max` échecs dans la fenêtre, la clé (l'adresse IP) est bloquée
 * jusqu'à la fin de la fenêtre. Mémoire locale : suffisant pour une seule instance Render.
 */
function createRateLimiter({ max = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const fails = new Map(); // clé → horodatages des échecs
  const recent = (key) => {
    const t = now();
    const list = (fails.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) fails.set(key, list);
    else fails.delete(key);
    return list;
  };
  return {
    /** { blocked, retryAfterSec } */
    check(key) {
      const list = recent(key);
      if (list.length < max) return { blocked: false, retryAfterSec: 0 };
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) };
    },
    fail(key) {
      const list = recent(key);
      list.push(now());
      fails.set(key, list);
    },
    reset(key) {
      fails.delete(key);
    },
  };
}

module.exports = { ALPHABET, generate, normalize, hash, encrypt, decrypt, createRateLimiter };
