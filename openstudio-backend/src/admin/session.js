'use strict';
/**
 * Identification de l'équipe sur chaque requête.
 *
 * Le back-office envoie « Authorization: Bearer oss_… » (jeton de session, gardé dans l'onglet du
 * navigateur). Pas de cookie : le back-office et l'API sont sur deux domaines différents, et un en-tête
 * explicite protège aussi contre les requêtes forgées depuis un autre site.
 *
 * Transition : tant que ADMIN_TOKEN est renseigné dans Render, l'ancien jeton technique reste accepté
 * (droits admin, pas super admin). À retirer avant la mise en production (lot 5).
 */
const config = require('../config');
const accounts = require('./accounts');
const { tokensMatch } = require('../auth');

function bearer(req) {
  return (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

/** Middleware global : renseigne req.adminUser (session complète) ou req.adminPending (code à saisir). */
async function attach(req, res, next) {
  try {
    const token = bearer(req);
    if (token.startsWith('oss_')) {
      const s = await accounts.sessionFromToken(token);
      if (s && s.stage === 'full') req.adminUser = s.user;
      else if (s && s.stage === 'pending_2fa') req.adminPending = s.user;
      req.adminToken = token;
    } else if (token && config.admin.legacyToken && tokensMatch(config.admin.legacyToken, token)) {
      req.adminViaLegacyToken = true;
    }
    next();
  } catch (e) {
    next(e);
  }
}

function isTeam(req) {
  return Boolean(req.adminUser) || Boolean(req.adminViaLegacyToken);
}

function isSuperAdmin(req) {
  return Boolean(req.adminUser && req.adminUser.role === 'super_admin');
}

/** Garde de route : équipe connectée (n'importe quel rôle). */
function requireTeam(req, res, next) {
  if (isTeam(req)) return next();
  return res.status(401).json({ error: 'Connexion requise', code: 'auth_required' });
}

/** Garde de route : super admin uniquement. */
function requireSuperAdmin(req, res, next) {
  if (isSuperAdmin(req)) return next();
  if (isTeam(req)) return res.status(403).json({ error: 'Réservé au super admin' });
  return res.status(401).json({ error: 'Connexion requise', code: 'auth_required' });
}

module.exports = { attach, isTeam, isSuperAdmin, requireTeam, requireSuperAdmin, bearer };
