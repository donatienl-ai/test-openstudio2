'use strict';
const express = require('express');
const config = require('./config');
const db = require('./db');
const worker = require('./worker');
const routes = require('./routes');
const socialRoutes = require('./routes-social');
const montageRoutes = require('./routes-montage');
const creditRoutes = require('./routes-credits');
const adminRoutes = require('./routes-admin');
const adminClientRoutes = require('./routes-admin-clients');
const clientAccess = require('./admin/client-access');
const adminSession = require('./admin/session');
const accounts = require('./admin/accounts');
const storage = require('./storage');
const clients = require('./clients');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS : uniquement le site client et le back-office de l'équipe
const allowedOrigins = [...config.frontendOrigins, ...(config.admin.origin ? [config.admin.origin] : [])];
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Order-Token,X-Client-Id,X-Client-Token,Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, env: config.appEnv, invoices: config.invoicing.provider + (config.invoicing.pennylaneMock ? ' (simulation)' : ''), dryRun: config.opus.dryRun, social: Boolean(config.social.apiKey), payment: config.stripe.mock ? 'simulation' : 'stripe', captionsAi: Boolean(config.anthropic.apiKey), liveTestClients: config.opus.liveClients.length, storageCors: storage.storageStatus.cors, storageCorsError: storage.storageStatus.corsError }));
// Identification de l'équipe (session du back-office) avant toutes les routes
app.use('/api', adminSession.attach);
app.use('/api', adminRoutes);
app.use('/api', adminClientRoutes);
app.use('/api', require('./routes-admin-diffusions'));
app.use('/api', require('./routes-admin-orders'));
app.use('/api', socialRoutes);
app.use('/api', montageRoutes);
app.use('/api', creditRoutes);
app.use('/api', routes);

app.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'Erreur interne' });
});

async function main() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.opus.apiKey && !config.opus.dryRun) missing.push('OPUSCLIP_API_KEY');
  if (!config.opus.apiKey && config.opus.liveClients.length) {
    console.error('[test réel] OPUSCLIP_LIVE_CLIENTS est renseigné mais OPUSCLIP_API_KEY est vide : les commandes de ces clients échoueront.');
  }
  if (!config.storage.bucket) missing.push('STORAGE_BUCKET');
  if (missing.length) {
    console.error(`Variables d'environnement manquantes : ${missing.join(', ')}`);
    process.exit(1);
  }
  await db.migrate();
  if (!config.admin.encryptionKey || config.admin.encryptionKey.length < 32) {
    console.error('[back-office] ADMIN_ENCRYPTION_KEY absente ou trop courte (32 caractères minimum) : l\'activation des comptes de l\'équipe est impossible.');
  }
  if (!config.admin.origin) console.error('[back-office] ADMIN_ORIGIN vide : le back-office ne pourra pas appeler l\'API (CORS).');
  if (!config.admin.require2fa) console.log('[back-office] Double authentification désactivée (ADMIN_REQUIRE_2FA) : connexion par identifiant et mot de passe.');
  if (config.admin.legacyToken) console.log('[back-office] ADMIN_TOKEN encore accepté (transition) : à retirer avant la mise en production.');
  const activationLink = await accounts.ensureBootstrap({ email: config.admin.bootstrapEmail, name: config.admin.bootstrapName });
  if (activationLink) {
    console.log(`[back-office] Lien d'activation du super admin ${config.admin.bootstrapEmail} (valable ${config.admin.inviteHours} h) : ${activationLink}`);
  }
  // Codes de connexion : chaque client a le sien, toujours le même
  clientAccess.ensureAllCodes().then((n) => { if (n) console.log(`[accès client] ${n} code(s) de connexion créé(s)`); })
    .catch((e) => console.error('[accès client] codes', e.message));
  // Crédits : offerts aux comptes qui ne les ont pas encore, puis échéances vérifiées toutes les heures
  const credits = require('./credits/service');
  credits.grantIncludedToAll().then((n) => { if (n) console.log(`[crédits] crédits offerts attribués à ${n} client(s)`); })
    .catch((e) => console.error('[crédits] attribution', e.message));
  const runExpiry = () => credits.expireAll().then((n) => { if (n) console.log(`[crédits] ${n} solde(s) arrivé(s) à échéance`); })
    .catch((e) => console.error('[crédits] échéances', e.message));
  setTimeout(runExpiry, 20000).unref();
  // Paiements : page de paiement fermée et paiement « Abandonné » après 15 minutes sans règlement
  const tracking = require('./payments/tracking');
  setInterval(() => tracking.abandonStale().then((n) => { if (n) console.log(`[paiements] ${n} paiement(s) abandonné(s)`); })
    .catch((e) => console.error('[paiements] abandons', e.message)), 60 * 1000).unref();
  setInterval(runExpiry, 60 * 60 * 1000).unref();
  // Codes d'accès des clients : envoyés le jour de la diffusion (vérification toutes les 10 minutes)
  if (!config.clientSiteUrl) console.error('[accès client] CLIENT_SITE_URL et FRONTEND_ORIGIN vides : impossible de créer les liens d\'accès des clients.');
  const mailProblem = require('./mailer').problem();
  console.log(mailProblem ? `[accès client] Envoi automatique en attente : ${mailProblem}`
    : `[accès client] Envoi automatique actif${config.mail.redirectTo ? ` (TEST : tous les e-mails partent vers ${config.mail.redirectTo})` : ''}.`);
  const runAccess = () => clientAccess.runScheduled().catch((e) => console.error('[accès client]', e.message));
  setTimeout(runAccess, 15000).unref();
  setInterval(runAccess, 10 * 60 * 1000).unref();
  // Planning de diffusion (dashboard), dossiers et vidéos Google Drive, alertes « diffusion incomplète »
  const diffusions = require('./diffusions');
  const driveSync = require('./driveSync');
  const diffusionAlerts = require('./diffusionAlerts');
  console.log(config.planning.exportUrl && config.planning.exportKey ? `[planning] lecture du planning toutes les ${config.planning.syncMinutes} min.`
    : '[planning] lecture du planning non configurée (PLANNING_EXPORT_URL, PLANNING_EXPORT_KEY).');
  console.log(driveSync.enabled() ? `[drive] dossiers et vidéos Google Drive vérifiés toutes les ${config.drive.intervalMin} min.`
    : '[drive] Google Drive non configuré (GOOGLE_SERVICE_ACCOUNT_JSON, DRIVE_ROOT_FOLDER_ID).');
  const runDiffusions = () => {
    diffusions.tick();
    driveSync.tick().catch((e) => console.error('[drive]', e.message)); // un import long ne bloque rien d'autre
    diffusionAlerts.tick().catch((e) => console.error('[alertes]', e.message));
  };
  setTimeout(runDiffusions, 25000).unref();
  setInterval(runDiffusions, 60 * 1000).unref();
  setInterval(() => accounts.purgeExpiredSessions().catch((e) => console.error('[back-office] purge des sessions', e.message)), 60 * 60 * 1000).unref();
  if (config.testClientName) {
    // Tests uniquement : espace client prêt à l'emploi, sans passer par les routes admin.
    const c = (await clients.findByName(config.testClientName))
      || (await clients.create({ name: config.testClientName, company: config.testClientName, keepPlainToken: true }));
    const site = config.frontendOrigins[0] || 'https://VOTRE-SITE';
    if (c.access_token && c.access_token_hash) {
      console.log(`[test] Lien de l'espace client « ${c.name} » : ${site}/?client=${c.id}&clientToken=${c.access_token}`);
    } else {
      console.log(`[test] Client « ${c.name} » : lien d'accès géré depuis le back-office (fiche client).`);
    }
  }
  if (config.clientUploadsEnabled) console.log('[test] Dépôt de vidéos par le client ACTIVÉ (CLIENT_UPLOADS_ENABLED) : à désactiver en production.');
  app.listen(config.port, () => {
    console.log(`OpenStudio back-end sur le port ${config.port} — webhook : ${config.publicBaseUrl}/api/webhooks/opusclip`);
    worker.start();
  });
  storage.ensureCors(allowedOrigins).then((st) => {
    if (st.corsError) console.error(`[stockage] CORS du bucket : ${st.corsError}`);
    else console.log(`[stockage] CORS du bucket : ${st.cors}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = app;
