'use strict';
const express = require('express');
const config = require('./config');
const db = require('./db');
const worker = require('./worker');
const routes = require('./routes');
const storage = require('./storage');

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

app.get('/health', (req, res) => res.json({ ok: true, dryRun: config.opus.dryRun, storageCors: storage.storageStatus.cors, storageCorsError: storage.storageStatus.corsError }));
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
  if (!config.storage.bucket) missing.push('STORAGE_BUCKET');
  if (missing.length) {
    console.error(`Variables d'environnement manquantes : ${missing.join(', ')}`);
    process.exit(1);
  }
  await db.migrate();
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
