'use strict';
/**
 * Comptes de l'équipe OpenMedias : création sur invitation, activation (mot de passe + double
 * authentification), connexion en deux temps, sessions.
 *
 * Rôles : super_admin (tout, plus la gestion des comptes de l'équipe et du barème) et admin.
 */
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { hashPassword, verifyPassword, passwordProblem } = require('./password');
const totp = require('./totp');
const secretbox = require('./secretbox');

const ROLES = ['super_admin', 'admin'];
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const PENDING_2FA_MINUTES = 5;

class AdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v));

function newToken(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Ce que l'on renvoie au navigateur (jamais de hash ni de secret). */
function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    activated: Boolean(u.activated_at),
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

function inviteLink(token) {
  const base = config.admin.origin || 'https://ADRESSE-DU-BACK-OFFICE';
  return `${base}/?invite=${encodeURIComponent(token)}`;
}

async function get(id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query('SELECT * FROM admin_users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function list() {
  const { rows } = await db.query('SELECT * FROM admin_users ORDER BY role DESC, created_at');
  return rows;
}

async function countSuperAdmins() {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'super_admin' AND active = true"
  );
  return rows[0].n;
}

/** Crée un compte en attente d'activation. Renvoie le compte et le jeton du lien d'invitation. */
async function createUser({ email, name, role = 'admin', createdBy = null }) {
  const mail = normalizeEmail(email);
  if (!isEmail(mail)) throw new AdminError('Adresse e-mail invalide.');
  if (!String(name || '').trim()) throw new AdminError('Nom du compte requis.');
  if (!ROLES.includes(role)) throw new AdminError('Rôle inconnu.');
  const existing = await db.query('SELECT id FROM admin_users WHERE email = $1', [mail]);
  if (existing.rows.length) throw new AdminError('Un compte existe déjà avec cette adresse.', 409);
  const token = newToken('osi_');
  const { rows } = await db.query(
    `INSERT INTO admin_users (id, email, name, role, invite_hash, invite_expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $7) RETURNING *`,
    [crypto.randomUUID(), mail, String(name).trim(), role, hashToken(token), config.admin.inviteHours, createdBy]
  );
  return { user: rows[0], inviteToken: token };
}

/**
 * Nouveau lien d'activation : le mot de passe et la double authentification sont réinitialisés
 * (téléphone perdu, mot de passe oublié) et toutes les sessions du compte sont fermées.
 */
async function resetAccess(userId) {
  const token = newToken('osi_');
  const { rows } = await db.query(
    `UPDATE admin_users SET password_hash = NULL, totp_secret = NULL, totp_pending_secret = NULL,
       totp_last_counter = NULL, activated_at = NULL, failed_logins = 0, locked_until = NULL,
       invite_hash = $2, invite_expires_at = now() + make_interval(hours => $3)
     WHERE id = $1 RETURNING *`,
    [userId, hashToken(token), config.admin.inviteHours]
  );
  if (!rows[0]) throw new AdminError('Compte introuvable.', 404);
  await deleteUserSessions(userId);
  return { user: rows[0], inviteToken: token };
}

async function setActive(userId, active) {
  const { rows } = await db.query('UPDATE admin_users SET active = $2 WHERE id = $1 RETURNING *', [userId, active]);
  if (!rows[0]) throw new AdminError('Compte introuvable.', 404);
  if (!active) await deleteUserSessions(userId);
  return rows[0];
}

/* ------------------------------------------------------------------ Activation */

async function findByInvite(token) {
  if (!token || !String(token).startsWith('osi_')) return null;
  const { rows } = await db.query(
    'SELECT * FROM admin_users WHERE invite_hash = $1 AND invite_expires_at > now() AND active = true',
    [hashToken(token)]
  );
  return rows[0] || null;
}

/** Étape 1 : mot de passe choisi, secret de double authentification généré (pas encore actif). */
async function startActivation(user, password) {
  const problem = passwordProblem(password);
  if (problem) throw new AdminError(problem);
  const secret = totp.newSecret();
  await db.query(
    'UPDATE admin_users SET password_hash = $2, totp_pending_secret = $3 WHERE id = $1',
    [user.id, await hashPassword(password), secretbox.seal(secret, config.admin.encryptionKey)]
  );
  return { secret, uri: totp.otpauthUri(secret, user.email) };
}

/** Étape 2 : le premier code saisi prouve que l'application d'authentification est bien configurée. */
async function finishActivation(user, code) {
  const fresh = await get(user.id);
  if (!fresh || !fresh.totp_pending_secret || !fresh.password_hash) {
    throw new AdminError("Recommencez l'activation depuis le début.");
  }
  const secret = secretbox.open(fresh.totp_pending_secret, config.admin.encryptionKey);
  const counter = totp.verifyCode(secret, code);
  if (counter === null) throw new AdminError('Code incorrect. Vérifiez l’heure de votre téléphone et réessayez.', 401);
  const { rows } = await db.query(
    `UPDATE admin_users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
       totp_last_counter = $2, activated_at = now(), invite_hash = NULL, invite_expires_at = NULL,
       failed_logins = 0, locked_until = NULL, last_login_at = now()
     WHERE id = $1 RETURNING *`,
    [user.id, counter]
  );
  return rows[0];
}

/* ------------------------------------------------------------------ Connexion */

/**
 * Étape 1 de la connexion : e-mail + mot de passe.
 * Message volontairement identique pour un e-mail inconnu et un mauvais mot de passe.
 */
async function checkPassword(email, password) {
  const mail = normalizeEmail(email);
  const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [mail]);
  const user = rows[0];
  if (!user || !user.active || !user.activated_at || !user.password_hash) {
    // Même durée de calcul qu'un vrai essai, pour ne pas révéler si le compte existe.
    await verifyPassword(String(password || ''), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    throw new AdminError('E-mail ou mot de passe incorrect.', 401);
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new AdminError(`Compte bloqué après ${MAX_FAILED_LOGINS} essais. Réessayez dans ${LOCK_MINUTES} minutes.`, 423);
  }
  if (!(await verifyPassword(String(password || ''), user.password_hash))) {
    await registerFailure(user.id);
    throw new AdminError('E-mail ou mot de passe incorrect.', 401);
  }
  return user;
}

async function registerFailure(userId) {
  await db.query(
    `UPDATE admin_users SET failed_logins = failed_logins + 1,
       locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1`,
    [userId, MAX_FAILED_LOGINS, LOCK_MINUTES]
  );
}

/** Étape 2 de la connexion : le code à 6 chiffres. */
async function checkSecondFactor(userId, code) {
  const user = await get(userId);
  if (!user || !user.active || !user.totp_secret) throw new AdminError('Session expirée, reconnectez-vous.', 401);
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new AdminError(`Compte bloqué après ${MAX_FAILED_LOGINS} essais. Réessayez dans ${LOCK_MINUTES} minutes.`, 423);
  }
  const secret = secretbox.open(user.totp_secret, config.admin.encryptionKey);
  const last = user.totp_last_counter === null ? null : Number(user.totp_last_counter);
  const counter = totp.verifyCode(secret, code, { lastCounter: last });
  if (counter === null) {
    await registerFailure(user.id);
    throw new AdminError('Code incorrect.', 401);
  }
  const { rows } = await db.query(
    `UPDATE admin_users SET totp_last_counter = $2, failed_logins = 0, locked_until = NULL, last_login_at = now()
     WHERE id = $1 RETURNING *`,
    [user.id, counter]
  );
  return rows[0];
}

/* ------------------------------------------------------------------ Sessions */

async function createSession(userId, stage, req) {
  const token = newToken('oss_');
  const minutes = stage === 'full' ? config.admin.sessionHours * 60 : PENDING_2FA_MINUTES;
  await db.query(
    `INSERT INTO admin_sessions (token_hash, user_id, stage, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [hashToken(token), userId, stage, (req && req.ip) || null,
      String((req && req.get && req.get('user-agent')) || '').slice(0, 300), minutes]
  );
  return { token, expiresInSec: minutes * 60 };
}

/** Session valide (non expirée, compte actif) correspondant au jeton, ou null. */
async function sessionFromToken(token) {
  if (!token || !String(token).startsWith('oss_')) return null;
  const { rows } = await db.query(
    `SELECT s.stage, s.expires_at, u.*
     FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashToken(token)]
  );
  if (!rows[0]) return null;
  const { stage, expires_at: expiresAt, ...user } = rows[0];
  return { stage, expiresAt, user };
}

async function deleteSession(token) {
  await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function deleteUserSessions(userId) {
  await db.query('DELETE FROM admin_sessions WHERE user_id = $1', [userId]);
}

async function purgeExpiredSessions() {
  await db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
}

/* ------------------------------------------------------------------ Premier démarrage */

/**
 * Crée le compte super admin indiqué dans ADMIN_BOOTSTRAP_EMAIL s'il n'existe aucun super admin,
 * ou renouvelle son lien d'activation s'il n'a jamais été activé et que le lien a expiré.
 * Renvoie le lien d'activation à afficher dans les logs, ou null.
 */
async function ensureBootstrap({ email, name }) {
  const mail = normalizeEmail(email);
  if (!mail) return null;
  const { rows } = await db.query('SELECT * FROM admin_users WHERE email = $1', [mail]);
  const existing = rows[0];
  if (!existing) {
    if ((await countSuperAdmins()) > 0) return null;
    const { inviteToken } = await createUser({ email: mail, name: name || mail, role: 'super_admin' });
    return inviteLink(inviteToken);
  }
  if (!existing.activated_at && (!existing.invite_expires_at || new Date(existing.invite_expires_at) < new Date())) {
    const { inviteToken } = await resetAccess(existing.id);
    return inviteLink(inviteToken);
  }
  return null;
}

module.exports = {
  AdminError,
  ROLES,
  publicUser,
  inviteLink,
  get,
  list,
  countSuperAdmins,
  createUser,
  resetAccess,
  setActive,
  findByInvite,
  startActivation,
  finishActivation,
  checkPassword,
  checkSecondFactor,
  createSession,
  sessionFromToken,
  deleteSession,
  deleteUserSessions,
  purgeExpiredSessions,
  ensureBootstrap,
  hashToken,
  normalizeEmail,
};
