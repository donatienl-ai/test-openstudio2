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

/** Légendes de secours : titre + émission, sans bloquer la publication. */
function fallbackCaptions(ctx) {
  const title = String(ctx.title || 'Notre passage TV').trim();
  const seen = ctx.programme ? `Vu sur ${ctx.programme}` : 'Notre passage TV';
  const line = `${title} — ${seen}.`;
  return enforceLimits({
    youtube: { title: clip(title, 70), description: `${line}\n\n#Shorts` },
    instagram: { caption: line },
    tiktok: { caption: line },
    linkedin: { caption: line },
    facebook: { caption: line },
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
async function generateCaptions(ctx, { client } = {}) {
  if (!config.anthropic.apiKey && !client) return { captions: fallbackCaptions(ctx), source: 'fallback', model: null, error: 'ANTHROPIC_API_KEY manquante' };
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
    return { captions: fallbackCaptions(ctx), source: 'fallback', model: null, error: e.message };
  }
}

module.exports = { PLATFORMS, limits, schema, systemPrompt, userPrompt, enforceLimits, fallbackCaptions, generateCaptions };
