'use strict';
/**
 * Crée un client de test et affiche son lien d'accès à l'espace client.
 *
 * Usage :
 *   ADMIN_TOKEN=<jeton> npm run client:test -- "Nom du client" [--logo chemin/logo.png]
 *
 * --logo : logo de l'entreprise (PNG/JPG/WebP), nécessaire pour valider une commande de capsules.
 *
 * Variables facultatives :
 *   OPENSTUDIO_API  URL du back-end (défaut : https://openstudio-backend.onrender.com)
 *   OPENSTUDIO_SITE URL du site     (défaut : https://test-openstudio3.onrender.com)
 *
 * ADMIN_TOKEN : valeur de la variable du même nom du service Render « openstudio-backend »
 * (onglet Environment). Ne la mettez jamais dans un fichier versionné.
 */
const fs = require('fs');
const path = require('path');

const API = (process.env.OPENSTUDIO_API || 'https://openstudio-backend.onrender.com').replace(/\/$/, '');
const SITE = (process.env.OPENSTUDIO_SITE || 'https://test-openstudio3.onrender.com').replace(/\/$/, '');

(async () => {
  const token = (process.env.ADMIN_TOKEN || '').trim();
  if (!token) {
    console.error('ADMIN_TOKEN manquant. Exemple : ADMIN_TOKEN=<jeton> npm run client:test -- "Client test"');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const li = args.indexOf('--logo');
  const logoPath = li >= 0 ? args.splice(li, 2)[1] : null;
  if (li >= 0 && (!logoPath || !fs.existsSync(logoPath))) fail(`Logo introuvable : ${logoPath || '(chemin manquant)'}`);
  const name = args[0] || `Client test ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const company = args[1] || name;
  const admin = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Le service gratuit Render peut mettre ~1 min à se réveiller
  const data = await api('POST', '/api/admin/clients', { name, company }, admin);

  let logoKey = null;
  if (logoPath) {
    const ext = path.extname(logoPath).toLowerCase();
    const contentType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
    if (!contentType) fail('Logo : formats acceptés .png, .jpg, .jpeg, .webp');
    const up = await api('POST', '/api/uploads', { kind: 'logo', fileName: path.basename(logoPath), contentType });
    const put = await fetch(up.uploadUrl, { method: 'PUT', headers: up.headers, body: fs.readFileSync(logoPath) });
    if (!put.ok) fail(`Envoi du logo refusé par le stockage (${put.status})`);
    await api('POST', `/api/admin/clients/${data.client.id}`, { logoKey: up.key }, admin);
    logoKey = up.key;
  }

  const link = `${SITE}/?client=${encodeURIComponent(data.client.id)}&clientToken=${encodeURIComponent(data.clientToken)}`;
  console.log(`\nClient créé : ${data.client.name} (${data.client.id})`);
  console.log(`\nLien de l'espace client (à garder privé) :\n  ${link}\n`);
  if (logoKey) console.log(`Logo enregistré : ${logoKey}\n`);
  else console.log('Sans logo, la commande de capsules sera refusée à la validation : relancez avec --logo <fichier>.\n');
})().catch((e) => fail(e.message));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function api(method, route, body, headers = { 'Content-Type': 'application/json' }) {
  let res;
  try {
    res = await fetch(`${API}${route}`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch (e) {
    fail(`Back-end injoignable (${API}) : ${e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Échec ${route} (${res.status}) : ${data.error || res.statusText}${res.status === 401 ? ' — vérifiez ADMIN_TOKEN' : ''}`);
  return data;
}
