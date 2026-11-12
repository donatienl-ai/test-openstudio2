// Parcours 1 — Activation (déclencheur : première connexion, user.login avec first = true).
//
//   waiting ──(J+2, pas de vidéo)──> Relance 1 ──> relance1_sent ──(J+7, pas de vidéo)──> Relance 2 ──> completed (fin)
//   à tout moment : video.generated ──> converted (relances restantes annulées) + demande d'avis à J+30 de la 1re vidéo
//   Les relances partent entre 9 h et 20 h (Paris) et sont revérifiées juste avant l'envoi.
import { requestReview } from './review.js';
const DAY = 86400000;

export function registerActivationJourney(engine) {
  engine.on('user.login', async (ctx, ev) => {
    if (!(ev.metadata && ev.metadata.first === true)) return; // reconnexion : pas de parcours
    const prior = (await ctx.query(`SELECT 1 FROM events WHERE user_id=$1 AND event_type='user.login' AND id <> $2 LIMIT 1`, [ev.user_id, ev.id])).rowCount;
    if (prior) { ctx.log.info('journey.not_entered', { journey: 'activation', user_id: ev.user_id, reason: 'connexion déjà enregistrée' }); return; }
    if (await ctx.countEvents(ev.user_id, 'video.generated', new Date(0))) return; // déjà actif
    const { journey, created } = await ctx.enterJourney('activation', ev.user_id, { userId: ev.user_id, email: ev.email, state: 'waiting' });
    if (!created) return;
    const u = ev.user || {}; const vars = { firstname: String(u.contact || '').split(/\s+/)[0] || '', company: u.name || '' };
    const t0 = new Date(ev.occurred_at).getTime();
    await ctx.schedule(journey, { step: 'relance1', template: 'activation_1', to: ev.email, toName: u.contact, variables: vars, dueAt: new Date(t0 + 2 * DAY) });
    await ctx.schedule(journey, { step: 'relance2', template: 'activation_2', to: ev.email, toName: u.contact, variables: vars, dueAt: new Date(t0 + 7 * DAY) });
  });

  engine.on('video.generated', async (ctx, ev) => {
    // Sortie anticipée du parcours d'activation.
    const j = (await ctx.query(`SELECT * FROM journeys WHERE type='activation' AND user_id=$1 AND exited_at IS NULL`, [ev.user_id])).rows[0];
    if (j) await ctx.exitJourney(j, 'converted', 'vidéo générée');
    // Première vidéo du client : demande d'avis au plus tard 30 jours après.
    const n = await ctx.countEvents(ev.user_id, 'video.generated', new Date(0));
    if (n === 1) {
      const u = ev.user || {};
      await requestReview(ctx, { userId: ev.user_id, email: ev.email, name: u.name, contact: u.contact, dueAt: new Date(new Date(ev.occurred_at).getTime() + 30 * DAY), source: 'video', ref: ev.metadata.video_id });
    }
  });

  // Revérification juste avant chaque relance : une vidéo a-t-elle été générée depuis l'entrée ?
  engine.guard('activation', async (ctx, journey) => {
    if (journey.exited_at) return 'parcours terminé';
    return (await ctx.countEvents(journey.user_id, 'video.generated', journey.entered_at)) ? 'vidéo générée' : null;
  });
  engine.onSkip('activation', async (ctx, journey, email, reason) => {
    if (reason === 'vidéo générée' && !journey.exited_at) await ctx.exitJourney(journey, 'converted', reason);
  });
  engine.onSent('activation', async (ctx, journey, email) => {
    if (email.step === 'relance1') await ctx.setState(journey, 'relance1_sent', 'relance 1 envoyée');
    if (email.step === 'relance2') await ctx.exitJourney(journey, 'completed', 'relance 2 envoyée', { cancel: false });
  });
}

// Événement serveur « vidéo générée » : premier téléchargement d'une vidéo habillée (lien du fichier final remis).
export function videoGeneratedEvent(job, now = new Date()) {
  const c = job && job.client; if (!c || !c.id || !c.email || job.status !== 'done') return null;
  return {
    event_type: 'video.generated', source: 'server', idempotency_key: `video.generated:${c.id}:${job.jobId}`, occurred_at: now,
    user: { id: String(c.id), email: String(c.email).toLowerCase(), name: c.name || null, contact: c.contact || null },
    metadata: { video_id: job.jobId, project_id: job.spec && job.spec.projectId, clip_id: job.spec && job.spec.clipId, fmt: job.spec && job.spec.fmt, file_name: job.fileName }
  };
}
