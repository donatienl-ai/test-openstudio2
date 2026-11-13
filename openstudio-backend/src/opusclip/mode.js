'use strict';
/**
 * Envoi réel ou dry run, commande par commande.
 *
 * - OPUSCLIP_DRY_RUN=false : toutes les commandes partent chez OpusClip.
 * - OPUSCLIP_DRY_RUN=true (défaut) : rien ne part, SAUF les commandes des clients listés dans
 *   OPUSCLIP_LIVE_CLIENTS (identifiants séparés par des virgules). Sert à tester le parcours complet
 *   avec un client de test sans exposer les autres. Ces envois réels sont limités aux vidéos de
 *   OPUSCLIP_LIVE_MAX_MINUTES minutes au plus (défaut 10) pour borner la consommation de crédits.
 */

/** @returns {boolean} true si la commande doit réellement être envoyée à OpusClip */
function isLiveOrder(order, opus) {
  if (!opus.dryRun) return true;
  return Boolean(order && order.client_id && opus.liveClients.includes(String(order.client_id)));
}

/**
 * Garde-fous d'un envoi réel en mode test ciblé. Renvoie un message d'erreur, ou null si l'envoi est permis.
 * @param {number|null} durationSec  durée de la vidéo source (null = inconnue)
 */
function liveTestGuard(durationSec, opus) {
  if (!opus.apiKey) return 'OPUSCLIP_API_KEY manquante : envoi réel impossible';
  if (!opus.dryRun) return null; // production : pas de limite de durée ici (budget de crédits seulement)
  if (!durationSec) return 'Durée de la vidéo inconnue : envoi réel de test refusé';
  if (durationSec > opus.liveMaxMinutes * 60) {
    return `Vidéo trop longue pour un envoi réel de test (${Math.ceil(durationSec / 60)} min, maximum ${opus.liveMaxMinutes} min)`;
  }
  return null;
}

module.exports = { isLiveOrder, liveTestGuard };
