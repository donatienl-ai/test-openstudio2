'use strict';
/** Routes « réseaux sociaux » : session obligatoire et page de retour de la fenêtre de connexion. */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.FRONTEND_ORIGIN = 'https://site.example';
const routes = require('../src/routes-social');

let base;
let server;
test.before(async () => {
  const app = express();
  app.use('/api', routes);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

test('routes client : refusées sans session', async () => {
  for (const [method, path] of [
    ['GET', '/social/accounts'],
    ['POST', '/social/connect/youtube'],
    ['GET', '/social/facebook/pages'],
    ['GET', '/social/videos/11111111-1111-4111-8111-111111111111/captions'],
    ['POST', '/social/publications'],
    ['GET', '/social/publications'],
    ['GET', '/social/performance'],
    ['POST', '/social/performance/refresh'],
  ]) {
    const r = await fetch(base + path, { method });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('retour de connexion : transmet le résultat à la page OpenStudio (seulement à son origine) puis se ferme', async () => {
  const r = await fetch(`${base}/social/connected?connect_status=error&platform=instagram&error_code=CONNECTION_FAILED`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /"connect_status":"error"/);
  assert.match(html, /"platform":"instagram"/);
  assert.match(html, /"error_code":"CONNECTION_FAILED"/);
  assert.match(html, /\["https:\/\/site\.example"\]/);
  assert.match(html, /window\.close\(\)/);
  // Valeurs inattendues ignorées (pas d'injection dans la page)
  const bad = await (await fetch(`${base}/social/connected?connect_status=%3Cscript%3E&platform=x%22y&error_code=a%3Cb`)).text();
  assert.match(bad, /"connect_status":"","platform":"","error_code":""/);
  assert.doesNotMatch(bad, /<script>alert/);
});
