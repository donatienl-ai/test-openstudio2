'use strict';
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  company      TEXT,
  email        TEXT,
  access_token TEXT NOT NULL,
  logo_key     TEXT,                         -- logo de l'entreprise (ajouté en haut des capsules)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vidéos du package du client (ex. passage BFM Business, immersion…), déposées par l'équipe
CREATE TABLE IF NOT EXISTS client_videos (
  id            UUID PRIMARY KEY,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  programme_id  TEXT NOT NULL,               -- clé de opusclip.config.programmes
  title         TEXT NOT NULL,
  source_key    TEXT NOT NULL,               -- fichier dans le stockage objet
  broadcast_date DATE,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_videos_client_idx ON client_videos(client_id);

CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY,
  access_token     TEXT NOT NULL,
  type             TEXT NOT NULL,              -- capsules | subtitles | photo
  status           TEXT NOT NULL,              -- draft | validated | paid | submitting | processing | postprocessing | ready | error
  options          JSONB NOT NULL,             -- choix du client (bruts)
  client           JSONB NOT NULL DEFAULT '{}',
  payment_status   TEXT NOT NULL DEFAULT 'unpaid',
  payment_ref      TEXT,
  opus_project_id  TEXT,
  opus_payload     JSONB,
  subtitle_mode    TEXT,                       -- opus_transcript | client_file
  estimated_credits NUMERIC NOT NULL DEFAULT 0,
  error            TEXT,
  webhook_received_at TIMESTAMPTZ,
  last_polled_at   TIMESTAMPTZ,
  poll_clip_count  INTEGER,
  submitted_at     TIMESTAMPTZ,
  ready_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS orders_client_idx ON orders(client_id);

CREATE TABLE IF NOT EXISTS deliverables (
  id           UUID PRIMARY KEY,
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  title        TEXT,
  duration_ms  INTEGER,
  size_bytes   BIGINT,
  opus_clip_id TEXT,
  expires_at   TIMESTAMPTZ,
  purged       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, opus_clip_id)
);

CREATE TABLE IF NOT EXISTS order_events (
  id         BIGSERIAL PRIMARY KEY,
  order_id   UUID REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_salts (
  salt        TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id         BIGSERIAL PRIMARY KEY,
  order_id   UUID REFERENCES orders(id) ON DELETE SET NULL,
  credits    NUMERIC NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Publication sur les réseaux (Upload-Post), légendes et statistiques
const SOCIAL_SCHEMA = `
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sector TEXT;              -- secteur d'activité (légendes IA)
ALTER TABLE deliverables ADD COLUMN IF NOT EXISTS transcript TEXT;     -- texte du clip, enregistré à la livraison

-- Un profil Upload-Post par client (créé au premier clic sur un réseau). username = id interne du client.
CREATE TABLE IF NOT EXISTS social_profiles (
  client_id          UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  username           TEXT NOT NULL UNIQUE,
  facebook_page_id   TEXT,
  facebook_page_name TEXT,
  stats_refresh_at   TIMESTAMPTZ,                 -- dernier « Actualiser » manuel (limite 1 / 15 min)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Légendes par réseau, générées une fois par vidéo
CREATE TABLE IF NOT EXISTS video_captions (
  deliverable_id UUID PRIMARY KEY REFERENCES deliverables(id) ON DELETE CASCADE,
  captions       JSONB NOT NULL,
  source         TEXT NOT NULL,                   -- ai | fallback
  model          TEXT,
  regen_count    INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publications (
  id             UUID PRIMARY KEY,
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  deliverable_id UUID REFERENCES deliverables(id) ON DELETE SET NULL,
  order_id       UUID,
  video_title    TEXT,
  video_kind     TEXT,                            -- capsules | teaser | subtitles
  programme_id   TEXT,
  platforms      TEXT[] NOT NULL,
  texts          JSONB NOT NULL,                  -- { youtube: {title, description}, instagram: {caption}, ... }
  scheduled_at   TIMESTAMPTZ,
  timezone       TEXT,
  request_id     TEXT,
  job_id         TEXT,
  status         TEXT NOT NULL,                   -- submitting | scheduled | in_progress | published | partial | failed
  error          TEXT,
  last_polled_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publications_client ON publications (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS publications_request ON publications (request_id);
CREATE INDEX IF NOT EXISTS publications_job ON publications (job_id);

-- Une ligne par réseau : statut, lien du post, dernières statistiques connues (NULL = non fournie)
CREATE TABLE IF NOT EXISTS publication_targets (
  publication_id   UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL,
  status           TEXT NOT NULL,                 -- pending | scheduled | published | failed
  post_url         TEXT,
  platform_post_id TEXT,
  error            TEXT,
  published_at     TIMESTAMPTZ,
  views            BIGINT,
  likes            BIGINT,
  comments         BIGINT,
  shares           BIGINT,
  stats_error      TEXT,
  stats_at         TIMESTAMPTZ,
  PRIMARY KEY (publication_id, platform)
);

-- Notifications Upload-Post déjà traitées (X-Upload-Post-Delivery)
CREATE TABLE IF NOT EXISTS social_deliveries (
  id          TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Demandes de montage par nos monteurs (formulaire client + paiement Stripe)
const MONTAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS montage_requests (
  id                 UUID PRIMARY KEY,
  client_id          UUID REFERENCES clients(id) ON DELETE SET NULL,
  offer_id           TEXT NOT NULL,
  offer_title        TEXT NOT NULL,
  amount_ht_cents    INTEGER,                    -- NULL : prix à définir (pas de paiement en ligne)
  amount_ttc_cents   INTEGER,
  contact            JSONB NOT NULL,             -- { company, name, email, phone }
  brief              JSONB NOT NULL,             -- { description, programme, formats, deadline }
  status             TEXT NOT NULL,              -- awaiting_payment | paid | to_quote | cancelled
  return_base        TEXT,                       -- site où renvoyer le client après le paiement
  stripe_session_id  TEXT UNIQUE,
  stripe_payment_intent TEXT,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS montage_requests_client ON montage_requests (client_id, created_at DESC);
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Codes de connexion (src/loginCodes.js) : empreinte pour la connexion, copie chiffrée jusqu'au mail du jour J
const LOGIN_SCHEMA = `
ALTER TABLE clients ADD COLUMN IF NOT EXISTS login_code_hash TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS login_code_enc TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS login_code_created_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;      -- première connexion par code
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS clients_login_code_hash ON clients (login_code_hash);
`;

// Diffusions vidéo lues dans le planning (src/planningSync.js) : une ligne par diffusion, reliée au client
const DIFFUSIONS_SCHEMA = `
ALTER TABLE clients ADD COLUMN IF NOT EXISTS company_key TEXT;            -- entreprise normalisée (regroupement)
CREATE INDEX IF NOT EXISTS clients_company_key ON clients (company_key);
CREATE TABLE IF NOT EXISTS diffusions (
  id                  UUID PRIMARY KEY,
  planning_id         INTEGER NOT NULL UNIQUE,     -- identifiant de la ligne dans le planning
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sf_opportunity_id   TEXT,
  entreprise          TEXT NOT NULL,
  media               TEXT,
  sous_media          TEXT,
  format              TEXT,
  date_diffusion      DATE,
  planning_statut     TEXT,                        -- statut brut du planning (confirme, a_programmer, annule…)
  state               TEXT NOT NULL,               -- active | date_pending | cancelled
  contact_name        TEXT,                        -- signataire du BDC (planning)
  contact_email       TEXT,
  email_override      TEXT,                        -- « autre destinataire » saisi par l'équipe
  video_id            UUID REFERENCES client_videos(id) ON DELETE SET NULL,
  drive_folder_id     TEXT,
  mail_sent_at        TIMESTAMPTZ,
  planning_updated_at TEXT,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diffusions_client ON diffusions (client_id);
CREATE INDEX IF NOT EXISTS diffusions_date ON diffusions (date_diffusion);
`;

async function migrate() {
  await pool.query(SCHEMA);
  await pool.query(LOGIN_SCHEMA);
  await pool.query('ALTER TABLE client_videos ADD COLUMN IF NOT EXISTS duration_sec REAL');
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS finalize_restarts INTEGER NOT NULL DEFAULT 0');
  await pool.query(SOCIAL_SCHEMA);
  await pool.query(MONTAGE_SCHEMA);
  await pool.query(DIFFUSIONS_SCHEMA);
  // L'émission « immersion » est devenue « capital »
  await pool.query("UPDATE client_videos SET programme_id = 'capital' WHERE programme_id = 'immersion'");
}

function query(text, params) {
  return pool.query(text, params);
}

async function logEvent(orderId, kind, detail = null) {
  try {
    await pool.query('INSERT INTO order_events (order_id, kind, detail) VALUES ($1, $2, $3)', [
      orderId,
      kind,
      detail ? JSON.stringify(detail) : null,
    ]);
  } catch (e) {
    console.error('[db] logEvent failed', e.message);
  }
}

module.exports = { pool, query, migrate, logEvent };
