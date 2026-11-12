// Parcours 2 — Commande + demande d'avis J+30 : délais 2 h et 30 j avec horloge simulée, annulation, idempotence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { setup, M, H, D } from './helpers.js';
import { parisParts } from '../lib/timeWindow.js';
import { eventsRouter } from '../lib/eventsApi.js';
import { createLogger } from '../lib/log.js';

const USER = { id: 'c1', email: 'c.dumas@ecoval-industrie.fr', name: 'Ecoval Industrie', contact: 'Claire Dumas' };
const started = (order = 'o1', key = order) => ({ event_type: 'order.started', source: 'front', idempotency_key: `order.started:c1:${key}`, user: USER, metadata: { order_id: order, offer_id: 'teaser' } });
const confirmed = (order = 'o1', user = USER) => ({ event_type: 'order.confirmed', source: 'server', idempotency_key: `order.confirmed:${user.id}:${order}`, user, metadata: { order_id: order, offer_id: 'teaser', offer_title: 'Teaser vidéo de 30 à 40 secondes', price: 680 } });
const byStep = async t => Object.fromEntries((await t.emails()).map(e => [e.step, e]));
const parisHM = d => { const p = parisParts(new Date(d)); return `${p.h}:${String(p.mi).padStart(2, '0')}`; };
const NOON = '2026-11-12T11:00:00Z'; // midi à Paris

test('sans confirmation : « Votre commande vous attend » part à T+2 h, puis fin', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(started());
    t.clock.advance(2 * H - M); await t.engine.tick(); assert.equal(t.mailer.sent.length, 0, 'rien avant 2 h');
    t.clock.advance(M); await t.engine.tick();
    assert.equal(t.mailer.sent.length, 1); assert.equal(t.mailer.sent[0].templateKey, 'order_reminder');
    assert.equal(t.mailer.sent[0].variables.offer, 'Teaser vidéo de 30 à 40 secondes'); assert.equal(t.mailer.sent[0].variables.price, '680 € HT');
    assert.equal((await t.journeys())[0].state, 'reminded');
  } finally { await t.close(); }
});

test('confirmation avant 2 h : confirmation immédiate, relance annulée, avis à J+30', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(started()); t.clock.advance(30 * M);
    await t.engine.ingest(confirmed()); await t.engine.tick();
    assert.deepEqual(t.mailer.sent.map(m => m.templateKey), ['order_confirm']);
    const s = await byStep(t);
    assert.equal(s.reminder.status, 'cancelled'); assert.equal(s.reminder.status_reason, 'commande confirmée');
    assert.equal(s.review.status, 'pending');
    assert.ok(new Date(s.review.due_at) <= new Date(t.clock().getTime() + 30 * D), 'avis au plus tard à J+30');
    t.clock.advance(3 * H); await t.engine.tick(); assert.equal(t.mailer.sent.length, 1, 'pas de relance après confirmation');
    t.clock.advance(30 * D); await t.engine.tick();
    assert.deepEqual(t.mailer.sent.map(m => m.templateKey), ['order_confirm', 'review']);
    const js = await t.journeys(); assert.equal(js.find(j => j.type === 'order').state, 'confirmed'); assert.equal(js.find(j => j.type === 'review').state, 'review_sent');
  } finally { await t.close(); }
});

test('confirmation après la relance : confirmation + avis quand même', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(started()); t.clock.advance(2 * H); await t.engine.tick();
    t.clock.advance(H); await t.engine.ingest(confirmed()); await t.engine.tick();
    assert.deepEqual(t.mailer.sent.map(m => m.templateKey), ['order_reminder', 'order_confirm']);
    assert.equal((await byStep(t)).review.status, 'pending');
  } finally { await t.close(); }
});

test('plusieurs clics sur « Commander » pour la même commande : un parcours, une relance', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(started()); await t.engine.ingest(started()); await t.engine.ingest(started('o1', 'o1-reclic'));
    t.clock.advance(3 * H); await t.engine.tick(); await t.engine.tick();
    assert.equal(t.mailer.sent.length, 1); assert.equal((await t.journeys()).length, 1);
  } finally { await t.close(); }
});

test('relance qui tomberait la nuit : reportée à 9 h (Paris) le lendemain', async () => {
  const t = await setup({ now: '2026-11-12T18:30:00Z' }); // 19 h 30 à Paris -> 21 h 30
  try {
    await t.engine.ingest(started());
    const { reminder } = await byStep(t); assert.equal(parisHM(reminder.due_at), '9:00');
    assert.equal(parisParts(new Date(reminder.due_at)).d, 13);
  } finally { await t.close(); }
});

test('confirmation enregistrée au moment même de la relance : la relance est revérifiée et non envoyée', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(started()); t.clock.advance(2 * H);
    // Événement arrivé sans passer par le moteur (course entre deux processus) : seule la revérification le voit.
    await t.db.query(`INSERT INTO events (idempotency_key, event_type, user_id, email, occurred_at, source, metadata) VALUES ('x','order.confirmed','c1','a@b.fr',$1,'server','{"order_id":"o1"}')`, [t.clock()]);
    await t.engine.tick();
    assert.equal(t.mailer.sent.length, 0); const { reminder } = await byStep(t); assert.equal(reminder.status, 'skipped'); assert.equal(reminder.status_reason, 'commande confirmée');
  } finally { await t.close(); }
});

test('confirmation sans clic « Commander » enregistré : parcours créé, confirmation envoyée', async () => {
  const t = await setup({ now: NOON });
  try { await t.engine.ingest(confirmed('o9')); await t.engine.tick(); assert.deepEqual(t.mailer.sent.map(m => m.templateKey), ['order_confirm']); }
  finally { await t.close(); }
});

test('client désinscrit : la relance (marketing) est bloquée, la confirmation (transactionnelle) part', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(started()); await t.db.query("UPDATE clients SET unsubscribed_at=$1 WHERE id='c1'", [t.clock()]);
    t.clock.advance(2 * H); await t.engine.tick(); assert.equal(t.mailer.sent.length, 0);
    assert.equal((await byStep(t)).reminder.status_reason, 'désinscrit');
    await t.engine.ingest(confirmed()); await t.engine.tick(); assert.deepEqual(t.mailer.sent.map(m => m.templateKey), ['order_confirm']);
  } finally { await t.close(); }
});

test('avis : jamais après J+30, avancé dans la plage 9 h-20 h', async () => {
  const t = await setup({ now: '2026-11-12T02:00:00Z' }); // 3 h du matin à Paris
  try {
    await t.engine.ingest(confirmed());
    const { review } = await byStep(t);
    assert.ok(new Date(review.due_at) <= new Date(new Date('2026-11-12T02:00:00Z').getTime() + 30 * D));
    assert.equal(parisHM(review.due_at), '19:30'); assert.equal(parisParts(new Date(review.due_at)).d, 11); // 11/12 19 h 30, la veille de J+30
  } finally { await t.close(); }
});

test('avis dédoublonné : une seule demande par client sur 90 jours, la plus proche est gardée', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(confirmed('o1')); t.clock.advance(10 * D); await t.engine.ingest(confirmed('o2'));
    let reviews = (await t.emails()).filter(e => e.step === 'review'); assert.equal(reviews.length, 1, 'une seule demande programmée');
    t.clock.advance(25 * D); await t.engine.tick();
    assert.equal(t.mailer.sent.filter(m => m.templateKey === 'review').length, 1);
    t.clock.advance(20 * D); await t.engine.ingest(confirmed('o3')); // 45 jours après le premier avis
    reviews = (await t.emails()).filter(e => e.step === 'review'); assert.equal(reviews.length, 1, 'pas de nouvelle demande sous 90 jours');
    assert.equal(t.log.find('review.deduplicated').length, 2);
  } finally { await t.close(); }
});

test('POST /api/orders/confirm : offre et prix validés par le serveur, doublon, offre sur devis refusée', async () => {
  const t = await setup({ now: NOON }); const app = express(); app.use(express.json());
  app.use(eventsRouter({ getEngine: () => t.engine, log: createLogger(() => {}) }));
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    const body = { order_id: 'o42', offer_id: 'teaser', price: 1, user: USER };
    assert.equal((await post('/api/orders/confirm', body)).status, 201);
    assert.deepEqual((await post('/api/orders/confirm', body)).body, { ok: true, duplicate: true });
    assert.equal((await post('/api/orders/confirm', { ...body, offer_id: 'posts-rs' })).status, 400);
    assert.equal((await post('/api/orders/confirm', { ...body, offer_id: 'inconnue' })).status, 400);
    const ev = (await t.db.query("SELECT * FROM events WHERE event_type='order.confirmed'")).rows[0];
    assert.equal(ev.source, 'server'); assert.equal(ev.metadata.price, 680, 'prix du catalogue serveur, pas du navigateur');
    assert.equal((await post('/api/events', { event_type: 'order.confirmed', idempotency_key: 'abcdefgh', user: USER, metadata: { order_id: 'o1' } })).status, 403);
  } finally { srv.close(); await t.close(); }
});
