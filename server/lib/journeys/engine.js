// Moteur de parcours : enregistrement idempotent des événements, entrée/sortie des parcours,
// programmation des emails, et worker qui revérifie chaque condition juste avant l'envoi.
import { TEMPLATES } from '../emailTemplates.js';
import { fitWindow, parseWindow } from '../timeWindow.js';

// Délais avant nouvelle tentative (secondes). Transactionnel : tout doit partir en moins de 2 minutes.
const RETRY = { transactional: [5, 15, 30], internal: [5, 15, 30], marketing: [300, 1800, 7200] };
const STUCK_MS = 10 * 60 * 1000;

export function createEngine({ db, mailer, log, clock = () => new Date(), config = {} }) {
  const cfg = { ...config, window: parseWindow(config.window), requireConsent: !!config.requireConsent, batch: config.batch || 20 };
  const handlers = {}; const guards = {}; const onSent = {}; const onSkip = {}; const onFailed = {};
  let kickTimer = null;

  /* ---------- Outils mis à disposition des parcours ---------- */
  const ctxFor = c => {
    const now = clock();
    const ctx = {
      now, cfg, log,
      async enterJourney(type, subjectKey, { userId, email, state, context = {} }) {
        const r = await c.query(`INSERT INTO journeys (type, subject_key, user_id, email, state, context, entered_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (type, subject_key) DO NOTHING RETURNING *`, [type, String(subjectKey), userId || null, email, state, context, now]);
        if (r.rowCount) { log.info('journey.entered', { journey: type, journey_id: r.rows[0].id, subject: String(subjectKey), user_id: userId, state }); return { journey: r.rows[0], created: true }; }
        const ex = await c.query('SELECT * FROM journeys WHERE type=$1 AND subject_key=$2', [type, String(subjectKey)]);
        log.info('journey.already_in', { journey: type, journey_id: ex.rows[0].id, subject: String(subjectKey), state: ex.rows[0].state });
        return { journey: ex.rows[0], created: false };
      },
      async setState(journey, state, reason) {
        if (journey.state === state) return journey;
        await c.query('UPDATE journeys SET state=$2, updated_at=$3 WHERE id=$1', [journey.id, state, now]);
        log.info('journey.transition', { journey: journey.type, journey_id: journey.id, from: journey.state, to: state, reason });
        journey.state = state; return journey;
      },
      // Sortie du parcours : annule tous les emails encore en attente (cancel = true) ou les laisse partir (fin normale).
      async exitJourney(journey, state, reason, { cancel = true } = {}) {
        await c.query('UPDATE journeys SET state=$2, exited_at=$3, exit_reason=$4, updated_at=$3 WHERE id=$1 AND exited_at IS NULL', [journey.id, state, now, reason]);
        log.info('journey.exited', { journey: journey.type, journey_id: journey.id, from: journey.state, to: state, reason });
        journey.state = state; journey.exited_at = now;
        if (cancel) await ctx.cancelEmails(journey, null, reason);
      },
      async cancelEmails(journey, steps, reason) {
        const r = await c.query(`UPDATE scheduled_emails SET status='cancelled', status_reason=$3, updated_at=$4
          WHERE journey_id=$1 AND status='pending' AND ($2::text[] IS NULL OR step = ANY($2)) RETURNING id, step`, [journey.id, steps, reason, now]);
        for (const e of r.rows) log.info('email.cancelled', { journey: journey.type, journey_id: journey.id, email_id: e.id, step: e.step, reason });
        return r.rowCount;
      },
      // Programme un email. Transactionnel : tout de suite. Marketing : ramené dans la plage 9 h - 20 h (Paris).
      async schedule(journey, { step, template, to, toName, variables = {}, dueAt = now, latest = false }) {
        const t = TEMPLATES[template]; if (!t) throw new Error(`template inconnu : ${template}`);
        const due = t.category === 'marketing' ? fitWindow(dueAt, cfg.window, latest ? 'backward' : 'forward') : dueAt;
        const r = await c.query(`INSERT INTO scheduled_emails (journey_id, step, template_key, category, to_email, to_name, variables, due_at, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (journey_id, step) DO NOTHING RETURNING id, due_at`, [journey.id, step, template, t.category, to, toName || null, variables, due, now]);
        if (r.rowCount) log.info('email.scheduled', { journey: journey.type, journey_id: journey.id, email_id: r.rows[0].id, step, template, category: t.category, due_at: due.toISOString(), to_email: to });
        return r.rowCount ? r.rows[0] : null;
      },
      async countEvents(userId, type, sinceDate) {
        const r = await c.query('SELECT count(*)::int AS n FROM events WHERE user_id=$1 AND event_type=$2 AND occurred_at >= $3', [userId, type, sinceDate]);
        return r.rows[0].n;
      },
      query: (t, p) => c.query(t, p)
    };
    return ctx;
  };

  /* ---------- Événements ---------- */
  async function upsertClient(c, u, now) {
    if (!u || !u.id || !u.email) return;
    await c.query(`INSERT INTO clients (id, email, name, contact, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)
      ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=COALESCE(EXCLUDED.name, clients.name), contact=COALESCE(EXCLUDED.contact, clients.contact), updated_at=EXCLUDED.updated_at`,
    [String(u.id), String(u.email), u.name || null, u.contact || null, now]);
  }

  // ev = { event_type, idempotency_key, user: {id, email, name, contact}?, email?, occurred_at?, source, metadata }
  async function ingest(ev) {
    const res = await db.tx(async c => {
      const now = clock();
      await upsertClient(c, ev.user, now);
      const r = await c.query(`INSERT INTO events (idempotency_key, event_type, user_id, email, occurred_at, source, metadata, received_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [ev.idempotency_key, ev.event_type, ev.user ? String(ev.user.id) : null, (ev.user && ev.user.email) || ev.email || null, ev.occurred_at || now, ev.source, ev.metadata || {}, now]);
      if (!r.rowCount) { log.info('event.duplicate', { event_type: ev.event_type, idempotency_key: ev.idempotency_key }); return { duplicate: true }; }
      const event = { ...ev, id: r.rows[0].id, user_id: ev.user ? String(ev.user.id) : null, email: (ev.user && ev.user.email) || ev.email, occurred_at: ev.occurred_at || now };
      log.info('event.recorded', { event_id: event.id, event_type: ev.event_type, source: ev.source, user_id: event.user_id });
      const ctx = ctxFor(c);
      for (const fn of handlers[ev.event_type] || []) await fn(ctx, event);
      return { duplicate: false, id: event.id };
    });
    if (!res.duplicate) kick();
    return res;
  }

  /* ---------- Worker ---------- */
  function kick() { if (!cfg.autoKick || kickTimer) return; kickTimer = setTimeout(() => { kickTimer = null; tick().catch(e => log.error('worker.error', { error: e.message })); }, 50); }

  async function tick() {
    const now = clock();
    // Envoi interrompu (serveur arrêté pendant l'appel Mailjet) : on ne renvoie pas, pour ne jamais doubler un email.
    const stuck = await db.query(`UPDATE scheduled_emails SET status='failed', status_reason='état incertain après interruption', updated_at=$1
      WHERE status='sending' AND updated_at < $2 RETURNING id, step, template_key`, [now, new Date(now.getTime() - STUCK_MS)]);
    for (const e of stuck.rows) log.error('email.uncertain', { email_id: e.id, step: e.step, template: e.template_key, action: 'vérifier dans Mailjet (CustomID = email_id)' });
    const claimed = await db.query(`UPDATE scheduled_emails SET status='sending', attempts=attempts+1, updated_at=$1
      WHERE id IN (SELECT id FROM scheduled_emails WHERE status='pending' AND due_at <= $1 ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [now, cfg.batch]);
    for (const e of claimed.rows) await processOne(e).catch(err => log.error('email.process_error', { email_id: e.id, error: err.message }));
    return claimed.rowCount;
  }

  async function finish(e, status, fields = {}) {
    const now = clock();
    await db.query(`UPDATE scheduled_emails SET status=$2, status_reason=$3, last_error=$4, mailjet_message_id=$5, sent_at=$6, due_at=COALESCE($7, due_at), updated_at=$8 WHERE id=$1`,
      [e.id, status, fields.reason || null, fields.error || null, fields.messageId || null, status === 'sent' ? now : null, fields.dueAt || null, now]);
  }

  async function processOne(e) {
    const j = (await db.query('SELECT * FROM journeys WHERE id=$1', [e.journey_id])).rows[0];
    const client = j.user_id ? (await db.query('SELECT * FROM clients WHERE id=$1', [j.user_id])).rows[0] : null;
    const base = { email_id: e.id, journey: j.type, journey_id: j.id, step: e.step, template: e.template_key, category: e.category, attempt: e.attempts };

    // 1. Revérification au moment de l'envoi.
    let skip = null;
    if (e.category === 'marketing') {
      if (client && client.unsubscribed_at) skip = 'désinscrit';
      else if (client && client.email_invalid_at) skip = 'adresse invalide';
      else if (cfg.requireConsent && !(client && client.marketing_consent === true)) skip = 'consentement marketing absent';
    }
    if (!skip && guards[j.type]) skip = await db.tx(async c => guards[j.type](ctxFor(c), j, e));
    if (skip) {
      await finish(e, 'skipped', { reason: skip }); log.info('email.skipped', { ...base, reason: skip });
      if (onSkip[j.type]) await db.tx(c => onSkip[j.type](ctxFor(c), j, e, skip));
      return;
    }

    // 2. Envoi.
    try {
      const r = await mailer.send({ templateKey: e.template_key, to: { email: e.to_email, name: e.to_name }, variables: e.variables, customId: `se-${e.id}` });
      await finish(e, 'sent', { messageId: r.messageId });
      const now = clock();
      log.info('email.sent', { ...base, to_email: e.to_email, mailjet_message_id: r.messageId, sandbox: r.sandbox, delay_s: Math.round((now - new Date(e.due_at)) / 1000) });
      if (onSent[j.type]) await db.tx(c => onSent[j.type](ctxFor(c), j, e));
    } catch (err) {
      const delays = RETRY[e.category] || RETRY.marketing;
      if (err.retryable && e.attempts <= delays.length) {
        const dueAt = new Date(clock().getTime() + delays[e.attempts - 1] * 1000);
        await finish(e, 'pending', { error: err.message, dueAt });
        log.warn('email.retry', { ...base, error: err.message, next_at: dueAt.toISOString() });
      } else {
        await finish(e, 'failed', { error: err.message, reason: err.retryable ? 'tentatives épuisées' : 'erreur définitive' });
        log.error('email.failed', { ...base, error: err.message });
        if (onFailed[j.type]) await db.tx(c => onFailed[j.type](ctxFor(c), j, e));
      }
    }
  }

  let interval = null;
  return {
    ingest, tick, processOne, cfg,
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    guard(journeyType, fn) { guards[journeyType] = fn; },
    onSent(journeyType, fn) { onSent[journeyType] = fn; },
    onSkip(journeyType, fn) { onSkip[journeyType] = fn; },
    onFailed(journeyType, fn) { onFailed[journeyType] = fn; },
    withCtx: fn => db.tx(c => fn(ctxFor(c))),
    start(ms = 10000) { cfg.autoKick = true; interval = setInterval(() => tick().catch(e => log.error('worker.error', { error: e.message })), ms); kick(); },
    stop() { clearInterval(interval); cfg.autoKick = false; }
  };
}
