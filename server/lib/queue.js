// File d'attente en mémoire : une tâche d'habillage à la fois, avec une limite de temps par tâche.
const waiting = []; let running = null;

export function enqueue(id, fn) {
  if (running && running.id === id) return position(id);
  if (!waiting.some(w => w.id === id)) waiting.push({ id, fn });
  setImmediate(next);
  return position(id);
}

export function position(id) {
  if (running && running.id === id) return 0;
  const i = waiting.findIndex(w => w.id === id); return i < 0 ? -1 : i + 1;
}

export const isActive = id => position(id) >= 0;

async function next() {
  if (running || !waiting.length) return;
  running = waiting.shift();
  try { await running.fn(); } catch (e) { console.warn('[file] tâche en échec :', e && e.message); }
  running = null; setImmediate(next);
}
