'use strict';
/**
 * Back-office : connexion de l'équipe, activation des comptes, gestion de l'équipe, journal d'audit.
 * Toutes les routes sont sous /api/admin. Les autres routes admin (clients, commandes…) sont dans
 * routes.js et routes-montage.js et utilisent la même identification (src/admin/session.js).
 */
const express = require('express');
const accounts = require('./admin/accounts');
const audit = require('./admin/audit');
const { AttemptLimiter } = require('./admin/limiter');
const { requireTeam, requireSuperAdmin } = require('./admin/session');

const router = express.Router();
const json = express.json({ limit: '20kb' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 20 tentatives par quart d'heure et par adresse IP, toutes routes sensibles confondues
const limiter = new AttemptLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
function throttle(req, res, next) {
  if (limiter.hit(req.ip || 'inconnue')) return next();
  return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans un quart d’heure.' });
}

function sendError(res, e) {
  if (e instanceof accounts.AdminError) return res.status(e.status).json({ error: e.message });
  throw e;
}

/* ------------------------------------------------------------------ Connexion */

/** Étape 1 : identifiant (ou e-mail) + mot de passe → jeton provisoire, valable 5 minutes, pour saisir le code. */
router.post('/admin/auth/login', throttle, json, wrap(async (req, res) => {
  const { username, email, password } = req.body || {};
  const identifier = username || email;
  let user;
  try {
    user = await accounts.checkPassword(identifier, password);
  } catch (e) {
    if (e instanceof accounts.AdminError) {
      await audit.record({ ip: req.ip, auditActorLabel: 'non connecté' }, 'connexion_refusee', {
        detail: { identifiant: accounts.normalizeUsername(identifier).slice(0, 80), motif: e.message },
      });
    }
    return sendError(res, e);
  }
  const s = await accounts.createSession(user.id, 'pending_2fa', req);
  res.json({ step: 'code', token: s.token, expiresInSec: s.expiresInSec });
}));

/** Étape 2 : code à 6 chiffres → session complète (12 h par défaut). */
router.post('/admin/auth/code', throttle, json, wrap(async (req, res) => {
  if (!req.adminPending) return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
  let user;
  try {
    user = await accounts.checkSecondFactor(req.adminPending.id, (req.body || {}).code);
  } catch (e) {
    if (e instanceof accounts.AdminError) {
      await audit.record({ adminUser: req.adminPending, ip: req.ip }, 'code_refuse', {
        targetType: 'admin_user', targetId: req.adminPending.id, detail: { email: req.adminPending.email },
      });
    }
    return sendError(res, e);
  }
  await accounts.deleteSession(req.adminToken);
  const s = await accounts.createSession(user.id, 'full', req);
  req.adminUser = user;
  await audit.record(req, 'connexion', { targetType: 'admin_user', targetId: user.id, detail: { email: user.email } });
  res.json({ token: s.token, expiresInSec: s.expiresInSec, user: accounts.publicUser(user) });
}));

router.post('/admin/auth/logout', wrap(async (req, res) => {
  if (req.adminToken) await accounts.deleteSession(req.adminToken);
  res.json({ ok: true });
}));

router.get('/admin/auth/me', requireTeam, (req, res) => {
  if (req.adminViaLegacyToken) {
    return res.json({ user: { id: null, name: 'Jeton technique', role: 'admin', legacy: true } });
  }
  res.json({ user: accounts.publicUser(req.adminUser) });
});

/* ------------------------------------------------------------------ Activation d'un compte */

/** Le lien d'invitation est-il valable ? */
router.get('/admin/auth/invite', throttle, wrap(async (req, res) => {
  const user = await accounts.findByInvite(String(req.query.token || ''));
  if (!user) return res.status(404).json({ error: 'Lien d’activation invalide ou expiré. Demandez-en un nouveau.' });
  res.json({ email: user.email, username: user.username, name: user.name, role: user.role });
}));

/** Étape 1 : choix du mot de passe → clé à saisir dans l'application d'authentification. */
router.post('/admin/auth/invite/start', throttle, json, wrap(async (req, res) => {
  const { token, password } = req.body || {};
  const user = await accounts.findByInvite(String(token || ''));
  if (!user) return res.status(404).json({ error: 'Lien d’activation invalide ou expiré. Demandez-en un nouveau.' });
  try {
    const { secret, uri } = await accounts.startActivation(user, password);
    res.json({ secret, uri });
  } catch (e) {
    sendError(res, e);
  }
}));

/** Étape 2 : premier code → compte activé et session ouverte. */
router.post('/admin/auth/invite/finish', throttle, json, wrap(async (req, res) => {
  const { token, code } = req.body || {};
  const user = await accounts.findByInvite(String(token || ''));
  if (!user) return res.status(404).json({ error: 'Lien d’activation invalide ou expiré. Demandez-en un nouveau.' });
  let activated;
  try {
    activated = await accounts.finishActivation(user, code);
  } catch (e) {
    return sendError(res, e);
  }
  const s = await accounts.createSession(activated.id, 'full', req);
  req.adminUser = activated;
  await audit.record(req, 'compte_active', { targetType: 'admin_user', targetId: activated.id, detail: { email: activated.email } });
  res.json({ token: s.token, expiresInSec: s.expiresInSec, user: accounts.publicUser(activated) });
}));

/* ------------------------------------------------------------------ Équipe (super admin) */

router.get('/admin/team', requireSuperAdmin, wrap(async (req, res) => {
  res.json({ users: (await accounts.list()).map(accounts.publicUser) });
}));

router.post('/admin/team', requireSuperAdmin, json, wrap(async (req, res) => {
  const { email, name, role, username } = req.body || {};
  let created;
  try {
    created = await accounts.createUser({ email, name, username, role: role || 'admin', createdBy: req.adminUser.id });
  } catch (e) {
    return sendError(res, e);
  }
  await audit.record(req, 'compte_cree', {
    targetType: 'admin_user', targetId: created.user.id,
    detail: { email: created.user.email, identifiant: created.user.username, role: created.user.role },
  });
  res.status(201).json({ user: accounts.publicUser(created.user), inviteLink: accounts.inviteLink(created.inviteToken) });
}));

/** Nouveau lien d'activation (mot de passe oublié, téléphone perdu) : l'accès actuel est coupé. */
router.post('/admin/team/:id/reset', requireSuperAdmin, wrap(async (req, res) => {
  let r;
  try {
    r = await accounts.resetAccess(req.params.id);
  } catch (e) {
    return sendError(res, e);
  }
  await audit.record(req, 'acces_reinitialise', { targetType: 'admin_user', targetId: r.user.id, detail: { email: r.user.email } });
  res.json({ user: accounts.publicUser(r.user), inviteLink: accounts.inviteLink(r.inviteToken) });
}));

router.post('/admin/team/:id/disable', requireSuperAdmin, wrap(async (req, res) => {
  if (req.params.id === req.adminUser.id) return res.status(409).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
  const target = await accounts.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Compte introuvable.' });
  if (target.role === 'super_admin' && (await accounts.countSuperAdmins()) <= 1) {
    return res.status(409).json({ error: 'Il doit rester au moins un super admin actif.' });
  }
  const u = await accounts.setActive(target.id, false);
  await audit.record(req, 'compte_desactive', { targetType: 'admin_user', targetId: u.id, detail: { email: u.email } });
  res.json({ user: accounts.publicUser(u) });
}));

router.post('/admin/team/:id/enable', requireSuperAdmin, wrap(async (req, res) => {
  let u;
  try {
    u = await accounts.setActive(req.params.id, true);
  } catch (e) {
    return sendError(res, e);
  }
  await audit.record(req, 'compte_reactive', { targetType: 'admin_user', targetId: u.id, detail: { email: u.email } });
  res.json({ user: accounts.publicUser(u) });
}));

/* ------------------------------------------------------------------ Journal d'audit (super admin) */

router.get('/admin/audit', requireSuperAdmin, wrap(async (req, res) => {
  const entries = await audit.list({
    limit: req.query.limit,
    before: /^\d+$/.test(String(req.query.before || '')) ? req.query.before : null,
    targetType: req.query.targetType || null,
    targetId: req.query.targetId || null,
  });
  res.json({ entries });
}));

module.exports = router;
module.exports.limiter = limiter;
