'use strict';
/**
 * TABLE DE CORRESPONDANCE : options de la plateforme → paramètres OpusClip / rendu.
 *
 *  - Les libellés affichés (« 30 s », « Carré 1:1 », « Classique », « Français »…) sont acceptés
 *    tels quels : le serveur les normalise.
 *  - Les templateId se récupèrent avec : npm run opus:templates
 *  - Les valeurs marquées « À VÉRIFIER » ne sont pas précisées dans la doc OpusClip.
 */
module.exports = {
  // ---------------------------------------------------------------------------
  // PROGRAMMES (catalogue des émissions / médias)
  // Chaque vidéo d'un client est rattachée à un programme. Les vidéos elles-mêmes dépendent
  // du package du client : l'équipe les enregistre par client (voir README, « Espace client »).
  // ---------------------------------------------------------------------------
  programmes: {
    // logoKey : logo blanc sur fond transparent, déposé dans le stockage (provisoire pour les tests ;
    // les fichiers définitifs remplaceront ces clés).
    bfm: {
      title: 'BFM TV',
      logoKey: 'uploads/2026-11-13/9f2cebeb-fb15-4ea6-b0ea-dbdb98ed6cad/logo.png', // « BFM TV »
      sourceLang: 'fr',
    },
    'bfm-business': {
      title: 'BFM Business',
      logoKey: 'uploads/2026-11-13/862b4d8d-b428-446b-bf5f-717af5fc66a5/logo.png', // « BFM Business Partenaire »
      sourceLang: 'fr',
    },
    // Anciennement « immersion » : les vidéos déjà enregistrées sont migrées au démarrage (db.migrate).
    capital: {
      title: 'Capital',
      logoKey: 'uploads/2026-11-13/bfdb2744-dba4-489c-aa7e-5b5a8268639c/logo.png',
      sourceLang: 'fr',
    },
    // Logo à fournir par l'équipe communication : en attendant, les vidéos sortent sans logo d'émission.
    'le-figaro': {
      title: 'Le Figaro',
      logoKey: null,
      sourceLang: 'fr',
    },
    // Logos des émissions : à déposer dans le back-office (rubrique « Émissions »), ils remplacent ces clés.
    time: {
      title: 'Time',
      logoKey: null,
      sourceLang: 'fr',
    },
  },

  // ---------------------------------------------------------------------------
  // CAPSULES VIDÉO (page « Capsules vidéo » → étape 2 « Réglages »)
  // ---------------------------------------------------------------------------
  capsules: {
    // « Durée de chaque capsule » : 15 s | 30 s | 45 s | 60 s
    // → curationPref.clipDurations (fourchette [min, max] en secondes, vérifiée sur un projet réel :
    //   OpusClip livre des extraits dans la fourchette demandée).
    // La durée choisie par le client est respectée À LA SECONDE : on demande des extraits au moins
    // aussi longs que la cible (cible → cible + 5 s), puis le post-traitement les coupe exactement
    // à la durée choisie, avec un court fondu sonore (pipeline.finalizeCapsules → renderFinal).
    // Fourchette large (cible → cible + 50 %) : OpusClip propose ainsi assez d'extraits pour livrer
    // 3 capsules ; une fourchette de 5 s n'en laissait parfois que 2.
    durations: {
      15: [[15, 25]],
      30: [[30, 45]],
      45: [[45, 70]],
      60: [[60, 90]],
    },
    // Extraits plus courts que la cible : acceptés seulement s'il en manque, et à moins de 1 s près.
    durationToleranceSec: 1,

    // « Format » : Vertical 9:16 | Carré 1:1 | Horizontal 16:9 → renderPref.layoutAspectRatio.
    // À VÉRIFIER : la doc cite portrait / landscape / square sans lister les valeurs exactes.
    formats: {
      '9:16': 'portrait',
      '1:1': 'square',
      '16:9': 'landscape',
    },

    // Sous-titres : un modèle unique pour toutes les capsules (pas de choix côté client) →
    // brandTemplateId. Brand template OpusClip « Chroniques » : une ligne, texte blanc Myriad,
    // sans mot mis en avant, sans majuscules, sans emoji. Liste des templates : npm run opus:templates.
    brandTemplateId: 'cmc38f93j011vbbtl9d0nt51b',

    // Sous-titres des capsules et du teaser : en option, cochée par défaut (case « Ajouter des sous-titres »
    // à l'étape « Format et durée »).
    captions: {
      default: true,
      // Garde-fous envoyés à OpusClip quand les sous-titres sont demandés : texte simple, sans mot
      // surligné, sans emoji, sans majuscules forcées (en plus du brand template, qui reste la référence
      // pour la police et la couleur blanche). Champs de renderPref présents dans le schéma de projet OpusClip.
      plain: { enableHighlight: false, enableEmoji: false, enableUppercase: false },
      // Facultatif : brand template OpusClip identique au précédent mais SANS sous-titres, utilisé quand le
      // client décoche la case (en plus de renderPref.enableCaption = false). null = même template.
      brandTemplateIdWithout: null,
    },

    maxClips: 3, // nombre de propositions livrées au client (les mieux classées par OpusClip)
    // Teaser : même traitement OpusClip, mais une seule vidéo de 15 s (la mieux classée).
    teaser: { duration: '15', maxClips: 1 },
    model: 'ClipBasic', // "ClipBasic" (talk-shows) ou "ClipAnything"
    genre: 'Auto',
    removeFillerWords: false,
  },

  // ---------------------------------------------------------------------------
  // SOUS-TITRES (page « Sous-titres » : vidéo entière)
  // Le rendu est fait par le serveur (ffmpeg) dans un style unique, pour que le résultat soit
  // identique quelle que soit l'origine de la transcription :
  //   - fichier .srt / .vtt importé par le client → aucun crédit OpusClip ;
  //   - sinon transcription automatique OpusClip (production) → crédits consommés.
  // ---------------------------------------------------------------------------
  subtitles: {
    // « Langue parlée dans la vidéo » et « Langue des sous-titres »
    languages: { fr: 'fr', en: 'en' },

    // Traduction (langue des sous-titres ≠ langue parlée) : faite par DeepL (src/translation/deepl.js),
    // active dès que DEEPL_API_KEY est renseignée sur Render (ou DEEPL_MOCK=1 pour simuler).
    get translationEnabled() {
      return require('./translation/deepl').enabled();
    },

    // « Typographie » : DM Sans Regular, texte blanc, contour noir, sans fond.
    // Déposer DMSans-Regular.ttf dans assets/fonts/.
    style: {
      fontName: 'DM Sans',
      primaryColour: '&HFFFFFF', // blanc (format ASS &HBBGGRR)
      outlineColour: '&H000000', // noir
      // Page Sous-titres, « 3. Langue et style » → « Typographie » : deux champs NUMÉRIQUES.
      //  - « Taille » : 12 à 120, défaut 30 = « taille en pixels pour une vidéo en 1080p ».
      //  - « Contour » : 0 à 60, défaut 20 = « contour en pourcentage de la taille du texte ».
      // Le formulaire envoie donc "30", "20"… : chaque valeur entière est déclarée ci-dessous.
      // Conversion vers l'ASS (libass, hauteur de référence 288 px) : 1080 / 288 = 3,75.
      //  - FontSize ASS = pixels 1080p / 3,75 (30 px → 8).
      //  - Outline ASS = pourcentage × taille ASS par défaut (8) / 100 (20 % → 1,6). Le contour ne
      //    suit pas la taille choisie : le back-end les traite séparément (rendu proche de l'aperçu
      //    pour les tailles usuelles).
      // Les anciens libellés (petite / moyenne…, fin / moyen…) restent acceptés.
      sizes: {
        petite: 16, moyenne: 20, grande: 26, s: 16, m: 20, l: 26,
        ...Object.fromEntries(Array.from({ length: 109 }, (_, i) => [String(12 + i), Math.round(((12 + i) / 3.75) * 10) / 10])),
      },
      outlines: {
        aucun: 0, fin: 1, moyen: 2, epais: 3,
        ...Object.fromEntries(Array.from({ length: 61 }, (_, i) => [String(i), Math.round(((i * 8) / 100) * 10) / 10])),
      },
      defaultSize: '30', // valeur par défaut du formulaire
      defaultOutline: '20', // valeur par défaut du formulaire
    },

    // « Découper les phrases trop longues pour une lecture confortable »
    splitting: {
      maxCharsPerLine: 42,
      maxLines: 2,
      maxCueDurationSec: 6,
    },
  },

  // ---------------------------------------------------------------------------
  // LOGOS (post-traitement ffmpeg, hors OpusClip)
  // ---------------------------------------------------------------------------
  logos: {
    widthRatio: 0.14, // largeur du logo / largeur de la vidéo
    marginRatio: 0.03,
    // Positions par défaut (modifiables client par client dans le back-office, bloc « Logos ») :
    // les deux en haut à droite, côte à côte, entreprise puis média.
    programmePosition: 'top-right',
    clientPosition: 'top-right',
    // Logos aussi sur la vidéo sous-titrée (page Sous-titres) : logo de l'entreprise obligatoire,
    // logo du média ajouté si le client indique de quel programme vient la vidéo (programmeId).
    onSubtitledVideo: true,
  },
  // Habillage des capsules et du teaser : ouverture sur le logo de l'entreprise (image floutée de la vidéo,
  // couleurs d'origine), puis fondu final vers le logo OpenMedias blanc sur le bleu nuit OpenMedias.
  bumpers: {
    enabled: true,
    kinds: ['capsules', 'teaser'],
    introSec: 2,
    outroSec: 2,
    fadeSec: 0.5,
    logoWidthRatio: 0.4, // largeur du logo centré / largeur de la vidéo
    outroColor: '#24244A', // bleu nuit OpenMedias (bandeau d'openmedias.fr)
  },
};
