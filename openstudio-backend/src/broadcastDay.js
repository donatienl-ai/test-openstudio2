'use strict';
/**
 * Jour de diffusion : mail au client et alertes à l'équipe.
 *
 * - Le jour J, à partir de MAIL_SEND_HOUR (8 h, heure de Paris), chaque diffusion active, datée du jour, avec sa
 *   vidéo et un e-mail, déclenche le mail au client :
 *     · premier mail du client : code de connexion + arguments + crédits valables 30 jours (la vidéo n'est pas
 *       envoyée : le client la trouve dans son espace) ;
 *     · diffusions suivantes : « votre nouvelle émission est en ligne » (même code, pas de nouveaux crédits).
 * - Une diffusion du jour incomplète (vidéo ou e-mail manquant) ne part pas : l'équipe reçoit une alerte. Si la
 *   vidéo arrive en retard, le mail part dès qu'elle est là (jusqu'à 7 jours après la date).
 * - À J-2 et J-1, l'équipe reçoit une alerte pour les diffusions encore incomplètes (une fois par diffusion).
 * - Jamais deux fois le même mail : la diffusion est réservée avant l'envoi et marquée envoyée après.
 */
const db = require('./db');
const config = require('./config');
const clients = require('./clients');
const tpl = require('./mail/templates');
const { createMailjet } = require('./mail/mailjet');

const { CATCH_UP_DAYS, parisParts, planDay } = require('./broadcastRules');

// ---------------------------------------------------------------------------
// Passage automatique
// ---------------------------------------------------------------------------
let mailer = null;
const getMailer = () => (mailer ||= createMailjet(config.mail));

async function loadDiffusions(today) {
  const { rows } = await db.query(
    `SELECT d.id, d.planning_id, d.client_id, d.state, to_char(d.date_diffusion, 'YYYY-MM-DD') AS date_diffusion,
            d.video_id, d.contact_email, d.contact_name, d.media, d.sous_media, d.format, d.entreprise,
            d.mail_sent_at, to_char(d.alert_j2_on, 'YYYY-MM-DD') AS alert_j2_on, to_char(d.alert_dayj_on, 'YYYY-MM-DD') AS alert_dayj_on,
            c.email AS client_email, c.name AS client_name,
            EXISTS (SELECT 1 FROM diffusions o WHERE o.client_id = d.client_id AND o.mail_sent_at IS NOT NULL) AS client_mailed
     FROM diffusions d JOIN clients c ON c.id = d.client_id
     WHERE d.state = 'active' AND d.mail_sent_at IS NULL
       AND d.date_diffusion BETWEEN $1::date - ${CATCH_UP_DAYS} AND $1::date + 2
     ORDER BY d.date_diffusion ASC, d.created_at ASC`,
    [today]
  );
  return rows.map((r) => ({
    id: r.id, planningId: r.planning_id, clientId: r.client_id, state: r.state, dateDiffusion: r.date_diffusion,
    videoId: r.video_id, contactEmail: r.contact_email, contactName: r.contact_name,
    media: r.media, sousMedia: r.sous_media, format: r.format, entreprise: r.entreprise || r.client_name,
    mailSentAt: r.mail_sent_at, alertJ2On: r.alert_j2_on, alertDayJOn: r.alert_dayj_on,
    clientEmail: r.client_email, clientMailed: r.client_mailed,
  }));
}

const emissionOf = (d) => [d.media, d.sousMedia].filter(Boolean).join(' ') || 'votre émission';

/** Envoie le mail d'une diffusion. Renvoie true si envoyé. */
async function sendOne(d) {
  // Réservation : un autre passage ne peut pas l'envoyer en même temps (réservation libérée après 15 min)
  const claim = await db.query(
    `UPDATE diffusions SET mail_claim_at = now() WHERE id = $1 AND mail_sent_at IS NULL
       AND (mail_claim_at IS NULL OR mail_claim_at < now() - interval '15 minutes') RETURNING id`,
    [d.id]
  );
  if (!claim.rowCount) return false;
  try {
    const vars = {
      prenom: tpl.firstName(d.contactName),
      entreprise: d.entreprise,
      nom_emission: emissionOf(d),
      lien: config.mail.siteUrl,
    };
    let creditsUntil = null;
    if (d.kind === 'first') {
      const client = await clients.get(d.clientId);
      vars.code = clients.revealCode(client) || (await clients.setNewCode(d.clientId)); // code illisible : on en donne un neuf
      creditsUntil = tpl.addDays(d.dateDiffusion > parisParts().today ? d.dateDiffusion : parisParts().today, 30);
      vars.date_expiration = tpl.dateFr(creditsUntil);
    }
    const content = d.kind === 'first' ? tpl.diffusionFirst(vars) : tpl.diffusionNext(vars);
    const sent = await getMailer().send({
      to: { email: d.to, name: d.contactName || undefined },
      templateId: d.kind === 'first' ? config.mail.templates.first : config.mail.templates.next,
      variables: vars,
      fallback: content,
      customId: `diffusion-${d.planningId}`,
    });
    await db.query(
      `UPDATE diffusions SET mail_sent_at = now(), mail_kind = $2, mail_to = $3, mail_message_id = $4, mail_error = NULL,
         mail_claim_at = NULL, updated_at = now() WHERE id = $1`,
      [d.id, d.kind, d.to, sent.messageId]
    );
    if (d.kind === 'first') {
      // Code transmis : on n'en garde plus que l'empreinte ; crédits inclus valables 30 jours
      await db.query(
        `UPDATE clients SET login_code_enc = NULL, code_sent_at = now(), credits_expire_at = $2 WHERE id = $1`,
        [d.clientId, creditsUntil]
      );
    }
    console.log(`[jour J] mail « ${d.kind === 'first' ? 'premier accès' : 'nouvelle émission'} » envoyé pour la diffusion ${d.planningId}${sent.redirected ? ' (redirigé vers l’adresse de test)' : ''}`);
    return true;
  } catch (e) {
    await db.query('UPDATE diffusions SET mail_claim_at = NULL, mail_error = $2, updated_at = now() WHERE id = $1', [d.id, String(e.message).slice(0, 500)]);
    console.error(`[jour J] mail de la diffusion ${d.planningId} : ${e.message}`);
    return false;
  }
}

async function alertTeam(items, { titre, intro, column, today }) {
  if (!items.length) return 0;
  if (!config.mail.teamEmail) {
    console.warn(`[jour J] ${titre} : ${items.length} diffusion(s), mais TEAM_ALERT_EMAIL n'est pas renseignée`);
    return 0;
  }
  const content = tpl.teamAlert({
    titre, intro,
    items: items.map((d) => ({ date: tpl.dateFr(d.dateDiffusion), entreprise: d.entreprise, emission: [emissionOf(d), d.format].filter(Boolean).join(' – '), manque: d.missing })),
  });
  try {
    await getMailer().send({ to: { email: config.mail.teamEmail }, templateId: config.mail.templates.alert, variables: { titre, intro }, fallback: content, customId: `alerte-${column}-${today}` });
    await db.query(`UPDATE diffusions SET ${column} = $2 WHERE id = ANY($1::uuid[])`, [items.map((d) => d.id), today]);
    return items.length;
  } catch (e) {
    console.error(`[jour J] alerte équipe : ${e.message}`);
    return 0;
  }
}

let running = false;
let lastRun = 0;
let lastResult = null;

async function tick({ force = false, now = new Date() } = {}) {
  if (running) return lastResult;
  if (!force && Date.now() - lastRun < 10 * 60 * 1000) return lastResult;
  running = true;
  lastRun = Date.now();
  try {
    const { today, hour } = parisParts(now);
    const plan = planDay(await loadDiffusions(today), { today, hour, sendHour: config.mail.sendHour });
    let sent = 0;
    for (const d of plan.toSend) if (await sendOne(d)) sent++;
    const alertedDayJ = await alertTeam(plan.blocked, {
      titre: 'Diffusions du jour bloquées', column: 'alert_dayj_on', today,
      intro: 'Ces clients sont diffusés aujourd’hui mais ne peuvent pas recevoir leur mail d’accès. Il part automatiquement dès que l’élément manquant est ajouté.',
    });
    const alertedJ2 = await alertTeam(plan.upcoming, {
      titre: 'Diffusions des 2 prochains jours incomplètes', column: 'alert_j2_on', today,
      intro: 'Il manque encore un élément pour que ces clients reçoivent leur accès le jour de leur diffusion.',
    });
    lastResult = { ok: true, at: new Date().toISOString(), today, hour, sent, alertedDayJ, alertedJ2 };
  } catch (e) {
    lastResult = { ok: false, at: new Date().toISOString(), error: e.message };
    console.error('[jour J]', e.message);
  } finally {
    running = false;
  }
  return lastResult;
}

module.exports = { tick, lastResult: () => lastResult };
