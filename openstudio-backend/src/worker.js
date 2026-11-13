'use strict';
/**
 * Worker de traitement (dans le même processus que l'API).
 * File d'attente portée par la base : si le service redémarre ou se met en veille,
 * le travail reprend là où il s'était arrêté.
 */
const config = require('./config');
const orders = require('./orders');
const pipeline = require('./pipeline');
const storage = require('./storage');
const db = require('./db');

let busy = false;
let timer = null;
let tick = 0;

async function step() {
  // 1. Commandes payées → soumission à OpusClip
  const toSubmit = await orders.claimNext('paid', 'submitting');
  if (toSubmit) {
    try {
      await pipeline.submit(toSubmit);
    } catch (e) {
      await orders.fail(toSubmit.id, `Soumission : ${e.message}`);
    }
    return true;
  }

  // 2. OpusClip terminé (webhook ou polling) → post-traitement et livraison
  const toFinalize = await orders.claimNext('opus_done', 'postprocessing');
  if (toFinalize) {
    try {
      await pipeline.finalize(toFinalize);
    } catch (e) {
      if (e.retry) console.log(`[worker] ${toFinalize.id} : ${e.message} — nouvel essai plus tard`);
      else await orders.fail(toFinalize.id, `Post-traitement : ${e.message}`);
    }
    return true;
  }

  // 3. Vérification de secours des projets en cours
  const toPoll = await orders.claimDuePoll(config.opus.pollIntervalSec);
  if (toPoll) {
    try {
      await pipeline.poll(toPoll);
    } catch (e) {
      console.warn(`[worker] polling ${toPoll.id} : ${e.message}`);
    }
    return true;
  }
  return false;
}

async function housekeeping() {
  await orders.recoverStuck(30);
  // Nettoyage des salts de webhook (> 1 h)
  await db.query("DELETE FROM webhook_salts WHERE received_at < now() - interval '1 hour'");
  // Purge des fichiers livrés expirés
  const { rows } = await db.query(
    'SELECT id, storage_key FROM deliverables WHERE purged = false AND expires_at < now() LIMIT 50'
  );
  for (const r of rows) {
    try {
      await storage.remove(r.storage_key);
      await db.query('UPDATE deliverables SET purged = true WHERE id = $1', [r.id]);
    } catch (e) {
      console.warn(`[purge] ${r.storage_key} : ${e.message}`);
    }
  }
}

async function loop() {
  if (busy) return;
  busy = true;
  try {
    if (tick++ % 30 === 0) await housekeeping();
    // Traite tout ce qui est prêt, une commande à la fois (limite mémoire/CPU sur Render)
    for (let i = 0; i < 20; i++) {
      if (!(await step())) break;
    }
  } catch (e) {
    console.error('[worker]', e);
  } finally {
    busy = false;
  }
}

/** Réveil immédiat (après un paiement ou un webhook) sans attendre le prochain intervalle. */
function nudge() {
  setImmediate(loop);
}

function start() {
  if (timer) return;
  timer = setInterval(loop, config.workerIntervalSec * 1000);
  nudge();
  console.log(`[worker] démarré (intervalle ${config.workerIntervalSec}s, dry run : ${config.opus.dryRun}, clients en envoi réel : ${config.opus.liveClients.length})`);
}

module.exports = { start, nudge };
