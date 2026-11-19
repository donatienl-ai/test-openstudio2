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
const social = require('./social/service');
const diffusions = require('./diffusions');
const driveSync = require('./driveSync');
const broadcastDay = require('./broadcastDay');

let busy = false;
let timer = null;
let tick = 0;
let lastPlanningSync = 0;

/** Planning de diffusion : relu toutes les PLANNING_SYNC_MIN minutes (quand le service est éveillé). */
async function planningStep() {
  if (!config.planning.exportUrl || !config.planning.exportKey) return;
  if (Date.now() - lastPlanningSync < config.planning.syncMinutes * 60 * 1000) return;
  lastPlanningSync = Date.now();
  await diffusions.runSync();
}

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

async function socialStep() {
  if (!config.social.apiKey) return;
  // Secours si la notification upload_completed n'est pas arrivée
  await social.pollPending().catch((e) => console.warn('[social] suivi :', e.message));
}

async function socialDaily() {
  if (!config.social.apiKey) return;
  // Statistiques des posts publiés : actualisées une fois par jour (quand le service est éveillé ;
  // la page « Performances » actualise aussi à l'ouverture au-delà de 24 h)
  await social.refreshStale({ limit: 10 }).catch((e) => console.warn('[social] statistiques :', e.message));
  await db.query("DELETE FROM social_deliveries WHERE received_at < now() - interval '7 days'");
}

async function housekeeping() {
  await orders.recoverStuck(30);
  await socialDaily();
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
    if (tick % 6 === 0) await socialStep();
    await planningStep();
    driveSync.tick().catch((e) => console.error('[drive]', e.message)); // sans await : un import long ne bloque pas les commandes
    broadcastDay.tick().catch((e) => console.error('[jour J]', e.message)); // mails du jour de diffusion (toutes les 10 min)
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

async function resumeInterrupted() {
  const n = await orders.recoverInterruptedFinalizations().catch(() => 0);
  if (n) console.log(`[worker] ${n} finalisation(s) interrompue(s) relancée(s)`);
}

function start() {
  if (timer) return;
  timer = setInterval(loop, config.workerIntervalSec * 1000);
  resumeInterrupted().then(nudge);
  console.log(`[worker] démarré (intervalle ${config.workerIntervalSec}s, dry run : ${config.opus.dryRun}, clients en envoi réel : ${config.opus.liveClients.length})`);
}

module.exports = { start, nudge };
