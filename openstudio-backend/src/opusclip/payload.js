'use strict';
/**
 * Validation des options de commande et construction des requêtes OpusClip.
 * Fonctions PURES (aucun appel réseau ni base) → testées dans test/payload.test.js.
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const VIDEO_TYPES = new Set(['capsules', 'subtitles']);
const NON_VIDEO_TYPES = new Set(['visuels', 'publications', 'photo']);

function req(value, message) {
  if (value === undefined || value === null || value === '') throw new ValidationError(message);
  return value;
}

// --- Normalisation des libellés affichés -------------------------------------
/** Retire accents, espaces superflus et casse : « Épais » → « epais ». */
function normalizeLabel(v) {
  return String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}
/** « 30 s », "30", 30 → "30" */
function normalizeDuration(v) {
  return String(v).replace(/[^0-9]/g, '');
}
/** « Vertical 9:16 », "vertical", "9/16" → "9:16" */
function normalizeFormat(v) {
  const s = normalizeLabel(v);
  if (/9\s*[:/x]\s*16|vertical/.test(s)) return '9:16';
  if (/1\s*[:/x]\s*1|carre/.test(s)) return '1:1';
  if (/16\s*[:/x]\s*9|horizontal/.test(s)) return '16:9';
  return String(v).trim();
}
/** « Français », "FR" → "fr" ; « Anglais », "EN", "English" → "en" */
function normalizeLanguage(v) {
  const s = normalizeLabel(v);
  if (s.startsWith('fr')) return 'fr';
  if (s.startsWith('en') || s.startsWith('an')) return 'en';
  return s;
}
/** Valeur telle quelle si c'est une clé de la table, sinon version normalisée. */
function pick(table, raw, normalize) {
  const s = String(raw);
  return Object.prototype.hasOwnProperty.call(table, s) ? s : normalize(s);
}
function toBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'oui', 'on', 'yes'].includes(String(v).toLowerCase());
}

/**
 * Valide les options d'une commande et renvoie une version normalisée.
 *
 * capsules  : { videoId, duration, format, subtitleStyle, clientLogoKey? }
 *             context.video = vidéo du package du client (déjà vérifiée : elle lui appartient)
 * subtitles : { videoKey, transcriptKey?, spokenLanguage, subtitleLanguage, splitLongLines,
 *               size, outline, offsetMs? }
 */
function normalizeOptions(type, options, mapping, context = {}) {
  if (!options || typeof options !== 'object') throw new ValidationError('Options de commande manquantes');

  if (type === 'capsules') {
    req(options.videoId, 'Aucune vidéo sélectionnée');
    const video = context.video;
    if (!video) throw new ValidationError('Cette vidéo ne fait pas partie de votre espace');
    const programme = mapping.programmes[video.programme_id];
    if (!programme) throw new ValidationError(`Programme non configuré : ${video.programme_id}`);

    const duration = pick(mapping.capsules.durations, req(options.duration, 'Durée de capsule non sélectionnée'), normalizeDuration);
    if (!mapping.capsules.durations[duration]) throw new ValidationError(`Durée non proposée : ${options.duration}`);
    const format = pick(mapping.capsules.formats, req(options.format, 'Format non sélectionné'), normalizeFormat);
    if (!mapping.capsules.formats[format]) throw new ValidationError(`Format non proposé : ${options.format}`);
    const subtitleStyle = pick(mapping.capsules.subtitleStyles, req(options.subtitleStyle, 'Style de sous-titres non sélectionné'), normalizeLabel);
    if (!mapping.capsules.subtitleStyles[subtitleStyle]) {
      throw new ValidationError(`Aucun template OpusClip pour le style : ${options.subtitleStyle}`);
    }
    return {
      videoId: video.id,
      videoTitle: video.title,
      programmeId: video.programme_id,
      sourceKey: video.source_key,
      duration,
      format,
      subtitleStyle,
      clientLogoKey: options.clientLogoKey || null,
    };
  }

  if (type === 'subtitles') {
    const conf = mapping.subtitles;
    const videoKey = req(options.videoKey, 'Aucune vidéo ajoutée');
    const spokenLanguage = pick(conf.languages, req(options.spokenLanguage, 'Langue parlée non sélectionnée'), normalizeLanguage);
    if (!conf.languages[spokenLanguage]) throw new ValidationError(`Langue parlée non proposée : ${options.spokenLanguage}`);
    const subtitleLanguage = pick(conf.languages, options.subtitleLanguage || spokenLanguage, normalizeLanguage);
    if (!conf.languages[subtitleLanguage]) throw new ValidationError(`Langue de sous-titres non proposée : ${options.subtitleLanguage}`);
    const transcriptKey = options.transcriptKey || null;

    if (subtitleLanguage !== spokenLanguage) {
      if (!conf.translationEnabled) {
        throw new ValidationError('La traduction des sous-titres n’est pas encore disponible : choisissez la langue parlée dans la vidéo');
      }
    }

    const size = pick(conf.style.sizes, options.size || conf.style.defaultSize, normalizeLabel);
    if (conf.style.sizes[size] === undefined) throw new ValidationError(`Taille non proposée : ${options.size}`);
    const outline = pick(conf.style.outlines, options.outline || conf.style.defaultOutline, normalizeLabel);
    if (conf.style.outlines[outline] === undefined) throw new ValidationError(`Contour non proposé : ${options.outline}`);

    const offsetMs = Number(options.offsetMs || 0);
    if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 600_000) throw new ValidationError('Décalage de synchronisation invalide');

    // Programme d'origine de la vidéo (facultatif) → logo du média sur la vidéo sous-titrée
    const programmeId = options.programmeId || null;
    if (programmeId && !mapping.programmes[programmeId]) throw new ValidationError(`Programme inconnu : ${programmeId}`);

    return {
      programmeId,
      videoKey,
      transcriptKey,
      spokenLanguage,
      subtitleLanguage,
      splitLongLines: toBool(options.splitLongLines, true),
      size,
      outline,
      offsetMs,
      // client_file : .srt/.vtt fourni → rendu local, aucun crédit ; opus_transcript : transcription OpusClip
      mode: transcriptKey ? 'client_file' : 'opus_transcript',
      clientLogoKey: options.clientLogoKey || null,
    };
  }

  // Visuels (photos) et Publications (textes) : aucune vidéo, jamais d'OpusClip.
  if (NON_VIDEO_TYPES.has(type)) return { ...options };
  throw new ValidationError(`Type de commande inconnu : ${type}`);
}

/**
 * Corps de POST /api/clip-projects.
 * @param {object} order       { id, type, options (normalisées) }
 * @param {string} videoRef    URL publique MP4 ou uploadId renvoyé par upload-links
 * @param {object} mapping     opusclip.config
 * @param {string} webhookUrl  URL publique de notre webhook
 */
function buildProjectPayload(order, videoRef, mapping, webhookUrl) {
  const o = order.options;
  const conclusionActions = [{ type: 'WEBHOOK', url: webhookUrl, notifyFailure: true }];

  if (order.type === 'capsules') {
    const programme = mapping.programmes[o.programmeId];
    const lang = programme.sourceLang || 'auto';
    return {
      videoUrl: videoRef,
      uploadedVideoAttr: {
        title: `${programme.title}${o.videoTitle ? ` — ${o.videoTitle}` : ''} — commande ${shortId(order.id)}`,
      },
      brandTemplateId: mapping.capsules.subtitleStyles[o.subtitleStyle],
      curationPref: {
        model: mapping.capsules.model,
        clipDurations: mapping.capsules.durations[o.duration],
        genre: mapping.capsules.genre,
        skipCurate: false,
      },
      renderPref: {
        layoutAspectRatio: mapping.capsules.formats[o.format],
        ...(mapping.capsules.removeFillerWords ? { quickstartConfig: { enableRemoveFillerWords: true } } : {}),
      },
      // La doc emploie tantôt "importPref", tantôt "importPreference" : on envoie les deux.
      importPref: { sourceLang: lang },
      importPreference: { sourceLang: lang },
      conclusionActions,
    };
  }

  if (order.type === 'subtitles') {
    if (o.mode !== 'opus_transcript') {
      throw new ValidationError('Transcription fournie par le client : traitement local, sans projet OpusClip');
    }
    const lang = mapping.subtitles.languages[o.spokenLanguage];
    // Projet sans découpage : on n'utilise que la transcription (le rendu est fait par nos soins).
    return {
      videoUrl: videoRef,
      uploadedVideoAttr: { title: `Sous-titres — commande ${shortId(order.id)}` },
      curationPref: { skipCurate: true },
      importPref: { sourceLang: lang },
      importPreference: { sourceLang: lang },
      conclusionActions,
    };
  }

  throw new ValidationError(`Pas de projet OpusClip pour le type ${order.type}`);
}

/**
 * Interprète la réponse de GET /api/clip-projects/{id}.
 * La doc ne détaille pas les champs de statut : on cherche des valeurs connues dans les champs usuels.
 * @returns {'done'|'failed'|'running'|'unknown'}
 */
function interpretProjectStatus(project) {
  if (!project || typeof project !== 'object') return 'unknown';
  const p = project.data && typeof project.data === 'object' ? project.data : project;
  const candidates = [p.status, p.stage, p.state, p.projectStatus, p.processStatus]
    .filter((v) => typeof v === 'string')
    .map((v) => v.toUpperCase());
  if (candidates.some((v) => /FAIL|ERROR|CANCEL/.test(v))) return 'failed';
  if (candidates.some((v) => /COMPLETE|DONE|FINISH|SUCCE|READY|PUBLISHED/.test(v))) return 'done';
  if (candidates.length) return 'running';
  return 'unknown';
}

/** Extrait l'identifiant de projet d'un corps de webhook (format non documenté → tolérant). */
function extractProjectId(body) {
  if (!body || typeof body !== 'object') return null;
  return body.projectId || body.project_id || body.data?.projectId || body.data?.id || body.project?.id || body.id || null;
}

/** Estimation des crédits consommés (configurable : crédits par minute de vidéo source). */
function estimateCredits(durationSec, creditsPerMinute) {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.ceil(durationSec / 60) * creditsPerMinute;
}

function shortId(id) {
  return String(id).slice(0, 8);
}

module.exports = {
  ValidationError,
  VIDEO_TYPES,
  NON_VIDEO_TYPES,
  normalizeOptions,
  normalizeFormat,
  normalizeDuration,
  normalizeLabel,
  normalizeLanguage,
  buildProjectPayload,
  interpretProjectStatus,
  extractProjectId,
  estimateCredits,
  shortId,
};
