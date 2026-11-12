// Affiche la requête OpusClip construite pour chaque combinaison type × durée × format, sans rien envoyer
// ni consommer de crédit : node scripts/payload-matrix.js [Émission|Reportage|…]
import { buildOpusPayload, redact, OPUS_MAP } from '../lib/opus.js';

const videoKind = process.argv[2] || 'Émission';
for (const [kind, { durs }] of Object.entries(OPUS_MAP.kinds)) {
  for (const dur of durs) for (const fmt of Object.keys(OPUS_MAP.fmts)) {
    const p = redact(buildOpusPayload({ kind, dur, fmt, style: 'impact', videoKind, title: 'Vision d’entreprises' }, { videoUrl: 'x', webhookUrl: 'https://exemple.onrender.com/opus/webhook' }));
    console.log(`\n### ${kind} ${dur} s ${fmt} (${videoKind})\n${JSON.stringify(p)}`);
  }
}
