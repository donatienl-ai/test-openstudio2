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

-- Paiements en échec (carte refusée…) : dernière raison donnée par Stripe
ALTER TABLE montage_requests ADD COLUMN IF NOT EXISTS last_payment_error TEXT;
ALTER TABLE montage_requests ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMPTZ;
ALTER TABLE montage_requests ADD COLUMN IF NOT EXISTS payment_failures INTEGER NOT NULL DEFAULT 0;

-- Venues des clients dans leur espace (un enregistrement par client et par jour, heure de Paris)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS client_visits (
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  first_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  hits       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_id, day)
);
CREATE INDEX IF NOT EXISTS client_visits_day ON client_visits (day);

-- Code d'accès du client (format OM-XXXX-XX), conservé uniquement sous forme d'empreinte
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS clients_access_code ON clients (access_code_hash) WHERE access_code_hash IS NOT NULL;
-- Le même code, chiffré (ADMIN_ENCRYPTION_KEY), pour l'afficher sur la fiche du back-office
ALTER TABLE clients ADD COLUMN IF NOT EXISTS access_code_enc TEXT;
-- Sessions ouvertes avec le code : le client reste connecté sur son navigateur
CREATE TABLE IF NOT EXISTS client_sessions (
  token_hash    TEXT PRIMARY KEY,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS client_sessions_client ON client_sessions (client_id);

-- Crédits clients : le solde (clients.credit_balance) ne bouge qu'avec une ligne du registre, dans la même requête
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credit_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS credits_expire_at TIMESTAMPTZ;   -- vide : diffusion + 30 jours
CREATE TABLE IF NOT EXISTS client_credit_ledger (
  id             BIGSERIAL PRIMARY KEY,
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,   -- inclus | recharge | debit | remboursement | expiration | ajustement
  credits        INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  label          TEXT,
  order_id       UUID,
  purchase_id    UUID,
  actor          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_credit_ledger_client ON client_credit_ledger (client_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS client_credit_ledger_inclus ON client_credit_ledger (client_id) WHERE kind = 'inclus';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credits_cost INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credits_charged INTEGER NOT NULL DEFAULT 0;
-- Recharges de crédits payées par carte (Stripe Checkout)
CREATE TABLE IF NOT EXISTS credit_purchases (
  id                    UUID PRIMARY KEY,
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  pack_id               TEXT NOT NULL,
  pack_label            TEXT NOT NULL,
  credits               INTEGER NOT NULL,
  amount_ht_cents       INTEGER NOT NULL,
  amount_ttc_cents      INTEGER NOT NULL,
  status                TEXT NOT NULL,   -- awaiting_payment | paid | cancelled
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT,
  last_payment_error    TEXT,
  payment_failed_at     TIMESTAMPTZ,
  payment_failures      INTEGER NOT NULL DEFAULT 0,
  return_base           TEXT,
  paid_at               TIMESTAMPTZ,
  credited_at           TIMESTAMPTZ,
  email_sent_at         TIMESTAMPTZ,
  email_error           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_purchases_client ON credit_purchases (client_id, created_at DESC);
-- Logos des vidéos du client : entreprise et média, avec leur position (top-left, top-right, bottom-left, bottom-right)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS media_logo_key TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS logo_position TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS media_logo_position TEXT;
-- Suivi des paiements par carte : chronologie, origine des refus, abandons
CREATE TABLE IF NOT EXISTS payment_events (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,   -- montage | recharge
  payment_id  UUID NOT NULL,
  event       TEXT NOT NULL,   -- page_ouverte | refus | erreur_technique | paye | abandonne
  origin      TEXT,            -- client | banque | openmedias
  message     TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_events_payment ON payment_events (payment_id, created_at);
ALTER TABLE montage_requests ADD COLUMN IF NOT EXISTS failure_origin TEXT;
ALTER TABLE montage_requests ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS failure_origin TEXT;
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;
-- Réglages modifiables depuis le back-office (barème des crédits, packs de recharge)
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
`;
