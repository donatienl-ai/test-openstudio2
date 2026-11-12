// Parcours 1 — Activation : J+2, J+7, sortie anticipée par une vidéo, avis J+30 après la 1re vidéo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, H, D, M } from './helpers.js';
import { parisParts } from '../lib/timeWindow.js';
import { videoGeneratedEvent } from '../lib/journeys/activation.js';

const USER = { id: 'c3', email: 'i.morel@nexalis.fr', name: 'Nexalis Conseil', contact: 'Inès Morel' };
const login = (first = true, key = first ? 'first-login' : 'login-' + Math.random().toString(36).slice(2)) => ({ event_type: 'user.login', source: 'front', idempotency_key: `user.login:c3:${key}`, user: USER, metadata: { first } });
const video = (id = 'r1', now = new Date()) => videoGeneratedEvent({ jobId: id, status: 'done', client: USER, spec: { projectId: 'P1', clipId: 'P1.CU1', fmt: '9:16' }, fileName: 'capsule.mp4' }, now);
const NOON = '2026-11-12T11:00:00Z';
const step = async (t, s) => (await t.emails()).find(e => e.step === s);
const sentKeys = t => t.mailer.sent.map(m => m.templateKey);
const activation = async t => (await t.journeys()).find(j => j.type === 'activation');

test('aucune vidéo : Relance 1 à J+2, Relance 2 à J+7, puis fin', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login());
    t.clock.advance(2 * D - M); await t.engine.tick(); assert.deepEqual(sentKeys(t), []);
    t.clock.advance(M); await t.engine.tick(); assert.deepEqual(sentKeys(t), ['activation_1']);
    assert.equal((await activation(t)).state, 'relance1_sent');
    t.clock.advance(5 * D); await t.engine.tick(); assert.deepEqual(sentKeys(t), ['activation_1', 'activation_2']);
    const j = await activation(t); assert.equal(j.state, 'completed'); assert.ok(j.exited_at);
    t.clock.advance(30 * D); await t.engine.tick(); assert.equal(t.mailer.sent.length, 2);
  } finally { await t.close(); }
});

test('vidéo générée à J+1 : sortie anticipée, aucune relance, avis à J+30 de la vidéo', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login()); t.clock.advance(D);
    const videoAt = t.clock(); await t.engine.ingest(video('r1', t.clock()));
    const j = await activation(t); assert.equal(j.state, 'converted'); assert.equal(j.exit_reason, 'vidéo générée');
    assert.equal((await step(t, 'relance1')).status, 'cancelled'); assert.equal((await step(t, 'relance2')).status, 'cancelled');
    const review = await step(t, 'review'); assert.ok(new Date(review.due_at) <= new Date(videoAt.getTime() + 30 * D));
    t.clock.advance(31 * D); await t.engine.tick(); assert.deepEqual(sentKeys(t), ['review']);
  } finally { await t.close(); }
});

test('vidéo générée entre J+2 et J+7 : Relance 1 envoyée, Relance 2 annulée, avis programmé', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login()); t.clock.advance(2 * D); await t.engine.tick();
    t.clock.advance(2 * D); await t.engine.ingest(video('r1', t.clock()));
    t.clock.advance(4 * D); await t.engine.tick();
    assert.deepEqual(sentKeys(t), ['activation_1']); assert.equal((await step(t, 'relance2')).status, 'cancelled');
    assert.equal((await step(t, 'review')).status, 'pending');
  } finally { await t.close(); }
});

test('reconnexion : le parcours n’est pas relancé', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login()); await t.engine.ingest(login(false)); await t.engine.ingest(login(false));
    assert.equal((await t.journeys()).length, 1); assert.equal((await t.emails()).length, 2);
  } finally { await t.close(); }
});

test('client déjà connecté auparavant (nouveau navigateur, « first » erroné) : pas de parcours', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login(false)); t.clock.advance(D); await t.engine.ingest(login(true, 'first-login-autre-navigateur'));
    assert.equal((await t.journeys()).length, 0);
  } finally { await t.close(); }
});

test('vidéo enregistrée au moment même de la relance : revérification, relance non envoyée, sortie', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login()); t.clock.advance(2 * D);
    await t.db.query(`INSERT INTO events (idempotency_key, event_type, user_id, email, occurred_at, source) VALUES ('v-direct','video.generated','c3','i.morel@nexalis.fr',$1,'server')`, [t.clock()]);
    await t.engine.tick();
    assert.deepEqual(sentKeys(t), []); assert.equal((await step(t, 'relance1')).status_reason, 'vidéo générée');
    assert.equal((await activation(t)).state, 'converted'); assert.equal((await step(t, 'relance2')).status, 'cancelled');
  } finally { await t.close(); }
});

test('connexion à 23 h (Paris) : relances décalées à 9 h', async () => {
  const t = await setup({ now: '2026-11-12T22:00:00Z' });
  try {
    await t.engine.ingest(login());
    for (const s of ['relance1', 'relance2']) { const p = parisParts(new Date((await step(t, s)).due_at)); assert.equal(`${p.h}:${p.mi}`, '9:0', s); }
    assert.equal(parisParts(new Date((await step(t, 'relance1')).due_at)).d, 15); // 12/11 23 h + 2 j = 14/11 23 h -> 15/11 9 h
  } finally { await t.close(); }
});

test('deuxième vidéo : pas de seconde demande d’avis ; même vidéo rejouée : un seul événement', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login()); await t.engine.ingest(video('r1', t.clock())); await t.engine.ingest(video('r1', t.clock())); t.clock.advance(D); await t.engine.ingest(video('r2', t.clock()));
    assert.equal((await t.emails()).filter(e => e.step === 'review').length, 1);
    assert.equal((await t.db.query("SELECT count(*)::int n FROM events WHERE event_type='video.generated'")).rows[0].n, 2);
  } finally { await t.close(); }
});

test('avis commande déjà programmé puis 1re vidéo : une seule demande, à la date la plus proche', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest({ event_type: 'order.confirmed', source: 'server', idempotency_key: 'order.confirmed:c3:o1', user: USER, metadata: { order_id: 'o1', offer_id: 'teaser' } });
    const first = new Date((await step(t, 'review')).due_at);
    t.clock.advance(5 * D); await t.engine.ingest(video('r1', t.clock()));
    const reviews = (await t.emails()).filter(e => e.step === 'review'); assert.equal(reviews.length, 1);
    assert.equal(new Date(reviews[0].due_at).getTime(), first.getTime(), 'la plus proche (commande) est gardée');
  } finally { await t.close(); }
});

test('client désinscrit : relances bloquées', async () => {
  const t = await setup({ now: NOON });
  try {
    await t.engine.ingest(login()); await t.db.query("UPDATE clients SET unsubscribed_at=$1 WHERE id='c3'", [t.clock()]);
    t.clock.advance(8 * D); await t.engine.tick(); assert.deepEqual(sentKeys(t), []);
    assert.deepEqual((await t.emails()).map(e => e.status_reason), ['désinscrit', 'désinscrit']);
  } finally { await t.close(); }
});

test('événement video.generated : uniquement pour une vidéo terminée et un client identifié', () => {
  assert.equal(videoGeneratedEvent({ jobId: 'r1', status: 'running', client: USER }), null);
  assert.equal(videoGeneratedEvent({ jobId: 'r1', status: 'done' }), null);
  const ev = video('r9'); assert.equal(ev.idempotency_key, 'video.generated:c3:r9'); assert.equal(ev.source, 'server'); assert.equal(ev.metadata.fmt, '9:16');
});
