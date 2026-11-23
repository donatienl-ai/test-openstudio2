'use strict';
/**
 * Légendes par réseau, générées en UN appel à l'API Claude (clé ANTHROPIC_API_KEY côté serveur).
 * Règles par réseau : config/caption-rules.json. En cas d'échec : légendes de secours (titre + émission).
 */
const path = require('path');
const fs = require('fs');
const config = require('../config');

const RULES_PATH = path.join(__dirname, '..', '..', 'config', 'caption-rules.json');
let rulesCache = null;
function rules() {
  if (!rulesCache) rulesCache = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  return rulesCache;
}

const PLATFORMS = ['youtube', 'instagram', 'tiktok', 'linkedin', 'facebook'];
const KIND_LABELS = { capsules: 'capsule (extrait court pour les réseaux)', teaser: 'teaser de 15 secondes', subtitles: 'interview sous-titrée (vidéo complète)' };

/** Limites de caractères par réseau et par champ (affichées dans le compteur du panneau). */
function limits() {
  const out = {};
  for (const p of PLATFORMS) {
    out[p] = {};
    for (const [field, spec] of Object.entries(rules().platforms[p].fields)) out[p][field] = spec.maxLength;
  }
  return out;
}

/** Schéma JSON imposé à la réponse (sortie structurée : JSON toujours valide). */
function schema() {
  const str = { type: 'string' };
  const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
  return obj({
    youtube: obj({ title: str, description: str }),
    instagram: obj({ caption: str }),
    tiktok: obj({ caption: str }),
    linkedin: obj({ caption: str }),
    facebook: obj({ caption: str }),
  });
}

function systemPrompt() {
  const r = rules();
  const per = PLATFORMS.map((p) => {
    const spec = r.platforms[p];
    const lim = Object.entries(spec.fields).map(([f, s]) => `${f} ≤ ${s.maxLength} caractères`).join(', ');
    return `### ${spec.label} (${p})\n${spec.rules.map((x) => `- ${x}`).join('\n')}\n- Limite : ${lim}.`;
  }).join('\n\n');
  return `Tu rédiges les textes de publication d'une vidéo sur les réseaux sociaux d'une entreprise.
La vidéo est tirée d'un passage de l'entreprise dans une émission de télévision.

Règles communes :
${r.common.map((x) => `- ${x}`).join('\n')}

Règles par réseau :

${per}

Réponds uniquement avec l'objet JSON demandé, un champ par réseau.`;
}

function userPrompt(ctx) {
  const lines = [
    `Entreprise : ${ctx.company || '(non précisée)'}`,
    `Secteur d'activité : ${ctx.sector || '(non précisé)'}`,
    `Émission : ${ctx.programme || '(non précisée)'}`,
    `Type de vidéo : ${KIND_LABELS[ctx.kind] || ctx.kind || 'vidéo'}`,
    `Titre de la vidéo : ${ctx.title || '(sans titre)'}`,
    '',
    'Transcription de la vidéo (seule source autorisée pour les faits) :',
    '<transcription>',
    (ctx.transcript || '').trim() || '(transcription indisponible : reste général et appuie-toi uniquement sur le titre et l’émission)',
    '</transcription>',
  ];
  return lines.join('\n');
}

const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
};

/** Coupe chaque texte à la limite du réseau. */
function enforceLimits(captions) {
  const lim = limits();
  const out = {};
  for (const p of PLATFORMS) {
    out[p] = {};
    for (const f of Object.keys(lim[p])) out[p][f] = clip(captions?.[p]?.[f], lim[p][f]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Textes proposés sans IA : modèles rédigés par réseau (bonnes pratiques de chacun),
// nourris par l'entreprise, l'émission, le titre et une phrase tirée de la transcription.
// ---------------------------------------------------------------------------
const GENERIC_TITLE = /^(capsule|teaser|interview|vid[ée]o|extrait|clip)\b[\s\d#:·-]*$/i;

/** « BFM Business » → « #BFMBusiness » ; « Écoval industrie » → « #EcovalIndustrie ». */
function hashtag(s) {
  const words = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const tag = words.map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1))).join('');
  return tag.length >= 3 && tag.length <= 30 ? `#${tag}` : '';
}
const tags = (...list) => [...new Set(list.filter(Boolean))].join(' ');

/** Une phrase de la transcription à citer : complète, ni trop courte ni trop longue. */
function pickQuote(transcript) {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences = text.match(/[^.!?…]+[.!?…]+/g) || [];
  const ok = sentences.map((x) => x.trim()).filter((x) => {
    const n = x.split(' ').length;
    return n >= 7 && n <= 30 && x.length <= 200 && /^[A-ZÀ-ÖØ-Þ«"]/.test(x);
  });
  return ok[0] || '';
}

/**
 * Textes proposés sans IA. `variant` (0, 1, 2…) change l'accroche à chaque « Autre proposition ».
 */
function fallbackCaptions(ctx, variant = 0) {
  const company = String(ctx.company || '').trim() || 'notre entreprise';
  const prog = String(ctx.programme || '').trim();
  const rawTitle = String(ctx.title || '').trim();
  const title = rawTitle && !GENERIC_TITLE.test(rawTitle) ? rawTitle.replace(/[.!]+$/, '') : '';
  const quote = pickQuote(ctx.transcript);
  const q = quote ? `« ${quote.replace(/^[«"]\s*|\s*[»"]$/g, '')} »` : '';
  const onAir = prog ? `sur le plateau de ${prog}` : 'à la télévision';
  const vertical = ctx.kind !== 'subtitles';
  const v = Math.abs(Number(variant) || 0);
  const pick = (arr) => arr[v % arr.length];
  const tProg = hashtag(prog);
  const tCompany = hashtag(company);
  const tSector = hashtag(ctx.sector);

  // YouTube : titre court, mot-clé en tête ; description de 2 à 3 phrases ; #Shorts si vertical
  const hasProg = prog && title.toLowerCase().includes(prog.toLowerCase());
  const ytTitle = clip(title ? (prog && !hasProg && `${title} | ${prog}`.length <= 70 ? `${title} | ${prog}` : title) : prog ? `${company} sur ${prog}` : `${company} à la télévision`, 70);
  const ytDesc = [
    q || (title ? `${title}.` : `${company} était ${onAir}.`),
    q || title ? `${company} était ${onAir}.` : 'Nous y présentons notre activité et notre savoir-faire.',
    pick(['Abonnez-vous pour suivre nos prochaines prises de parole.', 'Abonnez-vous pour ne manquer aucune de nos prochaines interventions.']),
    '',
    tags(vertical ? '#Shorts' : '', tProg, tCompany, tSector),
  ].join('\n');

  // Instagram : 1ʳᵉ ligne = accroche, texte court et rythmé, appel à l'action, 3 à 5 hashtags
  const igHook = pick([
    `📺 Nous étions ${onAir} !`,
    title ? `🎬 ${title}` : `🎬 Vu à la télé : ${company} prend la parole`,
    `Vous nous avez vus ${prog ? `sur ${prog}` : 'à la télé'} ? 👀`,
  ]);
  const ig = [
    igHook,
    '',
    q || (title ? `${title}.` : `Un moment fort pour toute l’équipe ${company}.`),
    '',
    pick(['💬 Dites-nous en commentaire ce que vous en avez pensé.', '🔁 Partagez la vidéo à ceux que ça pourrait intéresser.', '📌 Enregistrez la vidéo pour la revoir plus tard.']),
    '',
    tags(tProg, tCompany, tSector, '#VuALaTele', '#Reels'),
  ].join('\n');

  // TikTok : 1 à 2 lignes, ton direct, une question ; hashtags larges + de niche
  const tk = `${pick([
    `On était ${prog ? `sur ${prog}` : 'à la télé'} 📺`,
    title ? `${title} 🎬` : `Notre passage télé en 15 secondes 🎬`,
    `POV : votre entreprise passe ${prog ? `sur ${prog}` : 'à la télé'} 📺`,
  ])} ${pick(['Vous en pensez quoi ?', 'Ça vous parle ?', 'Vous connaissiez ?'])}\n${tags(tProg, tCompany, tSector, '#pourtoi', '#entreprise')}`;

  // LinkedIn : accroche percutante, paragraphes courts, enjeu business, question finale, 3 hashtags max
  const liHook = pick([
    `${prog ? `${prog}` : 'La télévision'} nous a ouvert son plateau. Voici ce que nous y avons défendu 👇`,
    title ? `${title}.` : `Passer à la télé, ce n’est pas une fin en soi. C’est ce qu’on y dit qui compte.`,
    `Quelques minutes d’antenne pour porter notre vision ${prog ? `sur ${prog}` : 'à la télévision'}.`,
  ]);
  const li = [
    liHook,
    '',
    q ? `${q}` : `Nous avons eu l’occasion de présenter ${company}, notre savoir-faire et ce qui nous anime au quotidien.`,
    '',
    pick([
      'Une belle reconnaissance pour le travail de toutes nos équipes, et une occasion rare de parler de notre métier à un large public.',
      'Merci à la rédaction pour l’invitation, et à nos équipes qui rendent cette histoire possible chaque jour.',
      'Ce type de prise de parole est essentiel : il rend visible un travail souvent discret, et il ouvre de nouvelles conversations.',
    ]),
    '',
    pick(['Et vous, quel regard portez-vous sur ce sujet ?', 'Qu’en pensez-vous ? Votre avis nous intéresse en commentaire.', 'Avez-vous déjà pris la parole dans les médias pour votre entreprise ?']),
    '',
    tags(tProg, tCompany, tSector || '#Entrepreneuriat').split(' ').slice(0, 3).join(' '),
  ].join('\n');

  // Facebook : ton accessible, 2 à 4 phrases, appel à l'action, 0 à 2 hashtags
  const fb = [
    pick([`C’est passé ${prog ? `sur ${prog}` : 'à la télé'} 📺`, `Vous nous avez peut-être vus ${prog ? `sur ${prog}` : 'à la télé'} 📺`]),
    q || (title ? `${title}.` : `Nous y avons présenté ${company} et notre savoir-faire.`),
    pick(['Regardez l’extrait et partagez-le autour de vous 👇', 'Découvrez l’extrait et dites-nous ce que vous en pensez en commentaire 👇']),
    tags(tProg, tCompany).split(' ').slice(0, 2).join(' '),
  ].filter(Boolean).join('\n\n');

  return enforceLimits({
    youtube: { title: ytTitle, description: ytDesc },
    instagram: { caption: ig },
    tiktok: { caption: tk },
    linkedin: { caption: li },
    facebook: { caption: fb },
  });
}

let clientInstance = null;
function anthropic() {
  if (!clientInstance) {
    const Anthropic = require('@anthropic-ai/sdk');
    clientInstance = new (Anthropic.default || Anthropic)({ apiKey: config.anthropic.apiKey });
  }
  return clientInstance;
}

/**
 * Génère les légendes. Ne lève jamais : en cas d'échec, renvoie les légendes de secours.
 * @returns {Promise<{captions: object, source: 'ai'|'fallback', model: string|null, error?: string}>}
 */
async function generateCaptions(ctx, { client, variant = 0 } = {}) {
  if (!config.anthropic.apiKey && !client) return { captions: fallbackCaptions(ctx, variant), source: 'fallback', model: null, error: 'ANTHROPIC_API_KEY manquante' };
  try {
    const response = await (client || anthropic()).beta.messages.create({
      model: config.anthropic.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // si le modèle refuse, l'API relance automatiquement sur un modèle de repli
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: schema() } },
      system: systemPrompt(),
      messages: [{ role: 'user', content: userPrompt(ctx) }],
    });
    if (response.stop_reason === 'refusal') throw new Error('génération refusée par le modèle');
    if (response.stop_reason === 'max_tokens') throw new Error('réponse tronquée');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text);
    return { captions: enforceLimits(parsed), source: 'ai', model: response.model || config.anthropic.model };
  } catch (e) {
    console.error(`[captions] échec de la génération : ${e.message}`);
    return { captions: fallbackCaptions(ctx, variant), source: 'fallback', model: null, error: e.message };
  }
}

module.exports = { PLATFORMS, hashtag, pickQuote, limits, schema, systemPrompt, userPrompt, enforceLimits, fallbackCaptions, generateCaptions };
