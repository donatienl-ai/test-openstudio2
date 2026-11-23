'use strict';
/**
 * Titre d'une capsule à partir de ce qui y est dit : les mots-clés de sa transcription.
 * - Avec la clé Claude (ANTHROPIC_API_KEY) : un titre court rédigé à partir des mots-clés.
 * - Sans clé, ou en cas d'échec : les 3 mots les plus porteurs de sens, « Recyclage · Plastiques · Granulés ».
 */
const config = require('../config');

// Mots trop courants pour servir de mot-clé (outils grammaticaux, verbes et adverbes passe-partout de l'oral).
const STOP = new Set(`
a à ai aie aient aies ait alors après as assez au aucun aucune aujourd aujourdhui auprès aussi autre autres aux avaient avais avait avant avec avez aviez avions avoir avons ayant beaucoup bien bon bonjour bonne c ça cas ce ceci cela celle celles celui cent cependant certain certaine certaines certains ces cet cette ceux chaque chez choses ci comme comment d dans de déjà depuis des deux devant devient doit donc dont du elle elles en encore enfin entre est et étaient étais était étant été être eu eux fait faire fais faisons faut fois font grand grande gros haut hui il ils j je jusqu jusque l la là le les leur leurs lui m ma mais me même mêmes merci mes moi moins mon n ne ni non nos notre nous on ont ou où oui par parce parfois parle parler pas peu peut peuvent peux plus plupart pour pourquoi pouvez pouvons première premier près puis qu quand que quel quelle quelles quelque quelques quels qui quoi s sa sans se sera serait ses si sien soit son sont sous suis sur t ta tant te tes toi ton toujours tous tout toute toutes très trop tu un une unes uns va vais vas vers veut via voici voilà vont vos votre vous vraiment vrai vraie y
avoir aller dire voir savoir pouvoir vouloir venir prendre mettre donner trouver passer rester
effectivement justement évidemment finalement simplement notamment exactement absolument clairement également surtout ensuite quand même
chose choses gens personne personnes année années jour jours temps moment fois façon manière niveau question idée exemple partie
aujourd'hui c'est j'ai qu'il qu'on n'est d'un d'une l'on s'est
`.split(/\s+/).filter(Boolean));

const norm = (w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP_N = new Set([...STOP].map(norm));

/** Mots-clés d'un texte : fréquents, porteurs de sens, dans l'ordre de leur poids. */
function keywords(text, max = 3) {
  const words = String(text || '').replace(/[’']/g, ' ').match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9-]+/g) || [];
  const stats = new Map();
  words.forEach((raw, i) => {
    const w = raw.replace(/^-+|-+$/g, '');
    const k = norm(w);
    if (k.length < 4 || STOP_N.has(k) || /^\d+$/.test(k)) return;
    // Un pluriel et son singulier comptent ensemble (« granulé » / « granulés »)
    const root = k.replace(/(s|x)$/, '');
    const s = stats.get(root) || { word: w.toLowerCase(), n: 0, first: i, len: k.length };
    s.n += 1;
    stats.set(root, s);
  });
  return [...stats.values()]
    // Fréquence d'abord ; à égalité, les mots longs (plus spécifiques), puis les premiers prononcés
    .sort((a, b) => b.n - a.n || b.len - a.len || a.first - b.first)
    .slice(0, max)
    .sort((a, b) => a.first - b.first) // dans l'ordre où ils sont prononcés
    .map((s) => s.word);
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** Titre sans IA : « Recyclage · Plastiques · Granulés ». Vide si la transcription ne suffit pas. */
function keywordTitle(text, max = 3) {
  const k = keywords(text, max);
  return k.length >= 2 ? k.map(cap).join(' · ') : '';
}

let clientInstance = null;
function anthropic() {
  if (!clientInstance) {
    const Anthropic = require('@anthropic-ai/sdk');
    clientInstance = new (Anthropic.default || Anthropic)({ apiKey: config.anthropic.apiKey });
  }
  return clientInstance;
}

/** Titre rédigé par l'IA à partir de la transcription (≤ 60 caractères, mots-clés du sujet). */
async function aiTitle(text, ctx, client) {
  const response = await (client || anthropic()).messages.create({
    model: config.anthropic.model,
    max_tokens: 1000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } },
    system: "Tu donnes un titre à un extrait vidéo d'une interview télévisée d'entreprise. Le titre, en français, fait 60 caractères au maximum et reprend les mots-clés du sujet abordé dans l'extrait (ce dont on parle concrètement), sans guillemets, sans emoji, sans point final, sans inventer d'information absente de la transcription.",
    messages: [{ role: 'user', content: `${ctx && ctx.company ? `Entreprise : ${ctx.company}\n` : ''}${ctx && ctx.programme ? `Émission : ${ctx.programme}\n` : ''}Transcription de l'extrait :\n<transcription>\n${text}\n</transcription>` }],
  });
  if (response.stop_reason !== 'end_turn') throw new Error(`titre non généré (${response.stop_reason})`);
  const t = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')).title;
  return String(t || '').replace(/^["«\s]+|["»\s.]+$/g, '').slice(0, 80);
}

/**
 * Titre d'une capsule : IA si disponible, sinon mots-clés ; à défaut, `fallback`.
 * Ne lève jamais (un titre ne doit pas bloquer une livraison).
 */
async function capsuleTitle(transcript, fallback, ctx = {}, { client } = {}) {
  const text = String(transcript || '').trim();
  if (text.split(/\s+/).length >= 8 && (config.anthropic.apiKey || client)) {
    try {
      const t = await aiTitle(text.slice(0, 4000), ctx, client);
      if (t) return t;
    } catch (e) {
      console.warn(`[titre] IA indisponible, mots-clés utilisés : ${e.message}`);
    }
  }
  return keywordTitle(text) || fallback;
}

module.exports = { keywords, keywordTitle, capsuleTitle };
