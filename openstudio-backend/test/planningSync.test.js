'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { companyKey, stateFor, syncDiffusions, fetchPlanning } = require('../src/planningSync');

// Base en mémoire, mêmes méthodes que le store de src/diffusions.js
function memoryStore() {
  const s = { diffusions: new Map(), clients: [] };
  s.findDiffusion = async (id) => (s.diffusions.has(id) ? { ...s.diffusions.get(id) } : null);
  s.insertDiffusion = async (f) => { s.diffusions.set(f.planningId, { ...f }); };
  s.updateDiffusion = async (id, f) => { s.diffusions.set(id, { ...s.diffusions.get(id), ...f }); };
  s.findClientByKey = async (key) => s.clients.find((c) => c.companyKey === key) || null;
  s.createClient = async (c) => { const x = { id: `c${s.clients.length + 1}`, ...c }; s.clients.push(x); return x; };
  s.fillClientEmail = async (id, email) => { const c = s.clients.find((x) => x.id === id); if (c && !c.email) c.email = email; };
  s.refreshed = [];
  s.refreshClient = async (id) => { s.refreshed.push(id); };
  return s;
}

const row = (o) => ({
  id: 1, entreprise: 'Ecoval Industrie', secteur: 'Recyclage', media: 'BFM Business 1&2', format: 'Plateau TV',
  dateDiffusion: '2026-12-03', statut: 'confirme', updatedAt: '2026-11-10 10:00:00',
  contact: { nom: 'Claire Dumas', email: 'Claire@Ecoval.fr', source: 'bdc', bdcSigne: true }, ...o,
});

test('entreprise normalisée : accents, casse, ponctuation et forme juridique ignorés', () => {
  assert.equal(companyKey('Ecoval Industrie SAS'), 'ecoval industrie');
  assert.equal(companyKey('  ÉCOVAL-Industrie  '), 'ecoval industrie');
  assert.equal(companyKey('Brasserie des Monts (SARL)'), 'brasserie des monts');
  assert.equal(companyKey('A&B Conseil'), 'a et b conseil');
  assert.notEqual(companyKey('Ecoval'), companyKey('Ecoval Industrie'));
});

test('états : confirmée active, à programmer en attente de date, annulée', () => {
  assert.equal(stateFor('confirme'), 'active');
  assert.equal(stateFor('a_programmer'), 'date_pending');
  assert.equal(stateFor('annule'), 'cancelled');
});

test('nouvelle diffusion signée : client créé avec l’e-mail du signataire, diffusion active', async () => {
  const s = memoryStore();
  const r = await syncDiffusions([row()], s);
  assert.equal(r.created, 1);
  assert.equal(r.clientsCreated, 1);
  assert.equal(s.clients[0].email, 'claire@ecoval.fr');
  assert.equal(s.clients[0].sector, 'Recyclage');
  assert.equal(s.clients[0].name, 'Claire Dumas'); // nom du contact, entreprise à part
  assert.equal(s.clients[0].company, 'Ecoval Industrie');
  assert.equal(s.clients[0].broadcastDate, '2026-12-03');
  assert.equal(s.clients[0].packageLabel, 'BFM Business 1&2 – Plateau TV');
  assert.deepEqual(s.refreshed, ['c1']);
  const d = s.diffusions.get(1);
  assert.equal(d.clientId, 'c1');
  assert.equal(d.state, 'active');
  assert.equal(d.dateDiffusion, '2026-12-03');
});

test('BDC pas encore signé ou diffusion déjà annulée : rien n’est créé', async () => {
  const s = memoryStore();
  const r = await syncDiffusions([row({ statut: 'bdc_attente' }), row({ id: 2, statut: 'annule' })], s);
  assert.equal(r.created, 0);
  assert.equal(r.skipped, 2);
  assert.equal(s.clients.length, 0);
});

test('un client = un espace : deux diffusions de la même entreprise sur le même client', async () => {
  const s = memoryStore();
  await syncDiffusions([row(), row({ id: 2, entreprise: 'ECOVAL INDUSTRIE SAS', format: 'Immersion', media: 'Capital' })], s);
  assert.equal(s.clients.length, 1);
  assert.equal(s.diffusions.get(2).clientId, 'c1');
});

test('report : la nouvelle date remplace l’ancienne', async () => {
  const s = memoryStore();
  await syncDiffusions([row()], s);
  const r = await syncDiffusions([row({ dateDiffusion: '2026-12-10' })], s);
  assert.equal(r.updated, 1);
  assert.equal(r.changes[0].change, 'reportée');
  assert.equal(r.changes[0].before, '2026-12-03');
  assert.equal(s.diffusions.get(1).dateDiffusion, '2026-12-10');
});

test('annulation puis réactivation', async () => {
  const s = memoryStore();
  await syncDiffusions([row()], s);
  let r = await syncDiffusions([row({ statut: 'annule' })], s);
  assert.equal(r.changes[0].change, 'annulée');
  assert.equal(s.diffusions.get(1).state, 'cancelled');
  r = await syncDiffusions([row({ statut: 'confirme' })], s);
  assert.equal(r.changes[0].change, 'réactivée');
  assert.equal(s.diffusions.get(1).state, 'active');
});

test('rien de changé : aucune écriture ; repasse en « BDC en attente » : état conservé', async () => {
  const s = memoryStore();
  await syncDiffusions([row()], s);
  assert.equal((await syncDiffusions([row()], s)).unchanged, 1);
  const r = await syncDiffusions([row({ statut: 'bdc_attente' })], s);
  assert.equal(r.unchanged, 1);
  assert.equal(s.diffusions.get(1).state, 'active');
});

test('e-mail : complété s’il manquait, jamais écrasé ; adresse invalide ignorée', async () => {
  const s = memoryStore();
  await syncDiffusions([row({ contact: null })], s);
  assert.equal(s.clients[0].email, null);
  await syncDiffusions([row({ contact: { nom: 'X', email: 'pas-un-mail' } })], s);
  assert.equal(s.clients[0].email, null);
  await syncDiffusions([row({ contact: { nom: 'Claire', email: 'claire@ecoval.fr' } })], s);
  assert.equal(s.clients[0].email, 'claire@ecoval.fr');
  await syncDiffusions([row({ id: 2, contact: { nom: 'Paul', email: 'paul@ecoval.fr' } })], s);
  assert.equal(s.clients[0].email, 'claire@ecoval.fr');
});

test('lignes incomplètes ignorées sans bloquer les autres', async () => {
  const s = memoryStore();
  const r = await syncDiffusions([null, { id: 'x', entreprise: 'A' }, row({ id: 3, entreprise: '' }), row({ id: 4 })], s);
  assert.equal(r.skipped, 3);
  assert.equal(r.created, 1);
});

test('appel du planning : clé envoyée, erreurs remontées', async () => {
  let seen;
  const ok = async (url, opts) => { seen = opts.headers['X-OpenStudio-Key']; return { ok: true, json: async () => ({ diffusions: [row()] }) }; };
  assert.equal((await fetchPlanning({ url: 'u', key: 'k', fetchImpl: ok })).length, 1);
  assert.equal(seen, 'k');
  await assert.rejects(fetchPlanning({ url: 'u', key: 'k', fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/);
  await assert.rejects(fetchPlanning({ url: 'u', key: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /inattendue/);
});
