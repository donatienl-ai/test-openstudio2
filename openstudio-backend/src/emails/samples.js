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

module.exports = { build, sendTest };
