// Parcours 3 — Devis : accusé de réception (< 2 min), notification interne, idempotence, erreurs Mailjet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, runFor, transient, permanent, S, M } from './helpers.js';

const quote = (over = {}) => ({
  event_type: 'quote.requested', source: 'front', idempotency_key: 'quote.requested:c1:o123',
  user: { id: 'c1', email: 'c.dumas@ecoval-industrie.fr', name: 'Ecoval Industrie', contact: 'Claire Dumas' },
  metadata: { quote_id: 'o123', offer_id: 'posts-rs', offer_title: 'Publications réseaux sociaux', note: 'Pour novembre', manager: 'Lola Durand' },
  ...over
});

test('accusé de réception et notification interne envoyés immédiatement', async () => {
  const t = await setup({ salesEmail: 'commercial@exemple.fr' });
  try {
    await t.engine.ingest(quote());
    await t.engine.tick();
    assert.equal(t.mailer.sent.length, 2);
    const [ack, internal] = t.mailer.sent;
    assert.equal(ack.templateKey, 'quote_ack'); assert.equal(ack.to.email, 'c.dumas@ecoval-industrie.fr');
    assert.equal(ack.variables.firstname, 'Claire'); assert.equal(ack.variables.offer, 'Publications réseaux sociaux');
    assert.match(ack.customId, /^se-\d+$/);
    assert.equal(internal.templateKey, 'quote_internal'); assert.equal(internal.to.email, 'commercial@exemple.fr');
    const [j] = await t.journeys(); assert.equal(j.state, 'ack_sent'); assert.ok(j.exited_at);
    const emails = await t.emails(); assert.deepEqual(emails.map(e => e.status), ['sent', 'sent']);
    assert.deepEqual(emails.map(e => e.category), ['transactional', 'internal']);
  } finally { await t.close(); }
});

test('sans email commercial configuré : seul l’accusé part', async () => {
  const t = await setup();
  try { await t.engine.ingest(quote()); await t.engine.tick(); assert.equal(t.mailer.sent.length, 1); assert.equal(t.mailer.sent[0].templateKey, 'quote_ack'); }
  finally { await t.close(); }
});

test('double clic ou événement rejoué : un seul parcours, un seul email', async () => {
  const t = await setup();
  try {
    const a = await t.engine.ingest(quote()); const b = await t.engine.ingest(quote());
    assert.equal(a.duplicate, false); assert.equal(b.duplicate, true);
    // Même devis renvoyé avec une autre clé : le parcours (unique par quote_id) n'est pas recréé.
    await t.engine.ingest(quote({ idempotency_key: 'quote.requested:c1:autre-cle' }));
    await t.engine.tick(); await t.engine.tick();
    assert.equal(t.mailer.sent.length, 1); assert.equal((await t.journeys()).length, 1);
    assert.equal((await t.db.query('SELECT count(*)::int n FROM events')).rows[0].n, 2);
  } finally { await t.close(); }
});

test('deux workers en parallèle (job rejoué) : aucun double envoi', async () => {
  const t = await setup();
  try {
    await t.engine.ingest(quote());
    await Promise.all([t.engine.tick(), t.engine.tick(), t.engine.tick()]);
    assert.equal(t.mailer.sent.length, 1);
  } finally { await t.close(); }
});

test('envoi en pleine nuit : le transactionnel n’attend pas 9 h', async () => {
  const t = await setup({ now: '2026-11-12T02:30:00Z' }); // 3 h 30 à Paris
  try { await t.engine.ingest(quote()); await t.engine.tick(); assert.equal(t.mailer.sent.length, 1); }
  finally { await t.close(); }
});

test('Mailjet indisponible 3 fois : l’accusé part quand même en moins de 2 minutes', async () => {
  const t = await setup();
  try {
    await t.engine.ingest(quote()); const t0 = t.clock();
    t.mailer.failNext(transient(), transient(), transient());
    await runFor(t, 2 * M);
    const [e] = await t.emails();
    assert.equal(e.status, 'sent'); assert.equal(e.attempts, 4);
    const delay = (new Date(e.sent_at) - t0) / S; assert.ok(delay <= 120, `délai ${delay} s`);
    assert.equal(t.log.find('email.retry').length, 3);
  } finally { await t.close(); }
});

test('erreur définitive (template invalide) : pas de nouvelle tentative, échec journalisé', async () => {
  const t = await setup();
  try {
    await t.engine.ingest(quote()); t.mailer.failNext(permanent());
    await runFor(t, 2 * M);
    const [e] = await t.emails(); assert.equal(e.status, 'failed'); assert.equal(e.attempts, 1); assert.equal(e.last_error, 'Template introuvable');
    assert.equal(t.mailer.sent.length, 0);
    const [j] = await t.journeys(); assert.equal(j.state, 'ack_failed');
    assert.equal(t.log.find('email.failed').length, 1);
  } finally { await t.close(); }
});

test('envoi interrompu (serveur arrêté pendant l’appel) : marqué incertain, jamais renvoyé', async () => {
  const t = await setup();
  try {
    await t.engine.ingest(quote());
    await t.db.query("UPDATE scheduled_emails SET status='sending', attempts=1, updated_at=$1", [t.clock()]);
    t.clock.advance(11 * M); await t.engine.tick();
    const [e] = await t.emails(); assert.equal(e.status, 'failed'); assert.equal(t.mailer.sent.length, 0);
    assert.equal(t.log.find('email.uncertain').length, 1);
  } finally { await t.close(); }
});

test('journaux structurés : chaque transition et chaque envoi, adresses masquées en production', async () => {
  const t = await setup();
  try {
    await t.engine.ingest(quote()); await t.engine.tick();
    const msgs = t.log.lines.map(l => l.msg);
    for (const m of ['event.recorded', 'journey.entered', 'email.scheduled', 'email.sent', 'journey.exited']) assert.ok(msgs.includes(m), m);
    const sent = t.log.find('email.sent')[0]; assert.equal(sent.mailjet_message_id, '9001'); assert.equal(sent.journey, 'quote');
  } finally { await t.close(); }
});
