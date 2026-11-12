// État des projets OpusClip et des tâches d'habillage.
// En mémoire pour la rapidité, et recopié en petits fichiers JSON dans le stockage pour survivre à un redémarrage.
// À terme : une vraie base de données côté serveur (clients, médias, projets, fichiers).
import { getJson, putJson } from './storage.js';
import { storageReady } from './config.js';

const mem = new Map();
const keyOf = (kind, id) => `state/${kind}/${String(id).replace(/[^\w.\-]/g, '_')}.json`;

export async function load(kind, id) {
  const k = keyOf(kind, id);
  if (mem.has(k)) return mem.get(k);
  if (!storageReady()) return null;
  const v = await getJson(k).catch(() => null);
  if (v) mem.set(k, v);
  return v;
}

export async function save(kind, id, value) {
  const k = keyOf(kind, id); const v = { ...value, updatedAt: new Date().toISOString() };
  mem.set(k, v);
  if (storageReady()) await putJson(k, v).catch(e => console.warn('[état] écriture impossible :', e.message));
  return v;
}

export async function patch(kind, id, changes) {
  const cur = (await load(kind, id)) || {};
  return save(kind, id, { ...cur, ...changes });
}
