// Catalogue des emails : identifiant du template Mailjet (variable d'environnement), catégorie RGPD,
// et contenu texte de secours utilisé tant que le template n'existe pas (envois de test uniquement).
// Les variables {{nom}} sont celles à reprendre dans les templates Mailjet sous la forme {{var:nom}}.
export const TEMPLATES = {
  quote_ack: {
    env: 'MJ_TPL_QUOTE_ACK', category: 'transactional',
    subject: 'Nous avons bien reçu votre demande de devis',
    text: "Bonjour {{firstname}},\n\nNous avons bien reçu votre demande de devis pour « {{offer}} ». {{manager}}, votre chargée de projet, vous recontacte rapidement.\n\nL'équipe OpenMedias"
  },
  quote_internal: {
    env: 'MJ_TPL_QUOTE_INTERNAL', category: 'internal',
    subject: 'Nouvelle demande de devis : {{company}}',
    text: "Nouvelle demande de devis reçue dans OpenStudio.\n\nEntreprise : {{company}}\nContact : {{contact}} ({{client_email}})\nOffre : {{offer}}\nPrécisions : {{note}}\nChargée de projet : {{manager}}\nRéférence : {{quote_id}}"
  },
  order_confirm: {
    env: 'MJ_TPL_ORDER_CONFIRM', category: 'transactional',
    subject: 'Votre commande est confirmée',
    text: "Bonjour {{firstname}},\n\nVotre commande « {{offer}} » est confirmée. Merci de votre confiance.\n\nL'équipe OpenMedias"
  },
  order_reminder: {
    env: 'MJ_TPL_ORDER_REMINDER', category: 'marketing',
    subject: 'Votre commande vous attend',
    text: "Bonjour {{firstname}},\n\nVotre commande « {{offer}} » n'est pas encore finalisée. Elle vous attend dans votre espace OpenStudio.\n\nL'équipe OpenMedias"
  },
  activation_1: {
    env: 'MJ_TPL_ACTIVATION_1', category: 'marketing',
    subject: 'Vos vidéos vous attendent dans OpenStudio',
    text: "Bonjour {{firstname}},\n\nDécouvrez comment transformer votre émission en capsules prêtes pour vos réseaux, et ce qu'en disent nos clients.\n\nL'équipe OpenMedias"
  },
  activation_2: {
    env: 'MJ_TPL_ACTIVATION_2', category: 'marketing',
    subject: 'Faites vivre votre passage média',
    text: "Bonjour {{firstname}},\n\nVos capsules et teasers peuvent prolonger l'impact de votre passage média sur vos réseaux.\n\nL'équipe OpenMedias"
  },
  review: {
    env: 'MJ_TPL_REVIEW', category: 'marketing', campaign: 'openstudio-avis',
    subject: 'Votre avis compte',
    text: "Bonjour {{firstname}},\n\nQue pensez-vous de vos vidéos OpenStudio ? Votre avis nous aide à progresser.\n\nL'équipe OpenMedias"
  }
};

export const templateId = (key, env = process.env) => {
  const t = TEMPLATES[key]; const v = t && Number(env[t.env]); return Number.isInteger(v) && v > 0 ? v : null;
};

export function renderFallback(key, vars = {}) {
  const t = TEMPLATES[key]; const fill = s => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] == null ? '' : String(vars[k]));
  return { subject: fill(t.subject), text: fill(t.text) };
}
