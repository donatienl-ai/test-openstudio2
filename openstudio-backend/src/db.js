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

async function migrate() {
  await pool.query(SCHEMA);
  await pool.query('ALTER TABLE client_videos ADD COLUMN IF NOT EXISTS duration_sec REAL');
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
