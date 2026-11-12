// Socle : plage horaire (Paris), client Mailjet (payload, redirection de test, retries), validation de /api/events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fitWindow, parisParts } from '../lib/timeWindow.js';
import { createMailjet, MailError } from '../lib/mailjet.js';
import { validateFrontEvent, eventsRouter } from '../lib/eventsApi.js';
import { createLogger } from '../lib/log.js';
import { setup } from './helpers.js';

const paris = d => { const p = parisParts(d); return `${p.d}/${p.m} ${p.h}:${String(p.mi).padStart(2, '0')}`; };

test('plage 9 h - 20 h : report au lendemain 9 h, avance au dernier créneau, heure d’été', () => {
  assert.equal(paris(fitWindow(new Date('2026-11-12T21:00:00Z'))), '13/11 9:00');        // 22 h -> lendemain 9 h
  assert.equal(paris(fitWindow(new Date('2026-11-12T05:00:00Z'))), '12/11 9:00');        // 6 h -> 9 h
  assert.equal(paris(fitWindow(new Date('2026-11-12T13:00:00Z'))), '12/11 14:00');       // dans la plage : inchangé
  assert.equal(paris(fitWindow(new Date('2026-11-12T03:00:00Z'), undefined, 'backward')), '11/11 19:30'); // avis : jamais après l'échéance
  assert.equal(paris(fitWindow(new Date('2026-11-12T21:00:00Z'), undefined, 'backward')), '12/11 19:30');
  assert.equal(fitWindow(new Date('2026-07-01T05:00:00Z')).toISOString(), '2026-07-01T07:00:00.000Z'); // été : 9 h = 7 h UTC
  assert.equal(fitWindow(new Date('2026-03-29T01:30:00Z')).toISOString(), '2026-03-29T07:00:00.000Z'); // nuit du changement d'heure
});

const mj = (over = {}) => {
  const calls = []; const responses = over.responses || [];
  const fetchImpl = async (url, o) => { calls.push({ url, body: JSON.parse(o.body), auth: o.headers.Authorization }); const r = responses.shift() || { status: 200, json: { Messages: [{ Status: 'success', To: [{ MessageID: 123 }] }] } }; if (r.throw) throw new Error('réseau'); return { ok: r.status < 300, status: r.status, json: async () => r.json }; };
  return { calls, client: createMailjet({ apiKey: 'k', secretKey: 's', fromEmail: 'studio@openmedias.fr', redirectTo: 'test@exemple.fr', fetchImpl, sleep: async () => {}, env: over.env || {}, ...over.opts }) };
};

test('Mailjet : template configuré -> TemplateID + Variables + CustomID, redirection de test', async () => {
  const { calls, client } = mj({ env: { MJ_TPL_QUOTE_ACK: '4242' } });
  const r = await client.send({ templateKey: 'quote_ack', to: { email: 'client@exemple.fr', name: 'Claire' }, variables: { firstname: 'Claire' }, customId: 'se-1' });
  assert.equal(r.messageId, '123');
  const m = calls[0].body.Messages[0];
  assert.equal(calls[0].url, 'https://api.mailjet.com/v3.1/send');
  assert.equal(m.TemplateID, 4242); assert.equal(m.TemplateLanguage, true); assert.equal(m.CustomID, 'se-1');
  assert.equal(m.To[0].Email, 'test@exemple.fr'); assert.equal(m.Variables.original_recipient, 'client@exemple.fr');
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('k:s').toString('base64'));
});

test('Mailjet : template pas encore créé -> contenu de secours [TEST]', async () => {
  const { calls, client } = mj();
  await client.send({ templateKey: 'quote_ack', to: { email: 'client@exemple.fr' }, variables: { firstname: 'Claire', offer: 'Teaser', manager: 'Lola' }, customId: 'se-2' });
  const m = calls[0].body.Messages[0];
  assert.equal(m.TemplateID, undefined); assert.match(m.Subject, /^\[TEST\] Nous avons bien reçu/); assert.match(m.TextPart, /Bonjour Claire/);
});

test('Mailjet : 429 puis succès (retry avec backoff) ; 400 non retenté ; sécurité sans redirection', async () => {
  const a = mj({ responses: [{ status: 429, json: {} }, { throw: true }] }); // 3e appel : succès par défaut
  await a.client.send({ templateKey: 'quote_ack', to: { email: 'x@exemple.fr' } }); assert.equal(a.calls.length, 3);
  const b = mj({ responses: [{ status: 400, json: { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'Invalid TemplateID' }] }] } }] });
  await assert.rejects(b.client.send({ templateKey: 'quote_ack', to: { email: 'x@exemple.fr' } }), e => e instanceof MailError && !e.retryable && /Invalid TemplateID/.test(e.message));
  assert.equal(b.calls.length, 1);
  const c = mj({ opts: { redirectTo: '' } });
  await assert.rejects(c.client.send({ templateKey: 'quote_ack', to: { email: 'x@exemple.fr' } }), /Envoi réel désactivé/); assert.equal(c.calls.length, 0);
  const d = mj({ env: { MJ_TPL_REVIEW: '7' } }); await d.client.send({ templateKey: 'review', to: { email: 'x@exemple.fr' } });
  assert.equal(d.calls[0].body.Messages[0].DeduplicateCampaign, true);
});

test('/api/events : validation des événements du front', () => {
  const ok = { event_type: 'quote.requested', idempotency_key: 'o123-abcdef', user: { id: 'c1', email: 'a@b.fr' }, metadata: { quote_id: 'o123', offer_id: 'posts-rs' } };
  assert.deepEqual(validateFrontEvent(ok), []);
  assert.deepEqual(validateFrontEvent({ ...ok, event_type: 'order.confirmed' }), ['__server']);
  assert.match(validateFrontEvent({ ...ok, event_type: 'pirate' }).join(), /inconnu/);
  assert.match(validateFrontEvent({ ...ok, idempotency_key: 'x' }).join(), /idempotence/);
  assert.match(validateFrontEvent({ ...ok, user: { id: 'c1', email: 'pas-un-email' } }).join(), /email/);
  assert.match(validateFrontEvent({ ...ok, metadata: { offer_id: 'x' } }).join(), /quote_id/);
});

test('/api/events : HTTP 202, doublon, 403 pour un événement serveur, 400 en français', async () => {
  const t = await setup(); const app = express(); app.use(express.json());
  app.use(eventsRouter({ getEngine: () => t.engine, log: createLogger(() => {}) }));
  const srv = app.listen(0); const url = `http://127.0.0.1:${srv.address().port}/api/events`;
  const post = b => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    const ev = { event_type: 'quote.requested', idempotency_key: 'o9-abcdefgh', user: { id: 'c1', email: 'A@B.fr', name: 'Ecoval', contact: 'Claire Dumas' }, metadata: { quote_id: 'o9', offer_id: 'posts-rs' } };
    assert.deepEqual(await post(ev), { status: 202, body: { ok: true, duplicate: false } });
    assert.deepEqual(await post(ev), { status: 202, body: { ok: true, duplicate: true } });
    assert.equal((await post({ ...ev, event_type: 'video.generated' })).status, 403);
    const bad = await post({ ...ev, user: { id: 'c1' } }); assert.equal(bad.status, 400); assert.match(bad.body.error, /Adresse email/);
    const row = (await t.db.query('SELECT * FROM events')).rows[0];
    assert.equal(row.idempotency_key, 'quote.requested:c1:o9-abcdefgh'); assert.equal(row.source, 'front');
    assert.equal((await t.db.query('SELECT email FROM clients')).rows[0].email, 'a@b.fr');
  } finally { srv.close(); await t.close(); }
});
