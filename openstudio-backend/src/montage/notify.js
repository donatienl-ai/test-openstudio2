'use strict';
/**
 * E-mail à l'équipe compta quand un montage sur mesure est payé (une seule fois par demande).
 * Destinataire : ACCOUNTING_EMAIL (à défaut TEAM_ALERT_EMAIL). Mêmes garde-fous que les autres e-mails
 * (MAIL_REDIRECT_TO en test).
 */
const config = require('../config');
const db = require('../db');
const mailer = require('../mailer');

const eur = (cents) => `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const parisDate = (d) => new Date(d).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const INVOICE_TEXT = {
  created: (r) => `Facture ${r.invoice_number || ''} créée dans Pennylane et marquée payée.`.replace('  ', ' '),
  stripe: () => 'Facture Stripe générée automatiquement (visible dans le back-office, fiche du client → Paiements).',
  missing_address: () => 'Facture NON créée : adresse de facturation manquante. Elle sera créée automatiquement dès que le client l’aura renseignée.',
  error: (r) => `Facture NON créée (erreur Pennylane : ${r.invoice_error || 'inconnue'}). Nouvel essai automatique ; sinon, à créer à la main.`,
};

function accountingEmail(r, client = null, to = null) {
  const c = r.contact || {};
  const b = r.brief || {};
  const billing = (client && client.billing) || c.billing || null;
  const vat = r.amount_ttc_cents - r.amount_ht_cents;
  const lines = [
    'Bonjour,',
    '',
    `Un montage sur mesure vient d’être payé par carte sur OpenStudio.`,
    '',
    `Prestation : ${r.offer_title}`,
    `Montant : ${eur(r.amount_ht_cents)} HT + ${eur(vat)} de TVA = ${eur(r.amount_ttc_cents)} TTC`,
    `Payé le : ${parisDate(r.paid_at || new Date())}`,
    `Référence Stripe : ${r.stripe_payment_intent || r.stripe_session_id || '—'}`,
    `Demande n° : ${r.id.slice(0, 8)}`,
    '',
    'Facture :',
    (INVOICE_TEXT[r.invoice_status] || (() => 'Facture : statut inconnu, à vérifier.'))(r),
    '',
    'Client :',
    `${c.company || '—'} — ${c.name || '—'}`,
    `${c.email || '—'}${c.phone ? ` · ${c.phone}` : ''}`,
    ...(billing ? [
      `Facturation : ${billing.company || c.company || ''}`,
      `${billing.address || ''}, ${billing.postalCode || ''} ${billing.city || ''}${billing.country && billing.country !== 'France' ? `, ${billing.country}` : ''}`,
      ...(billing.vat ? [`TVA : ${billing.vat}`] : []),
      ...(billing.siret ? [`SIRET : ${billing.siret}`] : []),
      ...(billing.po ? [`Réf. de commande du client : ${billing.po}`] : []),
    ] : []),
    '',
    'Demande :',
    ...(b.programme ? [`Émission : ${b.programme}`] : []),
    ...(b.formats && b.formats.length ? [`Formats : ${b.formats.join(', ')}`] : []),
    ...(b.deadline ? [`Pour le : ${new Date(`${b.deadline}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`] : []),
    b.description || '—',
    ...(config.adminUrl && r.client_id ? ['', `Fiche du client : ${config.adminUrl}/#/clients/${r.client_id}`] : []),
    '',
    'OpenStudio',
  ];
  return {
    to: (to && to.length ? to : [config.mail.accountingEmail]).map((email) => ({ email })),
    subject: `Montage payé : ${r.offer_title} — ${c.company || c.name || 'client'} (${eur(r.amount_ttc_cents)} TTC)`,
    text: lines.join('\n'),
    customId: `compta-montage-${r.id}`,
  };
}

/** Envoie l'e-mail compta d'une demande payée (une seule fois). Ne lève jamais. */
async function notifyAccounting(requestId, { send = mailer.send } = {}) {
  try {
    const to = await require('../admin/alerts').recipients('compta');
    if (!to.length) {
      console.warn('[compta] montage payé, mais aucun destinataire (back-office → Alertes)');
      return { sent: false, reason: 'destinataire absent' };
    }
    // Réservation atomique : un seul envoi même si la notification Stripe arrive deux fois
    const { rows } = await db.query(
      "UPDATE montage_requests SET accounting_notified_at = now() WHERE id = $1 AND status = 'paid' AND accounting_notified_at IS NULL RETURNING *",
      [requestId]
    );
    const r = rows[0];
    if (!r) return { sent: false, reason: 'déjà envoyé ou non payé' };
    const client = r.client_id ? (await db.query('SELECT billing FROM clients WHERE id = $1', [r.client_id])).rows[0] : null;
    try {
      await send(accountingEmail(r, client, to));
    } catch (e) {
      await db.query('UPDATE montage_requests SET accounting_notified_at = NULL WHERE id = $1', [requestId]);
      throw e;
    }
    console.log(`[compta] e-mail envoyé pour le montage ${requestId.slice(0, 8)}`);
    return { sent: true };
  } catch (e) {
    console.error(`[compta] e-mail non envoyé (${requestId.slice(0, 8)}) : ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

/** Nouveaux essais : montages payés depuis moins de 7 jours dont l'e-mail n'est pas parti. */
async function retryAccounting(opts) {
  if (!(await require('../admin/alerts').recipients('compta')).length) return 0;
  const { rows } = await db.query(
    "SELECT id FROM montage_requests WHERE status = 'paid' AND accounting_notified_at IS NULL AND paid_at > now() - interval '7 days' ORDER BY paid_at LIMIT 10"
  );
  let n = 0;
  for (const r of rows) if ((await notifyAccounting(r.id, opts)).sent) n += 1;
  return n;
}

module.exports = { accountingEmail, notifyAccounting, retryAccounting };
