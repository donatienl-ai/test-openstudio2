'use strict';
/**
 * Traitement d'une commande vidéo :
 *   1. submit()   : envoi de la vidéo à OpusClip + création du projet
 *                   (sous-titres avec fichier fourni : pas d'OpusClip, rendu local direct)
 *   2. poll()     : vérification de secours si le webhook n'arrive pas
 *   3. finalize() : capsules → récupération des clips + logos ; sous-titres → .srt + .vtt + vidéo sous-titrée
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline: streamPipeline } = require('stream/promises');
const { Readable } = require('stream');

const config = require('./config');
const mapping = require('./opusclip.config');
const orders = require('./orders');
const clients = require('./clients');
const storage = require('./storage');
const opus = require('./opusclip/client');
const { buildProjectPayload, interpretProjectStatus, estimateCredits, shortId } = require('./opusclip/payload');
const { isLiveOrder, liveTestGuard } = require('./opusclip/mode');
const { probeDurationSec, renderFinal, buildForceStyle } = require('./media/ffmpeg');
const subs = require('./media/subtitles');

const webhookUrl = () => `${config.publicBaseUrl}/api/webhooks/opusclip`;

/** Clé de stockage de la vidéo source d'une commande. */
function sourceKeyFor(order) {
  return order.type === 'capsules' ? order.options.sourceKey : order.options.videoKey;
}

// ---------------------------------------------------------------------------
// 1. SOUMISSION
// ---------------------------------------------------------------------------
async function submit(order) {
  // Sous-titres avec fichier .srt/.vtt fourni : rendu entièrement local, aucun crédit OpusClip
  if (order.type === 'subtitles' && order.options.mode === 'client_file') {
    await orders.setStatus(order.id, 'opus_done');
    return;
  }

  const key = sourceKeyFor(order);
  const h = await storage.head(key);
  if (!h.exists) throw new Error(`Vidéo source introuvable dans le stockage : ${key}`);

  // La vidéo est téléchargée dans un dossier temporaire : ffmpeg la lit en local (le binaire statique
  // ne sait pas toujours résoudre les noms de domaine sur Render), puis elle est envoyée à OpusClip.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `os-src-${shortId(order.id)}-`));
  try {
    const local = path.join(tmp, `source${path.extname(key).toLowerCase() || '.mp4'}`);
    await storage.downloadToFile(key, local);
    await submitLocal(order, local, fs.statSync(local).size);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function submitLocal(order, local, sizeBytes) {
  // Estimation et contrôle des crédits
  const durationSec = await probeDurationSec(local).catch(() => null);
  const credits = estimateCredits(durationSec, config.opus.creditsPerMinute);
  const remaining = config.opus.creditBudget - (await orders.creditsUsed());
  if (config.opus.creditBudget > 0 && credits > remaining) {
    throw new Error(`Crédits insuffisants : ${credits} estimés, ${remaining} restants`);
  }

  // Mode dry run : on construit et on journalise sans rien envoyer
  // (sauf pour les clients de test listés dans OPUSCLIP_LIVE_CLIENTS)
  if (!isLiveOrder(order, config.opus)) {
    const payload = buildProjectPayload(order, '<uploadId>', mapping, webhookUrl());
    console.log(`[dry-run] commande ${shortId(order.id)} — ${credits} crédits estimés\n${JSON.stringify(payload, null, 2)}`);
    await orders.setStatus(order.id, 'dry_run', { opus_payload: JSON.stringify(payload), estimated_credits: credits });
    return;
  }

  const blocked = liveTestGuard(durationSec, config.opus);
  if (blocked) throw new Error(blocked);
  if (config.opus.dryRun) console.log(`[test réel] commande ${shortId(order.id)} envoyée à OpusClip (client de test) — ${credits} crédits estimés`);

  const uploadId = await opus.uploadVideo(fs.createReadStream(local), sizeBytes);
  const payload = buildProjectPayload(order, uploadId, mapping, webhookUrl());
  const { projectId } = await opus.createProject(payload);
  await orders.saveProjectId(order.id, projectId);
  await orders.recordCredits(order.id, credits, `estimation ${durationSec ? Math.round(durationSec) + ' s' : 'durée inconnue'}`);
  await orders.setProcessing(order.id, projectId, payload, credits);
}

// ---------------------------------------------------------------------------
// 2. VÉRIFICATION DE SECOURS (polling)
// ---------------------------------------------------------------------------
async function poll(order) {
  const ageMin = (Date.now() - new Date(order.submitted_at || order.updated_at).getTime()) / 60000;
  if (ageMin > config.opus.timeoutMin) {
    await orders.fail(order.id, `Aucun résultat OpusClip après ${Math.round(ageMin)} minutes`);
    return;
  }

  let status = 'unknown';
  try {
    status = interpretProjectStatus(await opus.getProject(order.opus_project_id));
  } catch (e) {
    console.warn(`[poll ${shortId(order.id)}] lecture du projet impossible : ${e.message}`);
  }
  if (status === 'failed') return orders.fail(order.id, 'OpusClip a signalé un échec du projet');
  if (status === 'done') return orders.markOpusDone(order.id, 'polling');

  if (status === 'unknown') {
    if (order.type === 'subtitles') {
      // Sous-titres : on n'a besoin que de la transcription
      const transcript = await opus.getTranscript(order.opus_project_id).catch(() => null);
      if (transcript) await orders.markOpusDone(order.id, 'polling-transcript');
      return;
    }
    // Capsules : terminé si le nombre de clips exportables est stable entre deux vérifications
    const clips = await opus.getExportableClips(order.opus_project_id).catch(() => []);
    const ready = clips.filter((c) => c.uriForExport);
    if (ready.length > 0 && order.poll_clip_count === ready.length) {
      await orders.markOpusDone(order.id, 'polling-stable');
    } else {
      await orders.setPollClipCount(order.id, ready.length);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. FINALISATION
// ---------------------------------------------------------------------------
async function downloadUrlToFile(url, filePath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
  await streamPipeline(Readable.fromWeb(res.body), fs.createWriteStream(filePath));
}

function slug(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40);
}

/** Logos à incruster : programme (média) + entreprise du client. */
async function prepareLogos(order, tmp, { requireClientLogo }) {
  const logos = [];
  const add = async (key, position, name) => {
    const p = path.join(tmp, `${name}${path.extname(key) || '.png'}`);
    await storage.downloadToFile(key, p);
    logos.push({ path: p, position });
  };
  const programmeLogo = mapping.programmes[order.options.programmeId]?.logoKey;
  if (programmeLogo) await add(programmeLogo, mapping.logos.programmePosition, 'logo-programme');

  const client = order.client_id ? await clients.get(order.client_id) : null;
  const clientLogo = order.options.clientLogoKey || client?.logo_key || null;
  if (clientLogo) await add(clientLogo, mapping.logos.clientPosition, 'logo-client');
  else if (requireClientLogo) throw new Error("Logo de l'entreprise cliente manquant (à ajouter dans la fiche client)");
  return logos;
}

async function finalize(order) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `os-${shortId(order.id)}-`));
  try {
    if (order.type === 'subtitles') await finalizeSubtitles(order, tmp);
    else await finalizeCapsules(order, tmp);
    await orders.setStatus(order.id, 'ready', { ready_at: new Date() });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const expiry = () => new Date(Date.now() + config.storage.retentionDays * 86400_000);

async function finalizeCapsules(order, tmp) {
  const logos = await prepareLogos(order, tmp, { requireClientLogo: true });
  const clips = (await opus.getExportableClips(order.opus_project_id)).filter((c) => c.uriForExport);
  if (!clips.length) throw new Error("OpusClip n'a renvoyé aucun clip exportable");
  const done = await orders.existingClipIds(order.id);
  const base = slug(mapping.programmes[order.options.programmeId]?.title);
  const fmt = order.options.format.replace(':', 'x');

  let n = 0;
  for (const clip of clips) {
    n += 1;
    const clipId = String(clip.id || `${order.opus_project_id}-${n}`);
    if (done.has(clipId)) continue; // reprise après interruption

    const input = path.join(tmp, `clip-${n}.mp4`);
    const output = path.join(tmp, `final-${n}.mp4`);
    await downloadUrlToFile(clip.uriForExport, input);
    await renderFinal({ input, output, logos, widthRatio: mapping.logos.widthRatio, marginRatio: mapping.logos.marginRatio });

    const fileName = `${base}_capsule-${String(n).padStart(2, '0')}_${order.options.duration}s_${fmt}.mp4`;
    const key = `commandes/${order.id}/capsules/${fileName}`;
    const size = await storage.uploadFile(key, output);
    await orders.addDeliverable({
      orderId: order.id,
      storageKey: key,
      fileName,
      title: clip.title || `Capsule ${n}`,
      durationMs: Number.isFinite(clip.durationMs) ? Math.round(clip.durationMs) : null,
      sizeBytes: size,
      opusClipId: clipId,
      expiresAt: expiry(),
    });
    fs.rmSync(input, { force: true });
    fs.rmSync(output, { force: true });
  }
}

async function finalizeSubtitles(order, tmp) {
  const o = order.options;
  const conf = mapping.subtitles;
  const splitOpts = { ...conf.splitting, split: o.splitLongLines, offsetMs: o.offsetMs || 0 };

  // 1. Sous-titres : fichier fourni par le client, ou transcription OpusClip
  let cues;
  if (o.mode === 'client_file') {
    const parsed = subs.parseSubtitleFile(await storage.getText(o.transcriptKey));
    if (parsed.errors.length) throw new Error(`Transcription invalide : ${parsed.errors.slice(0, 3).join(' ; ')}`);
    cues = subs.prepareCues(parsed.cues, splitOpts);
  } else {
    const transcript = await opus.getTranscript(order.opus_project_id);
    if (!transcript) {
      // Pas encore prête : on repasse en attente, le polling réessaiera
      await orders.setStatus(order.id, 'processing');
      throw Object.assign(new Error('Transcription OpusClip pas encore disponible'), { retry: true });
    }
    const raw = subs.cuesFromTranscript(transcript, { ...conf.splitting, split: o.splitLongLines, dropFillers: false });
    cues = subs.prepareCues(raw, { ...splitOpts, split: false }).map((c) => ({
      ...c,
      text: o.splitLongLines ? subs.wrapText(c.text, conf.splitting.maxCharsPerLine, conf.splitting.maxLines) : c.text,
    }));
  }
  if (!cues.length) throw new Error('Aucun sous-titre à produire');

  const lang = o.subtitleLanguage;
  const base = `sous-titres_${lang}`;
  const done = await orders.existingClipIds(order.id);

  // 2. Fichiers .srt et .vtt
  const srtText = subs.toSrt(cues);
  for (const [ext, content, type] of [
    ['srt', srtText, 'application/x-subrip'],
    ['vtt', subs.toVtt(cues), 'text/vtt'],
  ]) {
    if (done.has(`file-${ext}`)) continue;
    const local = path.join(tmp, `${base}.${ext}`);
    fs.writeFileSync(local, content, 'utf8');
    const key = `commandes/${order.id}/subtitles/${base}.${ext}`;
    const size = await storage.uploadFile(key, local, `${type}; charset=utf-8`);
    await orders.addDeliverable({
      orderId: order.id, storageKey: key, fileName: `${base}.${ext}`, title: `Fichier .${ext}`,
      durationMs: null, sizeBytes: size, opusClipId: `file-${ext}`, expiresAt: expiry(),
    });
  }

  // 3. Vidéo avec sous-titres incrustés (DM Sans, blanc, contour noir, sans fond)
  if (done.has('video')) return;
  const input = path.join(tmp, 'source.mp4');
  await storage.downloadToFile(o.videoKey, input);
  const srtPath = path.join(tmp, 'render.srt');
  fs.writeFileSync(srtPath, srtText, 'utf8');
  const forceStyle = buildForceStyle({
    fontName: conf.style.fontName,
    fontSize: conf.style.sizes[o.size],
    outline: conf.style.outlines[o.outline],
    outlineColour: conf.style.outlineColour,
    primaryColour: conf.style.primaryColour,
  });
  const logos = mapping.logos.onSubtitledVideo ? await prepareLogos(order, tmp, { requireClientLogo: true }) : [];
  const output = path.join(tmp, 'final.mp4');
  await renderFinal({
    input, output, logos,
    widthRatio: mapping.logos.widthRatio, marginRatio: mapping.logos.marginRatio,
    subtitles: { srtPath, forceStyle },
  });
  const fileName = `video_${base}.mp4`;
  const key = `commandes/${order.id}/subtitles/${fileName}`;
  const size = await storage.uploadFile(key, output);
  await orders.addDeliverable({
    orderId: order.id, storageKey: key, fileName, title: 'Vidéo sous-titrée',
    durationMs: null, sizeBytes: size, opusClipId: 'video', expiresAt: expiry(),
  });
}

module.exports = { submit, poll, finalize, sourceKeyFor };
