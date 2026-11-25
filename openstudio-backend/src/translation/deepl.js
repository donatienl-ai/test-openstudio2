'use strict';
/**
 * Traduction par DeepL (API v2 /translate). Référence : https://developers.deepl.com/api-reference/translate
 * - Clé dans DEEPL_API_KEY (Render) ; les clés gratuites finissent par « :fx » → api-free.deepl.com.
 * - Plusieurs textes par appel (≤ 50 ici, < 128 Kio) ; le « contexte » (non facturé) améliore la traduction.
 * - 429 / 5xx : nouvel essai ; 456 : quota épuisé (pas de nouvel essai) ; 400 : requête invalide.
 * - DEEPL_MOCK=1 : simulation sans appel (tests, recette).
 */
const config = require('../config');

class TranslationError extends Error {}

const TARGET = { fr: 'FR', en: 'EN-GB', es: 'ES', de: 'DE', it: 'IT', pt: 'PT-PT', nl: 'NL' };
const SOURCE = { fr: 'FR', en: 'EN', es: 'ES', de: 'DE', it: 'IT', pt: 'PT', nl: 'NL' };
const BATCH = 50;

const enabled = () => Boolean(config.translation.deeplKey) || config.translation.mock;
const baseUrl = () => (/:fx$/.test(config.translation.deeplKey) ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(body, { fetchImpl = fetch, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl()}/v2/translate`, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${config.translation.deeplKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw new TranslationError('DeepL injoignable');
    }
    if (res.ok) return res.json();
    const data = await res.json().catch(() => ({}));
    const trace = res.headers.get('x-trace-id');
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
    if (res.status === 456) throw new TranslationError('Quota de traduction DeepL atteint pour ce mois : augmentez l’offre DeepL ou attendez le mois prochain.');
    if (res.status === 403) throw new TranslationError('Clé DeepL refusée : vérifiez DEEPL_API_KEY sur Render.');
    throw new TranslationError(`DeepL ${res.status}${data.message ? ` : ${data.message}` : ''}${trace ? ` (trace ${trace})` : ''}`);
  }
}

/**
 * Traduit une liste de textes (même ordre en sortie).
 * @param {string[]} texts
 * @param {{ from: string, to: string, context?: (batch: string[], start: number) => string }} opts
 */
async function translateTexts(texts, { from, to, context } = {}, opts = {}) {
  if (!TARGET[to]) throw new TranslationError(`Langue de traduction non prise en charge : ${to}`);
  if (!texts.length) return [];
  if (!config.translation.deeplKey && config.translation.mock) return texts.map((t) => `[${to.toUpperCase()}] ${t}`);
  if (!config.translation.deeplKey) throw new TranslationError('Traduction non configurée (DEEPL_API_KEY).');
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const ctx = context ? String(context(batch, i) || '').slice(0, 4000) : '';
    const data = await call({
      text: batch,
      target_lang: TARGET[to],
      ...(SOURCE[from] ? { source_lang: SOURCE[from] } : {}),
      ...(ctx ? { context: ctx } : {}),
      preserve_formatting: true,
    }, opts);
    const tr = (data && data.translations) || [];
    if (tr.length !== batch.length) throw new TranslationError('Réponse DeepL incomplète');
    out.push(...tr.map((t) => t.text));
  }
  return out;
}

/**
 * Traduit des sous-titres en gardant le minutage de chaque ligne ; les lignes voisines servent de contexte.
 * @param {{start:number,end:number,text:string}[]} cues
 */
async function translateCues(cues, { from, to, wrap } = {}, opts = {}) {
  const texts = cues.map((c) => String(c.text || '').replace(/\s*\n\s*/g, ' ').trim());
  const translated = await translateTexts(texts, {
    from, to,
    // Contexte : les lignes qui précèdent et suivent le paquet (les phrases sont souvent coupées sur 2 lignes)
    context: (batch, start) => [...texts.slice(Math.max(0, start - 5), start), ...batch, ...texts.slice(start + batch.length, start + batch.length + 5)].join(' '),
  }, opts);
  return cues.map((c, i) => ({ ...c, text: wrap ? wrap(translated[i]) : translated[i] }));
}

module.exports = { translateTexts, translateCues, enabled, baseUrl, TranslationError, TARGET };
