// Erreurs renvoyées au navigateur : un code stable et un message en français, sans détail technique sensible.
export class AppError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}

export const MSG = {
  quota: "Le quota mensuel d'analyses vidéo est atteint. Les analyses reprendront le 1er du mois prochain ; prévenez l'équipe OpenMedias si c'est urgent.",
  busy: "Trop d'analyses sont en cours en ce moment. Réessayez dans quelques minutes.",
  refused: "La vidéo n'a pas pu être lue par le service d'analyse. Vérifiez qu'il s'agit d'un fichier MP4 valide, puis réessayez.",
  timeout: "Le traitement a pris plus de temps que prévu. Réessayez dans quelques minutes.",
  brand: "L'ajout de vos logos n'a pas abouti. Réessayez dans un instant ; si le problème persiste, contactez votre chargée de projet.",
  unavailable: "Le service d'analyse vidéo ne répond pas pour le moment. Réessayez dans quelques minutes.",
  storage: "Le stockage des fichiers n'est pas configuré sur le serveur.",
  opusConfig: "Le service d'analyse vidéo n'est pas configuré sur le serveur.",
  notFound: "Élément introuvable.",
  badRequest: "Requête incomplète ou invalide."
};

export function sendError(res, e) {
  if (e instanceof AppError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.resetAt ? { resetAt: e.resetAt } : {}) });
  console.error('[erreur]', e && e.message ? e.message : e);
  return res.status(500).json({ error: "Une erreur inattendue est survenue sur le serveur. Réessayez dans un instant.", code: 'server' });
}
