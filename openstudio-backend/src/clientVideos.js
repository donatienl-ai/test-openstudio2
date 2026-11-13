'use strict';
/**
 * Dépôt d'une vidéo par le client lui-même (mode test, CLIENT_UPLOADS_ENABLED=true).
 * En production, c'est l'équipe qui ajoute les vidéos au package (route admin).
 */
const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

/**
 * Contrôle les données envoyées par le client. Ne touche ni à la base ni au stockage.
 * @returns {{ ok: true, value: object } | { ok: false, status: number, error: string }}
 */
function validateClientVideo(body, { enabled, programmes }) {
  if (!enabled) return { ok: false, status: 403, error: 'Le dépôt de vidéos par le client est désactivé (réservé aux tests).' };
  const b = body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  const sourceKey = String(b.sourceKey || '').trim();
  if (!title) return { ok: false, status: 400, error: 'Titre de la vidéo requis.' };
  // Seuls les fichiers envoyés via /api/uploads sont acceptés (pas de chemin arbitraire dans le bucket).
  if (!/^uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/video\.[a-z0-9]+$/i.test(sourceKey)
      || !VIDEO_EXTS.some((e) => sourceKey.toLowerCase().endsWith(e))) {
    return { ok: false, status: 400, error: 'Fichier vidéo invalide : envoyez-le d’abord via le bouton de dépôt.' };
  }
  const ids = Object.keys(programmes || {});
  const programmeId = b.programmeId ? String(b.programmeId) : ids[0];
  if (!programmeId || !ids.includes(programmeId)) return { ok: false, status: 400, error: `Émission inconnue. Disponibles : ${ids.join(', ')}` };
  const broadcastDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.broadcastDate || '')) ? b.broadcastDate : null;
  return { ok: true, value: { title, sourceKey, programmeId, broadcastDate } };
}

module.exports = { validateClientVideo };
