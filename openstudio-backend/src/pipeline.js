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
const branding = require('./media/branding');
const opus = require('./opusclip/client');
const { buildProjectPayload, interpretProjectStatus, estimateCredits, shortId, capsuleDelivery } = require('./opusclip/payload');
const { isLiveOrder, liveTestGuard } = require('./opusclip/mode');
const { probeDurationSec, renderFinal, buildForceStyle, addBumpers } = require('./media/ffmpeg');
const { clipTranscript } = require('./social/transcript');
const { mp4DurationSec } = require('./media/mp4duration');
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

  // Estimation et contrôle des crédits
  // 1) en-tête MP4/MOV lu directement dans le stockage, 2) ffmpeg, 3) durée mesurée au dépôt
  let durationSec = await mp4DurationSec((a, b) => storage.readRange(key, a, b), h.size).catch((e) => {
    console.error(`[order ${shortId(order.id)}] en-tête vidéo illisible : ${e && e.message}`);
    return null;
  });
  if (!durationSec) {
    durationSec = await probeDurationSec(await storage.presignDownload(key, 'source.mp4', 'inline', 600)).catch((e) => {
      console.error(`[order ${shortId(order.id)}] ffmpeg : ${e && e.message}`);
      return null;
    });
  }
  if (!durationSec && order.options.sourceDurationSec) {
    durationSec = Number(order.options.sourceDurationSec);
    console.log(`[order ${shortId(order.id)}] durée reprise du dépôt : ${Math.round(durationSec)} s`);
  }
  console.log(`[order ${shortId(order.id)}] durée de la vidéo : ${durationSec ? Math.round(durationSec) + ' s' : 'inconnue'}`);
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

  const uploadId = await opus.uploadVideo(await storage.getStream(key), h.size);
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

/**
 * Logos à incruster, dans l'ordre de gauche à droite : entreprise du client, puis média.
 * Positions réglées sur la fiche client (bloc « Logos » du back-office).
 */
async function prepareLogos(order, tmp, { requireClientLogo }) {
  const logos = [];
  const add = async (key, position, name, role) => {
    const p = path.join(tmp, `${name}${path.extname(key) || '.png'}`);
    await storage.downloadToFile(key, p);
    logos.push({ path: p, position, role });
  };
  const client = order.client_id ? await clients.get(order.client_id) : null;
  const set = branding.clientLogos(client || {}, order.options.programmeId);
  const clientLogo = order.options.clientLogoKey || set.company.key;
  if (clientLogo) await add(clientLogo, set.company.position, 'logo-client', 'company');
  if (set.media.key) await add(set.media.key, set.media.position, 'logo-programme', 'media');
  if (!clientLogo && requireClientLogo && config.opus.dryRun) {
    // Tests (envoi réel ciblé) : le client de test n'a pas forcément de logo ; on livre sans, en le signalant.
    console.warn(`[order ${shortId(order.id)}] pas de logo client : capsules livrées sans (mode test uniquement)`);
  } else if (!clientLogo && requireClientLogo) throw new Error("Logo de l'entreprise cliente manquant (à ajouter dans la fiche client)");
  return logos;
}

async function finalize(order) {
  console.log(`[order ${shortId(order.id)}] finalisation : récupération des clips et habillage`);
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

/**
 * Répartit les extraits OpusClip (déjà classés) selon la durée cible :
 * long = au moins la cible (ou durée inconnue) → coupés exactement à la cible ;
 * short = un peu plus courts que la cible (à `toleranceSec` près), utilisés seulement en complément.
 * Les extraits plus courts encore sont écartés.
 */
function pickClipsForDuration(ranked, targetSec, toleranceSec) {
  const ms = (c) => Number(c.durationMs);
  const long = ranked.filter((c) => !Number.isFinite(ms(c)) || ms(c) >= targetSec * 1000 - 50);
  const short = ranked.filter((c) => Number.isFinite(ms(c)) && ms(c) < targetSec * 1000 - 50 && ms(c) >= (targetSec - toleranceSec) * 1000);
  return { long, short };
}

/**
 * Habillage d'ouverture (logo de l'entreprise) et de fin (logo OpenMedias) en fondu, sur place.
 * Sans logo d'entreprise (mode test uniquement), le logo OpenMedias sert aussi à l'ouverture.
 */
async function applyBumpers(file, kind, logos, tmp, n) {
  const b = mapping.bumpers;
  if (!b || !b.enabled || !b.kinds.includes(kind)) return;
  const company = logos.find((l) => l.role === 'company');
  let om = branding.DEFAULT_OM_LOGO;
  const custom = (await branding.get()).openmediasLogoKey;
  if (custom) {
    om = path.join(tmp, `logo-openmedias${path.extname(custom) || '.png'}`);
    if (!fs.existsSync(om)) await storage.downloadToFile(custom, om);
  }
  const out = path.join(tmp, `habille-${n}.mp4`);
  await addBumpers({ input: file, output: out, introLogo: company ? company.path : om, outroLogo: om, introSec: b.introSec, outroSec: b.outroSec, fadeSec: b.fadeSec, logoWidthRatio: b.logoWidthRatio });
  fs.renameSync(out, file);
}

async function finalizeCapsules(order, tmp) {
  const logos = await prepareLogos(order, tmp, { requireClientLogo: true });
  const all = (await opus.getExportableClips(order.opus_project_id)).filter((c) => c.uriForExport);
  if (!all.length) throw new Error("OpusClip n'a renvoyé aucun clip exportable");
  // Les meilleures propositions d'abord (score OpusClip s'il est fourni), limitées à maxClips.
  const score = (c) => Number(c.score ?? c.viralityScore ?? c.viralScore ?? NaN);
  const ranked = all.some((c) => Number.isFinite(score(c))) ? [...all].sort((a, b) => (score(b) || 0) - (score(a) || 0)) : all;
  const delivery = capsuleDelivery(order.options, mapping); // capsules : 3 vidéos ; teaser : 1
  // Durée choisie par le client, respectée à la seconde : extraits au moins aussi longs que la cible
  // (coupés ensuite exactement à la cible), puis, s'il en manque, extraits à moins de 1 s près.
  const target = Number(order.options.duration);
  const { long, short } = pickClipsForDuration(ranked, target, mapping.capsules.durationToleranceSec ?? 1);
  const clips = [...long, ...short].slice(0, delivery.maxClips);
  if (!clips.length) {
    const got = all.map((c) => (Number.isFinite(c.durationMs) ? `${Math.round(c.durationMs / 1000)} s` : '?')).join(', ');
    throw new Error(`Aucun extrait OpusClip d'au moins ${target} s (reçus : ${got})`);
  }
  console.log(`[order ${shortId(order.id)}] ${all.length} clip(s) proposés par OpusClip, ${clips.length} livré(s) à ${target} s`);
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
    await renderFinal({ input, output, logos, widthRatio: mapping.logos.widthRatio, marginRatio: mapping.logos.marginRatio, maxDurationSec: target });
    await applyBumpers(output, delivery.kind, logos, tmp, n);
    const finalSec = await probeDurationSec(output).catch(() => null);

    const fileName = delivery.kind === 'teaser'
      ? `${base}_teaser_${order.options.duration}s_${fmt}.mp4`
      : `${base}_capsule-${String(n).padStart(2, '0')}_${order.options.duration}s_${fmt}.mp4`;
    const key = `commandes/${order.id}/capsules/${fileName}`;
    const size = await storage.uploadFile(key, output);
    await orders.addDeliverable({
      orderId: order.id,
      storageKey: key,
      fileName,
      title: clip.title || (delivery.kind === 'teaser' ? 'Teaser' : `Capsule ${n}`),
      // Durée réelle du fichier livré (et non celle de l'extrait OpusClip avant coupe)
      durationMs: finalSec ? Math.round(finalSec * 1000) : Number.isFinite(clip.durationMs) ? Math.min(Math.round(clip.durationMs), target * 1000) : null,
      sizeBytes: size,
      opusClipId: clipId,
      expiresAt: expiry(),
      // Texte prononcé dans la partie livrée : sert aux légendes des réseaux sociaux
      transcript: clipTranscript(clip, target) || null,
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
    transcript: cues.map((c) => c.text || c.t || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 20000) || null,
  });
}

module.exports = { submit, poll, finalize, sourceKeyFor, pickClipsForDuration };
