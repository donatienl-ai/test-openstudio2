'use strict';
/** Tables du back-office : comptes de l'équipe, sessions, journal d'audit. */
module.exports = `
CREATE TABLE IF NOT EXISTS admin_users (
  id                   UUID PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE,          -- toujours en minuscules
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('super_admin', 'admin')),
  password_hash        TEXT,
  totp_secret          TEXT,                           -- chiffré (ADMIN_ENCRYPTION_KEY)
  totp_pending_secret  TEXT,                           -- pendant l'activation du compte
  totp_last_counter    BIGINT,                         -- un code déjà utilisé est refusé
  active               BOOLEAN NOT NULL DEFAULT true,
  activated_at         TIMESTAMPTZ,
  invite_hash          TEXT UNIQUE,                    -- lien d'activation (haché)
  invite_expires_at    TIMESTAMPTZ,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash   TEXT PRIMARY KEY,                       -- jeton haché : la base ne contient aucun jeton utilisable
  user_id      UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL CHECK (stage IN ('pending_2fa', 'full')),
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_user ON admin_sessions (user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     UUID,
  actor_label  TEXT NOT NULL,                          -- nom du compte, « jeton technique » ou « système »
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  detail       JSONB,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target ON audit_log (target_type, target_id);
`;
