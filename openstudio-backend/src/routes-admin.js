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
const config = require('./config');

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
  if (!config.admin.require2fa) {
    // Double authentification désactivée : le mot de passe ouvre directement la session
    const logged = await accounts.markLogin(user.id);
    const full = await accounts.createSession(user.id, 'full', req);
    req.adminUser = logged;
    await audit.record(req, 'connexion', { targetType: 'admin_user', targetId: user.id, detail: { email: user.email } });
    return res.json({ token: full.token, expiresInSec: full.expiresInSec, user: accounts.publicUser(logged) });
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
  res.json({ email: user.email, username: user.username, name: user.name, role: user.role, twoFactor: config.admin.require2fa });
}));

/** Étape 1 : choix du mot de passe → clé à saisir dans l'application d'authentification. */
router.post('/admin/auth/invite/start', throttle, json, wrap(async (req, res) => {
  const { token, password } = req.body || {};
  const user = await accounts.findByInvite(String(token || ''));
  if (!user) return res.status(404).json({ error: 'Lien d’activation invalide ou expiré. Demandez-en un nouveau.' });
  if (!config.admin.require2fa) {
    // Double authentification désactivée : le compte est activé dès le mot de passe choisi
    let activated;
    try {
      activated = await accounts.activateWithPasswordOnly(user, password);
    } catch (e) {
      return sendError(res, e);
    }
    const s = await accounts.createSession(activated.id, 'full', req);
    req.adminUser = activated;
    await audit.record(req, 'compte_active', { targetType: 'admin_user', targetId: activated.id, detail: { email: activated.email } });
    return res.json({ token: s.token, expiresInSec: s.expiresInSec, user: accounts.publicUser(activated) });
  }
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
  if (!String(username || '').trim()) return res.status(400).json({ error: 'Identifiant requis (par défaut : la partie avant @ de l’e-mail).' });
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

/** Changement de rôle d'un compte (admin ↔ super admin). */
router.post('/admin/team/:id/role', requireSuperAdmin, json, wrap(async (req, res) => {
  const role = String((req.body || {}).role || '');
  if (req.params.id === req.adminUser.id && role !== 'super_admin') return res.status(409).json({ error: 'Vous ne pouvez pas retirer votre propre rôle de super admin : demandez à un autre super admin.' });
  const before = await accounts.get(req.params.id);
  let u;
  try {
    u = await accounts.setRole(req.params.id, role);
  } catch (e) {
    return sendError(res, e);
  }
  if (before && before.role !== u.role) {
    await audit.record(req, 'role_modifie', { targetType: 'admin_user', targetId: u.id, detail: { email: u.email, avant: before.role, apres: u.role } });
  }
  res.json({ user: accounts.publicUser(u) });
}));

/* ------------------------------------------------------------------ E-mails automatiques (activation) */

router.get('/admin/email-settings', requireTeam, wrap(async (req, res) => {
  res.json(await require('./emails/settings').list());
}));

router.put('/admin/email-settings', requireTeam, json, wrap(async (req, res) => {
  const emails = require('./emails/settings');
  const before = await emails.list();
  const r = await emails.save((req.body || {}).disabled, (req.adminUser && req.adminUser.name) || 'équipe');
  if (r.error) return res.status(400).json({ error: r.error });
  const changes = {};
  for (const e of r.value.emails) {
    const was = (before.emails.find((x) => x.id === e.id) || {}).enabled;
    if (was !== e.enabled) changes[e.label] = e.enabled ? 'activé' : 'en pause';
  }
  if (Object.keys(changes).length) await audit.record(req, 'emails_actives', { detail: changes });
  res.json(r.value);
}));

/** Mode test : adresses qui reçoivent tous les e-mails à la place des vrais destinataires. */
router.get('/admin/email-redirect', requireTeam, wrap(async (req, res) => {
  res.json(require('./emails/redirect').get());
}));

router.put('/admin/email-redirect', requireTeam, json, wrap(async (req, res) => {
  const redirect = require('./emails/redirect');
  const before = redirect.get().list;
  const r = await redirect.save((req.body || {}).list, (req.adminUser && req.adminUser.name) || 'équipe');
  if (r.error) return res.status(400).json({ error: r.error });
  await audit.record(req, 'emails_test_adresses', { detail: { avant: before.join(', ') || '(aucune)', apres: r.value.list.join(', ') || '(aucune : envoi réel)' } });
  res.json(r.value);
}));

/** E-mail de test : l'e-mail automatique choisi, avec des données d'exemple, envoyé à la personne connectée. */
router.post('/admin/email-settings/:id/test', requireTeam, wrap(async (req, res) => {
  if (!req.adminUser || !req.adminUser.email) return res.status(409).json({ error: 'Connectez-vous avec votre compte nominatif pour recevoir le test à votre adresse.' });
  try {
    const r = await require('./emails/samples').sendTest(req.params.id, { email: req.adminUser.email, name: req.adminUser.name });
    await audit.record(req, 'email_test_envoye', { detail: { email: req.adminUser.email, objet: r.subject, ...(r.to !== req.adminUser.email ? { redirige_vers: r.to } : {}) } });
    res.json(r);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.status ? e.message : `Le test n’est pas parti : ${e.message}` });
  }
}));

/* ------------------------------------------------------------------ Destinataires des alertes */

router.get('/admin/alert-settings', requireTeam, wrap(async (req, res) => {
  res.json(await require('./admin/alerts').list());
}));

router.put('/admin/alert-settings', requireTeam, json, wrap(async (req, res) => {
  const alerts = require('./admin/alerts');
  const before = await alerts.list();
  const r = await alerts.save(req.body || {}, (req.adminUser && req.adminUser.name) || 'équipe');
  if (r.error) return res.status(400).json({ error: r.error });
  const changes = {};
  for (const t of r.value.types) {
    const old = (before.types.find((x) => x.id === t.id) || {}).recipients || [];
    if (old.join(',') !== t.recipients.join(',')) changes[t.label] = t.recipients.join(', ') || '(aucun)';
  }
  if (Object.keys(changes).length) await audit.record(req, 'alertes_modifiees', { detail: changes });
  res.json(r.value);
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
