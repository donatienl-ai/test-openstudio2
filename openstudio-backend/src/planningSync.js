'use strict';
/**
 * Synchronisation avec le planning de diffusion (OpenPlanning, dans le dashboard).
 *
 * Le dashboard expose en lecture seule les diffusions vidéo (GET /planning/api/openstudio/diffusions,
 * clé X-OpenStudio-Key). À chaque passage :
 *  - une diffusion signée et pas encore connue crée sa ligne dans `diffusions`, et le client s'il n'existe
 *    pas encore (avec son code de connexion) ;
 *  - une diffusion connue est mise à jour : date (report), statut (annulation, réactivation), contact ;
 *  - un BDC envoyé mais pas signé (« bdc_attente ») ne crée rien.
 * Un client = un espace : les diffusions d'une même entreprise sont regroupées sur le même client
 * (nom d'entreprise normalisé, voir companyKey).
 *
 * Rien n'est envoyé au client ici : le mail du jour J est une étape séparée, qui ne part que pour une
 * diffusion active, datée, avec une vidéo et un e-mail.
 */

// Statuts du planning qui ne donnent (encore) rien côté OpenStudio
const NOT_SIGNED = ['bdc_attente'];
const CANCELLED = ['annule', 'refuse'];

/**
 * Clé de regroupement des diffusions par entreprise : minuscules, sans accents ni ponctuation,
 * sans forme juridique (« Ecoval Industrie SAS » = « ECOVAL INDUSTRIE »).
 */
function companyKey(name) {
  const legal = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sci', 'snc', 'scop', 'selarl', 'gmbh', 'ltd', 'inc']);
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !legal.has(w))
    .join(' ');
}

/** État OpenStudio d'une diffusion selon son statut dans le planning. */
function stateFor(statut) {
  if (CANCELLED.includes(statut)) return 'cancelled';
  if (statut === 'a_programmer') return 'date_pending'; // signée, date pas encore fixée
  return 'active';
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));

function fieldsFrom(d) {
  return {
    sfOpportunityId: d.sfOpportunityId || null,
    entreprise: d.entreprise,
    media: d.media,
    sousMedia: d.sousMedia || null,
    format: d.format,
    dateDiffusion: /^\d{4}-\d{2}-\d{2}/.test(String(d.dateDiffusion || '')) ? String(d.dateDiffusion).slice(0, 10) : null,
    planningStatut: d.statut,
    state: stateFor(d.statut),
    contactName: (d.contact && d.contact.nom) || null,
    contactEmail: d.contact && isEmail(d.contact.email) ? String(d.contact.email).trim().toLowerCase() : null,
    planningUpdatedAt: d.updatedAt || null,
  };
}

const CHANGE_KEYS = ['sfOpportunityId', 'entreprise', 'media', 'sousMedia', 'format', 'dateDiffusion', 'planningStatut', 'state', 'contactName', 'contactEmail'];

/**
 * Cœur de la synchronisation, sans base de données (testé dans test/planningSync.test.js).
 * @param rows   diffusions renvoyées par le planning
 * @param store  accès aux données : findDiffusion, insertDiffusion, updateDiffusion, findClientByKey,
 *               createClient, fillClientEmail
 * @returns compte rendu { created, updated, unchanged, skipped, clientsCreated, changes: [...] }
 */
async function syncDiffusions(rows, store) {
  const report = { created: 0, updated: 0, unchanged: 0, skipped: 0, clientsCreated: 0, changes: [] };
  for (const d of rows || []) {
    if (!d || !Number.isInteger(d.id) || !d.entreprise) { report.skipped++; continue; }
    const f = fieldsFrom(d);
    const existing = await store.findDiffusion(d.id);

    if (!existing) {
      // Pas encore signée, ou annulée avant d'avoir existé chez nous : rien à créer
      if (NOT_SIGNED.includes(d.statut) || f.state === 'cancelled') { report.skipped++; continue; }
      const key = companyKey(d.entreprise);
      let client = await store.findClientByKey(key);
      if (!client) {
        client = await store.createClient({ name: d.entreprise, companyKey: key, email: f.contactEmail, sector: d.secteur || null });
        report.clientsCreated++;
      } else if (f.contactEmail) {
        await store.fillClientEmail(client.id, f.contactEmail); // seulement si le client n'en a pas encore
      }
      await store.insertDiffusion({ planningId: d.id, clientId: client.id, ...f });
      report.created++;
      report.changes.push({ planningId: d.id, entreprise: d.entreprise, change: 'créée', state: f.state, date: f.dateDiffusion });
      continue;
    }

    // Une diffusion déjà connue qui repasse en « BDC en attente » garde son état actuel
    if (NOT_SIGNED.includes(d.statut)) { report.unchanged++; continue; }
    const diff = CHANGE_KEYS.filter((k) => (existing[k] ?? null) !== (f[k] ?? null));
    if (!diff.length) { report.unchanged++; continue; }
    await store.updateDiffusion(d.id, f);
    if (f.contactEmail) await store.fillClientEmail(existing.clientId, f.contactEmail);
    report.updated++;
    const change = diff.includes('state') ? (f.state === 'cancelled' ? 'annulée' : existing.state === 'cancelled' ? 'réactivée' : 'statut')
      : diff.includes('dateDiffusion') ? 'reportée' : 'mise à jour';
    report.changes.push({ planningId: d.id, entreprise: d.entreprise, change, state: f.state, date: f.dateDiffusion, before: existing.dateDiffusion || null });
  }
  return report;
}

/** Appel du dashboard. */
async function fetchPlanning({ url, key, fetchImpl = fetch }) {
  const res = await fetchImpl(url, { headers: { 'X-OpenStudio-Key': key, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`planning : HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.diffusions)) throw new Error('planning : réponse inattendue');
  return data.diffusions;
}

module.exports = { companyKey, stateFor, fieldsFrom, syncDiffusions, fetchPlanning, NOT_SIGNED, CANCELLED };
