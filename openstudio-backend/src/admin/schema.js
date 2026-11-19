'use strict';
/** Tables du back-office : comptes de l'équipe, sessions, journal d'audit. */
module.exports = `
CREATE TABLE IF NOT EXISTS admin_users (
  id                   UUID PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE,          -- toujours en minuscules
  username             TEXT,                           -- identifiant de connexion (ex. thomas.d), index unique plus bas
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

-- Bases créées avant l'identifiant de connexion
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username ON admin_users (username);

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

-- Lot 2 : fiche client et lien d'accès envoyé le jour de la diffusion
ALTER TABLE clients ADD COLUMN IF NOT EXISTS broadcast_date DATE;            -- date de diffusion de l'émission
ALTER TABLE clients ADD COLUMN IF NOT EXISTS package_label TEXT;             -- ex. « BFM Business + immersion »
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes TEXT;                     -- notes internes, jamais montrées au client
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_token_hash TEXT;         -- lien d'accès haché (le lien lui-même n'est pas conservé)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_issued_at TIMESTAMPTZ;   -- dernier lien créé
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_issued_via TEXT;         -- 'email' ou 'manuel'
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_revoked_at TIMESTAMPTZ;  -- accès coupé par l'équipe
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_email_sent_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_email_error TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_email_last_try_at TIMESTAMPTZ;
ALTER TABLE clients ALTER COLUMN access_token DROP NOT NULL;
-- Clients créés avant le lot 2 : leur lien actuel continue de fonctionner, désormais vérifié par son empreinte
UPDATE clients SET access_token_hash = encode(sha256(convert_to(access_token, 'UTF8')), 'hex')
  WHERE access_token_hash IS NULL AND access_token IS NOT NULL AND access_revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS clients_access_due ON clients (broadcast_date)
  WHERE access_email_sent_at IS NULL AND access_revoked_at IS NULL;

-- Consentement aux campagnes marketing (NULL : non renseigné)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_optin BOOLEAN;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_optin_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_optin_source TEXT;

-- E-mails envoyés à chaque client (suivi sur la fiche)
CREATE TABLE IF NOT EXISTS client_emails (
  id             BIGSERIAL PRIMARY KEY,
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,                 -- acces (lien d'accès) ; d'autres types viendront
  to_email       TEXT NOT NULL,
  redirected_to  TEXT,                          -- mode test : adresse qui l'a réellement reçu
  subject        TEXT,
  status         TEXT NOT NULL,                 -- envoye | echec
  provider_id    TEXT,                          -- identifiant Mailjet
  error          TEXT,
  automatic      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_emails_client ON client_emails (client_id, created_at DESC);
`;
