'use strict';
/**
 * État d'une diffusion pour l'équipe (rubrique « Diffusions ») et alertes « diffusion incomplète ».
 * Sans base de données : testé dans test/diffusionStatus.test.js.
 *
 * Une diffusion est complète quand sa vidéo est déposée et que le client a un e-mail (inutile si son code
 * est déjà parti pour une diffusion précédente). Le code part le jour de la diffusion à partir de 8 h
 * (admin/client-access.js) ; une diffusion incomplète déclenche une alerte à l'équipe :
 *   - avant : à J-2, avancé au vendredi si J-2 tombe un week-end (J-3 pour un lundi, J-4 pour un mardi) ;
 *   - le jour J, si elle est toujours incomplète.
 * Quand tout est en ordre, rien n'est envoyé à l'équipe.
 */

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Jour de l'alerte avant diffusion : J-2, ou le vendredi précédent si J-2 tombe un samedi ou un dimanche. */
function alertDayFor(dateDiffusion) {
  let day = addDays(dateDiffusion, -2);
  for (;;) {
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = dimanche, 6 = samedi
    if (wd !== 0 && wd !== 6) return day;
    day = addDays(day, -1);
  }
}

/** Ce qui manque à une diffusion active : ['vidéo', 'e-mail du client']. */
function missingOf(d) {
  const m = [];
  if (!d.videoId) m.push('vidéo');
  if (!d.accessSentAt && !(d.client && d.client.email)) m.push('e-mail du client');
  return m;
}

/** « vidéo manquante », « e-mail du client manquant », « vidéo et e-mail du client manquants ». */
function missingLabel(missing) {
  if (missing.length > 1) return `${missing.join(' et ')} manquants`;
  return `${missing[0]} ${missing[0] === 'vidéo' ? 'manquante' : 'manquant'}`;
}

/**
 * État affiché : { code, label, tone (ok | wait | err | info | off), missing }.
 * d : diffusion avec state, dateDiffusion, videoId, client.email, accessSentAt, accessError, accessRevokedAt.
 */
function rowStatus(d, { today, sendHour = 8 }) {
  if (d.state === 'cancelled') return { code: 'cancelled', label: 'Annulée', tone: 'off', missing: [] };
  const missing = missingOf(d);
  if (d.state === 'date_pending' || !d.dateDiffusion) {
    return { code: 'date_pending', label: 'Date à fixer dans le planning', tone: 'off', missing };
  }
  if (d.accessRevokedAt) return { code: 'revoked', label: 'Accès du client coupé', tone: 'off', missing };
  const past = d.dateDiffusion <= today;
  if (d.accessSentAt) {
    // Code déjà parti (cette diffusion ou une précédente) : seule la vidéo compte
    if (!d.videoId) return { code: 'missing', label: 'Vidéo manquante', tone: past ? 'err' : 'wait', missing };
    return past
      ? { code: 'online', label: 'Vidéo en ligne', tone: 'ok', missing }
      : { code: 'ready', label: 'Prête : vidéo en ligne le jour J', tone: 'ok', missing };
  }
  if (missing.length) {
    return past
      ? { code: 'blocked', label: `Code bloqué : ${missingLabel(missing)}`, tone: 'err', missing }
      : { code: 'missing', label: `Incomplète : ${missingLabel(missing)}`, tone: 'wait', missing };
  }
  if (d.accessError) return { code: 'failed', label: 'Échec d’envoi du code, nouvel essai prévu', tone: 'err', missing };
  if (!past) return { code: 'ready', label: `Prête : code envoyé le jour J à ${sendHour} h`, tone: 'ok', missing };
  return { code: 'sending', label: 'Envoi du code en cours', tone: 'info', missing };
}

/**
 * Alertes à envoyer maintenant. diffusions : lignes de la rubrique (avec alertBeforeOn, alertDayJOn).
 * Renvoie { before: [...], dayJ: [...] }, chaque élément avec sa liste `missing`.
 */
function planAlerts(diffusions, { today, hour, sendHour = 8 }) {
  const before = [];
  const dayJ = [];
  for (const d of diffusions) {
    if (d.state !== 'active' || !d.dateDiffusion || d.accessRevokedAt) continue;
    const missing = missingOf(d);
    if (!missing.length) continue; // tout est en ordre : rien à signaler
    if (d.dateDiffusion > today) {
      if (!d.alertBeforeOn && today >= alertDayFor(d.dateDiffusion)) before.push({ ...d, missing });
    } else if (d.dateDiffusion === today && hour >= sendHour && d.alertDayJOn !== today) {
      dayJ.push({ ...d, missing });
    }
  }
  return { before, dayJ };
}

module.exports = { addDays, alertDayFor, missingOf, missingLabel, rowStatus, planAlerts };
