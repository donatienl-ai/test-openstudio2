'use strict';
/**
 * Contrôle d'accès en mode test : chaque commande possède un jeton aléatoire non devinable,
 * remis au client à la création. Toute lecture / téléchargement exige ce jeton.
 * TODO : remplacer par l'authentification des comptes clients quand elle existera
 *        (vérifier alors order.client.userId === utilisateur connecté).
 */
const crypto = require('crypto');

function newAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokensMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string' || !expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Lit le jeton depuis l'en-tête X-Order-Token ou le paramètre ?token= */
function tokenFromRequest(req) {
  return req.get('x-order-token') || req.query.token || '';
}

function isAdmin(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(adminToken) && tokensMatch(adminToken, provided);
}

module.exports = { newAccessToken, tokensMatch, tokenFromRequest, isAdmin };
