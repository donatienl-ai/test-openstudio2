'use strict';
/**
 * Alertes à l'équipe pour les diffusions incomplètes (vidéo ou e-mail du client manquant), voir
 * src/diffusionStatus.js. Un seul e-mail récapitulatif par type d'alerte et par passage, à TEAM_ALERT_EMAIL.
 * Rien n'est envoyé quand tout est en ordre.
 */
const db = require('./db');
const config = require('./config');
const mailer = require('./mailer');
const diffusions = require('./diffusions');
const { parisParts } = require('./admin/client-access');
const { planAlerts, missingLabel } = require('./diffusionStatus');

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dayFr = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const emissionOf = (d) => [[d.media, d.sousMedia].filter(Boolean).join(' '), d.format].filter(Boolean).join(' – ');

/** Texte de l'alerte (testé dans test/diffusionStatus.test.js). */
function alertText(kind, items, { backofficeUrl = '' } = {}) {
  const subject = kind === 'dayJ'
    ? `Diffusion${items.length > 1 ? 's' : ''} du jour bloquée${items.length > 1 ? 's' : ''} : ${items.length} client${items.length > 1 ? 's' : ''} sans code d’accès`
    : `Diffusion${items.length > 1 ? 's' : ''} à venir incomplète${items.length > 1 ? 's' : ''} (${items.length})`;
  const intro = kind === 'dayJ'
    ? 'Ces clients sont diffusés aujourd’hui mais ne peuvent pas recevoir leur code d’accès. Il partira automatiquement dès que l’élément manquant sera ajouté.'
    : 'Il manque encore un élément pour que ces clients reçoivent leur code d’accès le jour de leur diffusion.';
  const lines = items.map((d) => `- ${dayFr(d.dateDiffusion)} · ${d.client.company || d.entreprise} · ${emissionOf(d)} : ${missingLabel(d.missing)}${d.missing.includes('vidéo') && d.driveUrl ? `\n  Dossier Drive : ${d.driveUrl}` : ''}`);
  const text = [intro, '', ...lines, '', backofficeUrl ? `Suivi des diffusions : ${backofficeUrl}/#diffusions` : '', '', 'OpenStudio'].filter((l, i, a) => l || a[i - 1]).join('\n');
  return { subject, text };
}

async function send(kind, items, column, today) {
  if (!items.length) return 0;
  if (!(await require('./emails/settings').isEnabled('diffusions'))) return 0; // en pause (back-office → E-mails)
  const to = await require('./admin/alerts').recipients('diffusions');
  if (!to.length) {
    console.warn(`[alertes] ${items.length} diffusion(s) incomplète(s), mais aucun destinataire (back-office → Alertes)`);
    return 0;
  }
  const { subject, text } = alertText(kind, items, { backofficeUrl: config.admin.origin });
  await mailer.send({ to: to.map((email) => ({ email })), subject, text, customId: `alerte-diffusions-${kind}-${today}` });
  await db.query(`UPDATE diffusions SET ${column} = $2 WHERE id = ANY($1::uuid[])`, [items.map((d) => d.id), today]);
  return items.length;
}

let lastRun = 0;

/** Passage toutes les 10 minutes (worker) ; une alerte n'est jamais envoyée deux fois pour la même diffusion. */
async function tick({ now = new Date(), force = false } = {}) {
  if (!force && Date.now() - lastRun < 10 * 60 * 1000) return null;
  lastRun = Date.now();
  if (mailer.problem()) return null;
  const { day: today, hour } = parisParts(now);
  try {
    const plan = planAlerts(await diffusions.list({ today }), { today, hour, sendHour: config.mail.accessSendFromHour });
    const before = await send('before', plan.before, 'alert_before_on', today);
    const dayJ = await send('dayJ', plan.dayJ, 'alert_dayj_on', today);
    if (before || dayJ) console.log(`[alertes] diffusions incomplètes signalées : ${before} à venir, ${dayJ} du jour`);
    return { before, dayJ };
  } catch (e) {
    console.error('[alertes]', e.message);
    return null;
  }
}

module.exports = { tick, alertText };
