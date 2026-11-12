// Outils de test : base PostgreSQL de test remise à zéro, horloge simulée, faux Mailjet, journal en mémoire.
import { createDb, migrate } from '../lib/db.js';
import { createEngine } from '../lib/journeys/engine.js';
import { registerJourneys } from '../lib/emails.js';
import { MailError } from '../lib/mailjet.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/openstudio_test';
export const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

export function fakeClock(iso) {
  let t = new Date(iso).getTime();
  const c = () => new Date(t); c.advance = ms => { t += ms; return c(); }; c.set = s => { t = new Date(s).getTime(); };
  return c;
}

export function fakeMailer() {
  const sent = []; const queue = [];
  return {
    sent,
    failNext(...errs) { queue.push(...errs); },
    async send(m) { if (queue.length) throw queue.shift(); sent.push(m); return { messageId: String(9000 + sent.length), sandbox: true }; }
  };
}
export const transient = () => new MailError('HTTP 503', { retryable: true, status: 503 });
export const permanent = () => new MailError('Template introuvable', { retryable: false, status: 400 });

export function memLog() {
  const lines = []; const w = level => (msg, f = {}) => lines.push({ level, msg, ...f });
  return { lines, info: w('info'), warn: w('warn'), error: w('error'), find: msg => lines.filter(l => l.msg === msg) };
}

export async function setup({ now = '2026-11-12T10:00:00Z', salesEmail = '', requireConsent = false } = {}) {
  const db = createDb(TEST_DB);
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const clock = fakeClock(now); const mailer = fakeMailer(); const log = memLog();
  const engine = createEngine({ db, mailer, log, clock, config: { window: '9-20', requireConsent } });
  registerJourneys(engine, { salesEmail });
  const emails = async () => (await db.query('SELECT * FROM scheduled_emails ORDER BY id')).rows;
  const journeys = async () => (await db.query('SELECT * FROM journeys ORDER BY id')).rows;
  return { db, clock, mailer, log, engine, emails, journeys, close: () => db.close() };
}

// Fait tourner le worker en avançant l'horloge par pas (simule l'intervalle réel de 10 s).
export async function runFor(t, ms, step = 10 * S) {
  for (let el = 0; el <= ms; el += step) { await t.engine.tick(); if (el < ms) t.clock.advance(step); }
}
