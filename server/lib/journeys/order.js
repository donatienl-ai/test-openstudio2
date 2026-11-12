// Parcours 2 — Commande (déclencheur : order.started, un parcours par order_id).
//
//   started ──(T+2 h, 9 h-20 h Paris, pas de order.confirmed)──> « Votre commande vous attend » ──> reminded
//   started | reminded ──(order.confirmed)──> confirmation immédiate (< 2 min) + avis J+30 ──> confirmed (fin)
//   La relance en attente est annulée à la confirmation, et revérifiée au moment de l'envoi.
import { fmtPrice, OFFERS } from '../offers.js';
import { requestReview } from './review.js';
const H = 3600000, DAY = 24 * H;

const vars = ev => {
  const m = ev.metadata || {}; const u = ev.user || {}; const o = OFFERS[m.offer_id]; // intitulé et prix : catalogue serveur
  return { firstname: String(u.contact || '').split(/\s+/)[0] || '', company: u.name || '', offer: o ? o.title : '', option: m.option || '', price: fmtPrice(o ? o.price : null), order_id: m.order_id, manager: m.manager || 'votre chargée de projet' };
};
const subject = ev => `${ev.user_id}:${ev.metadata.order_id}`;

export function registerOrderJourney(engine) {
  engine.on('order.started', async (ctx, ev) => {
    const { journey, created } = await ctx.enterJourney('order', subject(ev), { userId: ev.user_id, email: ev.email, state: 'started', context: { order_id: ev.metadata.order_id, offer_id: ev.metadata.offer_id } });
    if (!created) return; // nouveau clic sur « Commander » pour la même commande
    await ctx.schedule(journey, { step: 'reminder', template: 'order_reminder', to: ev.email, toName: ev.user && ev.user.contact, variables: vars(ev), dueAt: new Date(ctx.now.getTime() + 2 * H) });
  });

  engine.on('order.confirmed', async (ctx, ev) => {
    const { journey } = await ctx.enterJourney('order', subject(ev), { userId: ev.user_id, email: ev.email, state: 'started', context: { order_id: ev.metadata.order_id, offer_id: ev.metadata.offer_id } });
    if (journey.state === 'confirmed') return;
    await ctx.cancelEmails(journey, ['reminder'], 'commande confirmée');
    await ctx.setState(journey, 'confirmed', 'order.confirmed reçu');
    await ctx.schedule(journey, { step: 'confirm', template: 'order_confirm', to: ev.email, toName: ev.user && ev.user.contact, variables: vars(ev) });
    await requestReview(ctx, { userId: ev.user_id, email: ev.email, name: ev.user && ev.user.name, contact: ev.user && ev.user.contact, dueAt: new Date(new Date(ev.occurred_at).getTime() + 30 * DAY), source: 'order', ref: ev.metadata.order_id });
  });

  // Revérification juste avant la relance : la commande a-t-elle été confirmée entre-temps ?
  engine.guard('order', async (ctx, journey, email) => {
    if (email.step !== 'reminder') return null;
    if (journey.state === 'confirmed') return 'commande confirmée';
    const r = await ctx.query(`SELECT 1 FROM events WHERE event_type='order.confirmed' AND user_id=$1 AND metadata->>'order_id'=$2 LIMIT 1`, [journey.user_id, journey.context.order_id]);
    return r.rowCount ? 'commande confirmée' : null;
  });

  engine.onSent('order', async (ctx, journey, email) => {
    if (email.step === 'reminder') await ctx.setState(journey, 'reminded', 'relance envoyée');
    if (email.step === 'confirm') await ctx.exitJourney(journey, 'confirmed', 'confirmation envoyée', { cancel: false });
  });
}
