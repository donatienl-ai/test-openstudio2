// Initialisation des emails automatiques : base, client Mailjet, moteur, parcours, worker.
// Inactif tant que DATABASE_URL n'est pas renseignée (le reste du serveur fonctionne normalement).
import { createDb, migrate } from './db.js';
import { createLogger } from './log.js';
import { createMailjet } from './mailjet.js';
import { createEngine } from './journeys/engine.js';
import { registerQuoteJourney } from './journeys/quote.js';
import { registerOrderJourney } from './journeys/order.js';
import { registerReviewJourney } from './journeys/review.js';
import { registerActivationJourney } from './journeys/activation.js';

export function emailConfig(env = process.env) {
  return {
    databaseUrl: env.DATABASE_URL || '',
    mailjet: {
      apiKey: env.MAILJET_API_KEY || '', secretKey: env.MAILJET_SECRET_KEY || '',
      fromEmail: env.MAILJET_FROM_EMAIL || '', fromName: env.MAILJET_FROM_NAME || 'OpenMedias',
      sandbox: env.MAILJET_SANDBOX === '1',
      ...(env.MAILJET_API_URL ? { apiUrl: env.MAILJET_API_URL } : {}), // tests locaux uniquement
      redirectTo: (env.MAIL_REDIRECT_TO || '').trim(),
      allowRealRecipients: env.MAIL_ALLOW_REAL_RECIPIENTS === '1',
      errorReportTo: (env.MAIL_REDIRECT_TO || env.SALES_NOTIFY_EMAIL || '').trim()
    },
    salesEmail: (env.SALES_NOTIFY_EMAIL || '').trim(),
    window: env.EMAIL_SEND_WINDOW || '9-20',
    requireConsent: env.MARKETING_REQUIRE_CONSENT === '1',
    reviewDedupDays: Number(env.REVIEW_DEDUP_DAYS) > 0 ? Number(env.REVIEW_DEDUP_DAYS) : 90
  };
}

// Enregistre tous les parcours disponibles sur un moteur (utilisé aussi par les tests).
export function registerJourneys(engine, cfg) {
  registerQuoteJourney(engine, { salesEmail: cfg.salesEmail });
  registerOrderJourney(engine);
  registerReviewJourney(engine);
  registerActivationJourney(engine);
}

// Création ponctuelle d'une autre base dans la même instance PostgreSQL (ex. CREATE_DATABASE=openstudio_backend
// pour le back-end des commandes), sans installer psql. Sans effet si la base existe déjà ou si la variable est vide.
export async function createExtraDatabase(db, name, log) {
  if (!name) return null;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) { log.error('database.create_refused', { reason: 'nom invalide (minuscules, chiffres, _)' }); return null; }
  try {
    const exists = (await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
    if (exists) { log.info('database.exists', { database: name }); return 'exists'; }
    await db.query(`CREATE DATABASE "${name}"`);
    log.info('database.created', { database: name });
    return 'created';
  } catch (e) { log.error('database.create_failed', { database: name, error: e.message }); return null; }
}

export async function startEmails(env = process.env) {
  const cfg = emailConfig(env); const log = createLogger();
  if (!cfg.databaseUrl) { log.warn('emails.disabled', { reason: 'DATABASE_URL vide' }); return null; }
  const db = createDb(cfg.databaseUrl); await migrate(db);
  await createExtraDatabase(db, env.CREATE_DATABASE, log);
  const mailer = createMailjet({ ...cfg.mailjet, log });
  const engine = createEngine({ db, mailer, log, config: { window: cfg.window, requireConsent: cfg.requireConsent, reviewDedupDays: cfg.reviewDedupDays } });
  registerJourneys(engine, cfg);
  engine.start();
  log.info('emails.started', { sandbox: cfg.mailjet.sandbox, redirect: !!cfg.mailjet.redirectTo, sales_notify: !!cfg.salesEmail, window: cfg.window });
  return { engine, db, log };
}
