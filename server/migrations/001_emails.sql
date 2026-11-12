-- Emails automatiques (Mailjet) : événements, parcours, emails programmés, retours Mailjet.
-- Toutes les dates sont en UTC (timestamptz).

CREATE TABLE IF NOT EXISTS clients (
  id                text PRIMARY KEY,                 -- identifiant OpenStudio du client (c.id)
  email             text NOT NULL,
  name              text,
  contact           text,
  marketing_consent boolean,                          -- NULL : non renseigné (règle à décider)
  consent_source    text,
  unsubscribed_at   timestamptz,                      -- désinscription (lien ou webhook Mailjet)
  email_invalid_at  timestamptz,                      -- hard bounce / bloqué
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id               bigserial PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,              -- un même événement n'est enregistré qu'une fois
  event_type       text NOT NULL,
  user_id          text,
  email            text,
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL CHECK (source IN ('front', 'server')),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_user_type_time ON events (user_id, event_type, occurred_at);

CREATE TABLE IF NOT EXISTS journeys (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,                         -- quote | order | activation | review
  subject_key  text NOT NULL,                         -- quote_id, order_id ou user_id selon le parcours
  user_id      text,
  email        text NOT NULL,
  state        text NOT NULL,
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  entered_at   timestamptz NOT NULL,
  exited_at    timestamptz,
  exit_reason  text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, subject_key)                          -- pas de doublon de parcours
);
CREATE INDEX IF NOT EXISTS journeys_user ON journeys (user_id, type);

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id                  bigserial PRIMARY KEY,
  journey_id          bigint NOT NULL REFERENCES journeys(id),
  step                text NOT NULL,                  -- étape du parcours (ack, internal, reminder…)
  template_key        text NOT NULL,
  category            text NOT NULL CHECK (category IN ('transactional', 'marketing', 'internal')),
  to_email            text NOT NULL,
  to_name             text,
  variables           jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at              timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'skipped', 'failed')),
  attempts            int NOT NULL DEFAULT 0,
  last_error          text,
  status_reason       text,
  mailjet_message_id  text,
  created_at          timestamptz NOT NULL,
  sent_at             timestamptz,
  updated_at          timestamptz NOT NULL,
  UNIQUE (journey_id, step)                           -- une étape = un seul email, même si le job est rejoué
);
CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_emails (status, due_at);

CREATE TABLE IF NOT EXISTS email_events (
  id           bigserial PRIMARY KEY,
  event        text NOT NULL,                         -- sent, open, click, bounce, spam, blocked, unsub
  email        text,
  message_id   text,
  custom_id    text,
  occurred_at  timestamptz,
  payload      jsonb NOT NULL,
  processed_at timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, event, occurred_at)
);
