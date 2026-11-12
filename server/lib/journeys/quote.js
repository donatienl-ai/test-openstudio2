// Parcours 3 — Devis (déclencheur : quote.requested).
// Accusé de réception immédiat (transactionnel, < 2 min) + notification interne facultative à l'équipe commerciale.
//
// stateDiagram : received -> ack_sent (fin) ; received -> ack_failed si l'accusé n'a pas pu partir.
export function registerQuoteJourney(engine, { salesEmail = '' } = {}) {
  engine.on('quote.requested', async (ctx, ev) => {
    const m = ev.metadata || {}; const u = ev.user || {};
    const vars = {
      firstname: String(u.contact || '').split(/\s+/)[0] || '', contact: u.contact || '', company: u.name || '', client_email: ev.email,
      offer: m.offer_title || '', note: m.note || '', manager: m.manager || 'votre chargée de projet', quote_id: m.quote_id
    };
    const { journey, created } = await ctx.enterJourney('quote', `${ev.user_id}:${m.quote_id}`, { userId: ev.user_id, email: ev.email, state: 'received', context: { offer_id: m.offer_id } });
    if (!created) return; // même demande déjà traitée
    await ctx.schedule(journey, { step: 'ack', template: 'quote_ack', to: ev.email, toName: u.contact, variables: vars });
    if (salesEmail) await ctx.schedule(journey, { step: 'internal', template: 'quote_internal', to: salesEmail, variables: vars });
  });

  engine.onSent('quote', async (ctx, journey, email) => {
    if (email.step === 'ack') await ctx.exitJourney(journey, 'ack_sent', 'accusé de réception envoyé', { cancel: false });
  });
  // Accusé impossible à envoyer (erreur définitive) : le parcours le signale, la notification interne part quand même.
  engine.onFailed('quote', async (ctx, journey, email) => {
    if (email.step === 'ack') await ctx.setState(journey, 'ack_failed', 'accusé de réception non envoyé');
  });
}
