'use strict';
/**
 * Règles du jour de diffusion (sans base : testées dans test/broadcastDay.test.js). Utilisées par src/broadcastDay.js.
 */
const tpl = require('./mail/templates');

const CATCH_UP_DAYS = 7;
const SEND_UNTIL_HOUR = 20; // pas de mail client après 20 h : il part le lendemain matin

function parisParts(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/**
 * Destinataire : l'e-mail du client (fiche client, rempli depuis le signataire du BDC ou le contact Salesforce) ;
 * à défaut, celui du contact de la diffusion. Pas d'autre destinataire possible.
 */
const recipientOf = (d) => d.clientEmail || d.contactEmail || null;

function missingOf(d) {
  const m = [];
  if (!d.videoId) m.push('vidéo');
  if (!recipientOf(d)) m.push('e-mail du client');
  return m.join(' et ');
}

/**
 * Que faire maintenant ? diffusions = lignes avec : id, clientId, state, dateDiffusion, videoId,
 * clientEmail, contactEmail, mailSentAt, clientMailed (le client a déjà reçu un mail), alertJ2On, alertDayJOn.
 */
function planDay(diffusions, { today, hour, sendHour = 8 }) {
  const toSend = [];
  const blocked = [];
  const upcoming = [];
  const sendingClients = new Set();
  const minDay = tpl.addDays(today, -CATCH_UP_DAYS);
  const j2 = tpl.addDays(today, 2);
  const inWindow = hour >= sendHour && hour < SEND_UNTIL_HOUR;

  for (const d of diffusions) {
    if (d.state !== 'active' || !d.dateDiffusion || d.mailSentAt) continue;
    const missing = missingOf(d);
    if (d.dateDiffusion > today) {
      if (d.dateDiffusion <= j2 && missing && !d.alertJ2On) upcoming.push({ ...d, missing });
      continue;
    }
    if (d.dateDiffusion < minDay) continue; // trop ancien : plus de mail automatique
    if (missing) {
      if (d.dateDiffusion === today && d.alertDayJOn !== today && hour >= sendHour) blocked.push({ ...d, missing });
      continue;
    }
    if (!inWindow || sendingClients.has(d.clientId)) continue; // une seule diffusion par client et par passage
    sendingClients.add(d.clientId);
    toSend.push({ ...d, kind: d.clientMailed ? 'next' : 'first', to: recipientOf(d) });
  }
  return { toSend, blocked, upcoming };
}

module.exports = { CATCH_UP_DAYS, SEND_UNTIL_HOUR, parisParts, recipientOf, missingOf, planDay };
