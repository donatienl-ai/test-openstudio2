'use strict';
const express = require('express');
const config = require('./config');
const db = require('./db');
const worker = require('./worker');
const routes = require('./routes');
const socialRoutes = require('./routes-social');
const montageRoutes = require('./routes-montage');
const storage = require('./storage');
const clients = require('./clients');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS : uniquement le domaine du site statique
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.frontendOrigins.includes(origin)) {
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
  if (config.loginCodes.secret) {
    const n = await clients.ensureCodes();
    if (n) console.log(`[codes] ${n} client(s) existant(s) ont reçu un code de connexion.`);
  } else {
    console.error('[codes] LOGIN_CODE_SECRET manquant : la connexion par code (POST /api/login) est désactivée.');
  }
  if (config.testClientName) {
    // Tests uniquement : espace client prêt à l'emploi, sans passer par les routes admin.
    const c = (await clients.findByName(config.testClientName))
      || (await clients.create({ name: config.testClientName, company: config.testClientName }));
    const site = config.frontendOrigins[0] || 'https://VOTRE-SITE';
    console.log(`[test] Lien de l'espace client « ${c.name} » : ${site}/?client=${c.id}&clientToken=${c.access_token}`);
    const code = config.loginCodes.secret ? clients.revealCode(await clients.get(c.id)) : null;
    if (code) console.log(`[test] Code de connexion de « ${c.name} » : ${code}`);
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
