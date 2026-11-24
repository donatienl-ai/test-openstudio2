'use strict';
/**
 * E-mails de test (back-office → E-mails → « M'envoyer un test ») : chaque e-mail automatique, construit
 * avec des données d'exemple, envoyé à la personne connectée. Rien n'est modifié en base.
 */
const config = require('../config');
const mailer = require('../mailer');

const DAY = 864e5;
const isoToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const isoIn = (days) => new Date(Date.now() + days * DAY).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const SAMPLE_CLIENT = { id: '00000000-0000-4000-8000-000000000000', name: 'Claire Dumas', company: 'Ecoval Industrie', email: 'claire@exemple.fr' };

async function tariff() {
  return require('../credits/settings').get().catch(() => ({ included: 1000, prices: { capsules: 300, teaser: 300, subtitlesPer5Min: 300 } }));
}

/** Données d'exemple des e-mails de la séquence (relances, avis, commande). */
async function sequenceSample(id) {
  const t = await tariff();
  const code = 'OM-7KX4-M9';
  const access = require('../admin/client-access');
  const site = config.clientSiteUrl || 'https://ADRESSE-DE-L-ESPACE-CLIENT';
  const daysLeft = { relance_video_1: 28, relance_connexion_1: 28, relance_video_2: 23, relance_connexion_2: 10, avis_video: 0 }[id];
  return {
    name: SAMPLE_CLIENT.name, code, link: access.loginUrlFor(code), programme: 'Smart Impact', media: 'BFM Business',
    credits: t.included, prices: t.prices, creditsUntil: new Date(Date.now() + (daysLeft != null ? daysLeft : 30) * DAY),
    orderUrl: `${site}/?page=offres`, reviewUrl: config.mail.googleReviewUrl,
    order: { ref: 'CMD-2026-0042', offer: 'Teaser vidéo de 30 à 40 secondes', programme: 'Smart Impact · BFM Business', amount: '816,00 € TTC', delay: 'sous 5 jours ouvrés',
      url: `${site}/?page=commandes`, invoiceUrl: `${site}/?page=factures` },
  };
}

/** Construit l'e-mail `id` avec des données d'exemple (sans destinataire). */
async function build(id) {
  switch (id) {
    case 'acces': {
      const t = await tariff();
      const code = 'OM-7KX4-M9';
      const access = require('../admin/client-access');
      return access.accessEmail({ ...SAMPLE_CLIENT, broadcast_date: isoToday() }, access.loginUrlFor(code), code, new Date(Date.now() + 30 * DAY),
        { programme: 'Smart Impact', media: 'BFM Business', credits: t.included, prices: t.prices });
    }
    case 'code_oublie': {
      const access = require('../admin/client-access');
      return access.forgotCodeEmail(SAMPLE_CLIENT, access.loginUrlFor('OM-7KX4-M9'), 'OM-7KX4-M9');
    }
    case 'recharge':
      return require('../credits/service').confirmationEmail(SAMPLE_CLIENT, { id: 'exemple', pack_label: 'Pack 3 productions', credits: 900, amount_ttc_cents: 21480 }, 1350, new Date(Date.now() + 30 * DAY));
    case 'diffusions':
      return require('../diffusionAlerts').alertText('j2', [
        { dateDiffusion: isoIn(2), client: { company: 'Ecoval Industrie' }, media: 'BFM Business', sousMedia: 'Smart Impact', format: 'Interview', missing: ['vidéo'], driveUrl: 'https://drive.google.com/' },
        { dateDiffusion: isoIn(2), client: { company: 'Nexalis' }, media: 'Capital', sousMedia: '', format: 'Portrait', missing: ['e-mail'] },
      ], { backofficeUrl: config.admin.origin });
    case 'compta':
      return require('../montage/notify').accountingEmail({
        id: SAMPLE_CLIENT.id, client_id: null, offer_title: 'Teaser vidéo de 30 à 40 secondes', amount_ht_cents: 68000, amount_ttc_cents: 81600,
        paid_at: new Date(), stripe_payment_intent: 'pi_exemple', invoice_status: 'created', invoice_number: 'F-2026-0001',
        contact: { company: 'Ecoval Industrie', name: 'Claire Dumas', email: 'claire@exemple.fr', phone: '06 12 34 56 78' },
        brief: { programme: 'BFM Business — Smart Impact', formats: ['Vertical'], deadline: isoIn(10), description: 'Un teaser de notre passage pour LinkedIn, centré sur la nouvelle usine.' },
      }, { billing: { company: 'Ecoval Industrie SAS', address: '12 rue des Lilas', postalCode: '69003', city: 'Lyon', vat: 'FR12345678901' } });
    case 'erreurs':
      return require('../orders').errorEmail({ id: SAMPLE_CLIENT.id, type: 'capsules', options: { kind: 'capsules', duration: '60' }, company: 'Ecoval Industrie' }, 'Aucun extrait OpusClip d’au moins 60 s (reçus : 41 s, 38 s)');
    case 'acces_nuit': {
      const t = await tariff();
      const code = 'OM-7KX4-M9';
      const access = require('../admin/client-access');
      return require('./accessDay').accessDayEmail({ name: SAMPLE_CLIENT.name, code, link: access.loginUrlFor(code), today: true, broadcastDay: isoToday(),
        programme: 'Smart Impact', media: 'BFM Business', credits: t.included, creditsUntil: new Date(Date.now() + 30 * DAY), prices: t.prices, dark: true });
    }
    case 'avis_video': case 'relance_video_1': case 'relance_video_2': case 'relance_connexion_1': case 'relance_connexion_2':
    case 'commande_confirmee': case 'avis_commande': {
      const seq = require('./sequence');
      const v = await sequenceSample(id);
      const fn = { avis_video: seq.avisVideo, relance_video_1: seq.relanceVideo1, relance_video_2: seq.relanceVideo2, relance_connexion_1: seq.relanceConnexion1,
        relance_connexion_2: seq.relanceConnexion2, commande_confirmee: seq.commandeConfirmee, avis_commande: seq.avisCommande }[id];
      return fn(v);
    }
    default:
      return null;
  }
}

/** Envoie l'e-mail de test `id` à `to` (même en pause). */
async function sendTest(id, to, { send = mailer.send } = {}) {
  const m = await build(id);
  if (!m) throw Object.assign(new Error('E-mail inconnu.'), { status: 404 });
  if (send === mailer.send && mailer.problem()) throw new Error(mailer.problem());
  const r = await send({ ...m, to: { email: to.email, name: to.name || undefined }, subject: `[Test] ${m.subject}`, customId: `test-${id}` });
  return { to: (r && r.redirectedTo) || to.email, subject: `[Test] ${m.subject}` };
}

module.exports = { build, sendTest, sequenceSample };
