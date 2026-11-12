// Affiche les modèles de marque (Brand Templates) du compte OpusClip : node scripts/list-templates.js
// Lit OPUSCLIP_API_KEY dans l'environnement. La clé n'est jamais affichée.
const key = (process.env.OPUSCLIP_API_KEY || '').trim();
if (!key) { console.error('Renseignez OPUSCLIP_API_KEY dans l\'environnement (Render > Shell, ou fichier .env chargé).'); process.exit(1); }
const base = (process.env.OPUSCLIP_API_BASE || 'https://api.opus.pro/api').replace(/\/$/, '');
const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
if (process.env.OPUSCLIP_ORG_ID) headers['x-opus-org-id'] = process.env.OPUSCLIP_ORG_ID;

const r = await fetch(`${base}/brand-templates?q=mine`, { headers });
if (!r.ok) { console.error(`Échec de la lecture des modèles : HTTP ${r.status}`); process.exit(1); }
const data = await r.json(); const list = Array.isArray(data) ? data : (data && data.data) || [];
if (!list.length) { console.log('Aucun modèle sur ce compte. Créez-les dans le tableau de bord OpusClip (Brand templates).'); process.exit(0); }
console.log(`${list.length} modèle(s) :\n`);
for (const t of list) {
  const rp = t.renderPref || t.preferences || {};
  console.log(`- ${t.name || '(sans nom)'}\n    templateId : ${t.templateId || t.id}\n    format     : ${rp.layoutAspectRatio || 'non précisé'}\n    logo/filigrane : ${rp.enableWatermark ? 'OUI (à retirer)' : 'non'}\n`);
}
console.log('Reportez les identifiants dans OPUS_TPL_IMPACT, OPUS_TPL_CLASSIQUE et OPUS_TPL_MINIMAL.');
