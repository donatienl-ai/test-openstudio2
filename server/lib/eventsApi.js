// POST /api/events : collecte des événements émis par le front (clics), avec validation et idempotence.
// Les événements serveur (video.generated, order.confirmed) ne passent jamais par cette route : le serveur les émet lui-même.
//
// Authentification : la connexion OpenStudio est encore vérifiée dans le navigateur (phase de tests internes),
// donc cette route ne peut pas prouver l'identité de l'appelant. Protections en place : CORS limité au site,
// limite de débit par IP, liste fermée d'événements, clé d'idempotence obligatoire. À renforcer dès que la
// connexion sera vérifiée côté serveur (jeton de session).
import express from 'express';
import { OFFERS } from './offers.js';

export const FRONT_EVENTS = {
  'user.login': { required: [] },
  'order.started': { required: ['order_id', 'offer_id'] },
  'quote.requested': { required: ['quote_id', 'offer_id'] }
};
export const SERVER_EVENTS = ['video.generated', 'order.confirmed'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[\w.:-]{1,120}$/;

export function validateFrontEvent(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return ['Corps de requête invalide.'];
  if (SERVER_EVENTS.includes(b.event_type)) return ['__server'];
  const spec = FRONT_EVENTS[b.event_type];
  if (!spec) errors.push("Type d'événement inconnu.");
  if (typeof b.idempotency_key !== 'string' || !/^[\w.:-]{8,200}$/.test(b.idempotency_key)) errors.push("Clé d'idempotence manquante ou invalide.");
  const u = b.user || {};
  if (!ID.test(String(u.id || ''))) errors.push('Identifiant client manquant.');
  if (!EMAIL.test(String(u.email || ''))) errors.push('Adresse email du client invalide.');
  const m = b.metadata == null ? {} : b.metadata;
  if (typeof m !== 'object' || Array.isArray(m)) errors.push('Métadonnées invalides.');
  else if (JSON.stringify(m).length > 4000) errors.push('Métadonnées trop volumineuses.');
  else if (spec) for (const k of spec.required) if (!ID.test(String(m[k] ?? ''))) errors.push(`Champ « ${k} » manquant.`);
  return errors;
}

export function eventsRouter({ getEngine, log, rateLimit = 60 }) {
  const r = express.Router(); const hits = new Map();
  const limited = req => { const ip = req.ip || 'x'; const now = Date.now(); const h = (hits.get(ip) || []).filter(t => now - t < 60000); h.push(now); hits.set(ip, h); return h.length > rateLimit; };
  r.post('/api/events', async (req, res) => {
    const engine = getEngine();
    if (!engine) return res.status(503).json({ error: "Les emails automatiques ne sont pas configurés sur le serveur." });
    if (limited(req)) return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans une minute.' });
    const b = req.body; const errors = validateFrontEvent(b);
    if (errors[0] === '__server') { log.warn('event.rejected', { event_type: b.event_type, reason: 'événement réservé au serveur' }); return res.status(403).json({ error: 'Cet événement ne peut être émis que par le serveur.' }); }
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const u = b.user; const m = b.metadata || {};
    try {
      const out = await engine.ingest({
        event_type: b.event_type, source: 'front',
        // Clé préfixée par le type et le client : deux clients ne peuvent pas entrer en collision.
        idempotency_key: `${b.event_type}:${u.id}:${b.idempotency_key}`,
        user: { id: String(u.id), email: String(u.email).trim().toLowerCase(), name: u.name ? String(u.name).slice(0, 120) : null, contact: u.contact ? String(u.contact).slice(0, 120) : null },
        // L'heure de l'événement est celle du serveur (UTC) ; l'heure du navigateur est conservée à titre indicatif.
        metadata: { ...m, client_time: typeof b.client_time === 'string' ? b.client_time.slice(0, 40) : undefined }
      });
      res.status(202).json({ ok: true, duplicate: !!out.duplicate });
    } catch (e) {
      log.error('event.ingest_error', { event_type: b.event_type, error: e.message });
      res.status(500).json({ error: "L'événement n'a pas pu être enregistré. Réessayez dans un instant." });
    }
  });
  // POST /api/orders/confirm : clic sur « Confirmer la commande ». Le serveur valide la commande
  // (offre connue, prix repris de son propre catalogue) puis émet lui-même order.confirmed.
  r.post('/api/orders/confirm', async (req, res) => {
    const engine = getEngine();
    if (!engine) return res.status(503).json({ error: "Les emails automatiques ne sont pas configurés sur le serveur." });
    if (limited(req)) return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans une minute.' });
    const b = req.body || {}; const u = b.user || {}; const offer = OFFERS[b.offer_id];
    const errors = [];
    if (!ID.test(String(b.order_id || ''))) errors.push('Référence de commande manquante.');
    if (!offer) errors.push('Offre inconnue.'); else if (offer.price == null) errors.push('Cette offre est sur devis : utilisez la demande de devis.');
    if (!ID.test(String(u.id || ''))) errors.push('Identifiant client manquant.');
    if (!EMAIL.test(String(u.email || ''))) errors.push('Adresse email du client invalide.');
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    try {
      const out = await engine.ingest({
        event_type: 'order.confirmed', source: 'server', idempotency_key: `order.confirmed:${u.id}:${b.order_id}`,
        user: { id: String(u.id), email: String(u.email).trim().toLowerCase(), name: u.name ? String(u.name).slice(0, 120) : null, contact: u.contact ? String(u.contact).slice(0, 120) : null },
        metadata: { order_id: String(b.order_id), offer_id: b.offer_id, offer_title: offer.title, price: offer.price, option: String(b.option || '').slice(0, 60), note: String(b.note || '').slice(0, 500), manager: String(b.manager || '').slice(0, 80) }
      });
      res.status(out.duplicate ? 200 : 201).json({ ok: true, duplicate: !!out.duplicate });
    } catch (e) {
      log.error('order.confirm_error', { error: e.message });
      res.status(500).json({ error: "La commande n'a pas pu être enregistrée. Réessayez dans un instant." });
    }
  });
  return r;
}
