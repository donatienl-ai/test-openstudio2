// Parcours transverse — Avis (« votre avis », au plus tard J+30).
// Alimenté par les parcours Commande (J+30 après confirmation) et Activation (J+30 après la première vidéo).
// Règle de dédoublonnage : au plus une demande d'avis par client sur une fenêtre de N jours (REVIEW_DEDUP_DAYS, 90 par défaut).
// - une demande déjà programmée : on garde la date la plus proche (jamais au-delà de J+30 de chaque source) ;
// - une demande envoyée il y a moins de N jours : la nouvelle est ignorée.
// L'heure d'envoi est avancée (jamais retardée) pour tomber entre 9 h et 20 h, heure de Paris.
import { fitWindow } from '../timeWindow.js';
const DAY = 86400000;

export async function requestReview(ctx, { userId, email, name, contact, dueAt, source, ref }) {
  const days = ctx.cfg.reviewDedupDays || 90;
  const due = fitWindow(dueAt, ctx.cfg.window, 'backward');
  const vars = { firstname: String(contact || '').split(/\s+/)[0] || '', company: name || '', source };
  // Demande déjà programmée pour ce client : on la garde, avancée si la nouvelle échéance est plus proche.
  const pending = (await ctx.query(`SELECT e.*, j.type FROM scheduled_emails e JOIN journeys j ON j.id = e.journey_id
    WHERE j.type='review' AND j.user_id=$1 AND e.status='pending' ORDER BY e.due_at LIMIT 1`, [userId])).rows[0];
  if (pending) {
    if (due < new Date(pending.due_at)) {
      await ctx.query('UPDATE scheduled_emails SET due_at=$2, updated_at=$3 WHERE id=$1', [pending.id, due, ctx.now]);
      ctx.log.info('review.rescheduled', { user_id: userId, email_id: pending.id, due_at: due.toISOString(), source, ref });
    } else ctx.log.info('review.deduplicated', { user_id: userId, reason: 'demande déjà programmée', source, ref });
    return null;
  }
  const recent = (await ctx.query(`SELECT e.sent_at FROM scheduled_emails e JOIN journeys j ON j.id = e.journey_id
    WHERE j.type='review' AND j.user_id=$1 AND e.status='sent' AND e.sent_at > $2 LIMIT 1`, [userId, new Date(due.getTime() - days * DAY)])).rows[0];
  if (recent) { ctx.log.info('review.deduplicated', { user_id: userId, reason: `avis déjà demandé il y a moins de ${days} jours`, source, ref }); return null; }
  const { journey } = await ctx.enterJourney('review', `${userId}:${source}:${ref}`, { userId, email, state: 'scheduled', context: { source, ref } });
  return ctx.schedule(journey, { step: 'review', template: 'review', to: email, toName: contact, variables: vars, dueAt: due, latest: true });
}

export function registerReviewJourney(engine) {
  // Revérification à l'envoi : aucune autre demande d'avis envoyée entre-temps dans la fenêtre.
  engine.guard('review', async (ctx, journey, email) => {
    const days = ctx.cfg.reviewDedupDays || 90;
    const other = (await ctx.query(`SELECT 1 FROM scheduled_emails e JOIN journeys j ON j.id = e.journey_id
      WHERE j.type='review' AND j.user_id=$1 AND e.status='sent' AND e.id <> $2 AND e.sent_at > $3 LIMIT 1`, [journey.user_id, email.id, new Date(ctx.now.getTime() - days * DAY)])).rows[0];
    return other ? `avis déjà demandé il y a moins de ${days} jours` : null;
  });
  engine.onSent('review', (ctx, journey) => ctx.exitJourney(journey, 'review_sent', 'demande d’avis envoyée', { cancel: false }));
  engine.onSkip('review', (ctx, journey, email, reason) => ctx.exitJourney(journey, 'review_skipped', reason, { cancel: false }));
}
