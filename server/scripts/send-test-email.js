// Envoie les emails d'un parcours à l'adresse de test, sans base de données : node scripts/send-test-email.js commande
// Variables requises : MAILJET_API_KEY, MAILJET_SECRET_KEY, MAILJET_FROM_EMAIL (expéditeur validé dans Mailjet), MAIL_REDIRECT_TO.
// MAILJET_SANDBOX=1 : Mailjet valide la requête sans rien envoyer.
import { createMailjet } from '../lib/mailjet.js';
import { emailConfig } from '../lib/emails.js';

const SETS = {
  commande: ['order_reminder', 'order_confirm', 'review'],
  devis: ['quote_ack', 'quote_internal'],
  activation: ['activation_1', 'activation_2', 'review']
};
const which = process.argv[2] || 'commande';
if (!SETS[which]) { console.error(`Parcours inconnu. Choix : ${Object.keys(SETS).join(', ')}`); process.exit(1); }
const cfg = emailConfig();
if (!cfg.mailjet.redirectTo) { console.error('Renseignez MAIL_REDIRECT_TO (adresse de test).'); process.exit(1); }
const mailer = createMailjet(cfg.mailjet);
const vars = { firstname: 'Claire', contact: 'Claire Dumas', company: 'Ecoval Industrie', client_email: 'c.dumas@ecoval-industrie.fr', offer: 'Teaser vidéo de 30 à 40 secondes', option: '', price: '680 € HT', order_id: 'o-test', quote_id: 'q-test', note: 'Test', manager: 'Lola Durand' };
for (const key of SETS[which]) {
  try { const r = await mailer.send({ templateKey: key, to: { email: 'c.dumas@ecoval-industrie.fr', name: 'Claire Dumas' }, variables: vars, customId: `test-${key}-${Date.now()}` }); console.log(`${key} : envoyé (MessageID ${r.messageId}${r.sandbox ? ', mode sandbox' : ''})`); }
  catch (e) { console.error(`${key} : échec — ${e.message}`); process.exitCode = 1; }
}
