'use strict';
const express = require('express');
const config = require('./config');
const db = require('./db');
const worker = require('./worker');
const routes = require('./routes');
const socialRoutes = require('./routes-social');
const montageRoutes = require('./routes-montage');
const adminRoutes = require('./routes-admin');
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

app.get('/health', (req, res) => res.json({ ok: true, dryRun: config.opus.dryRun, social: Boolean(config.social.apiKey), payment: config.stripe.mock ? 'simulation' : 'stripe', captionsAi: Boolean(config.anthropic.apiKey), liveTestClients: config.opus.liveClients.length, storageCors: storage.storageStatus.cors, storageCorsError: storage.storageStatus.corsError }));
// Identification de l'équipe (session du back-office) avant toutes les routes
app.use('/api', adminSession.attach);
app.use('/api', adminRoutes);
app.use('/api', socialRoutes);
app.use('/api', montageRoutes);
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
  setInterval(() => accounts.purgeExpiredSessions().catch((e) => console.error('[back-office] purge des sessions', e.message)), 60 * 60 * 1000).unref();
  if (config.testClientName) {
    // Tests uniquement : espace client prêt à l'emploi, sans passer par les routes admin.
    const c = (await clients.findByName(config.testClientName))
      || (await clients.create({ name: config.testClientName, company: config.testClientName }));
    const site = config.frontendOrigins[0] || 'https://VOTRE-SITE';
    console.log(`[test] Lien de l'espace client « ${c.name} » : ${site}/?client=${c.id}&clientToken=${c.access_token}`);
  }
  if (config.clientUploadsEnabled) console.log('[test] Dépôt de vidéos par le client ACTIVÉ (CLIENT_UPLOADS_ENABLED) : à désactiver en production.');
  app.listen(config.port, () => {
    console.log(`OpenStudio back-end sur le port ${config.port} — webhook : ${config.publicBaseUrl}/api/webhooks/opusclip`);
    worker.start();
  });
  storage.ensureCors(config.frontendOrigins).then((st) => {
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
