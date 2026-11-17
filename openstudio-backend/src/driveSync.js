'use strict';
/**
 * Dossiers Google Drive des diffusions et import des vidéos déposées par les monteurs.
 *
 * Arborescence dans le Drive partagé (DRIVE_ROOT_FOLDER_ID) :
 *   <Entreprise>/                                   un dossier par client
 *     2026-12-03 – BFM Business 1&2 – Plateau TV/   un dossier par diffusion : le monteur y dépose la vidéo
 *   Annulées/                                       dossiers des diffusions annulées (jamais supprimés)
 *
 * Chaque dossier porte une étiquette invisible (appProperties) qui le relie au client ou à la diffusion :
 * on peut le renommer ou le déplacer sans perdre le lien, et un dossier créé deux fois est impossible.
 *
 * Import : dès qu'une vidéo stable (non modifiée depuis DRIVE_SETTLE_MIN minutes) est dans le dossier, elle
 * est copiée dans le stockage et rattachée au client. Elle reste invisible pour le client jusqu'au jour de
 * diffusion (clients.listVideos) et tant que la date n'est pas fixée ou si la diffusion est annulée.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const config = require('./config');
const clients = require('./clients');
const storage = require('./storage');
const { createDrive } = require('./drive/google');
const { mp4DurationSec } = require('./media/mp4duration');

const { diffusionFolderName, clientFolderName, expectedParent, programmeFor, pickVideo } = require('./drive/rules');

// ---------------------------------------------------------------------------
// Passage automatique
// ---------------------------------------------------------------------------
let drive = null;
function getDrive() {
  if (!drive) drive = createDrive({ credentialsJson: config.drive.credentialsJson });
  return drive;
}
const enabled = () => Boolean(config.drive.credentialsJson && config.drive.rootFolderId);

let cancelledFolderId = null;
async function cancelledFolder() {
  if (cancelledFolderId) return cancelledFolderId;
  const d = getDrive();
  const f = (await d.findFolderByProperty('openstudioRole', 'cancelled'))
    || (await d.createFolder('Annulées', config.drive.rootFolderId, { openstudioRole: 'cancelled' }));
  cancelledFolderId = f.id;
  return f.id;
}

async function clientFolder(clientId, clientName, existingId) {
  if (existingId) return existingId;
  const d = getDrive();
  const f = (await d.findFolderByProperty('openstudioClient', clientId))
    || (await d.createFolder(clientFolderName(clientName), config.drive.rootFolderId, { openstudioClient: clientId }));
  await db.query('UPDATE clients SET drive_folder_id = $2 WHERE id = $1', [clientId, f.id]);
  return f.id;
}

/** Crée, renomme et range les dossiers des diffusions. Renvoie le nombre de dossiers touchés. */
async function ensureFolders() {
  const d = getDrive();
  const { rows } = await db.query(
    `SELECT d.planning_id, d.client_id, d.media, d.sous_media, d.format, d.state,
            to_char(d.date_diffusion, 'YYYY-MM-DD') AS date_diffusion,
            d.drive_folder_id, d.drive_folder_name, d.drive_folder_parent,
            c.name AS client_name, c.drive_folder_id AS client_folder_id
     FROM diffusions d JOIN clients c ON c.id = d.client_id
     WHERE d.drive_folder_id IS NOT NULL OR d.state <> 'cancelled'
     ORDER BY d.date_diffusion ASC NULLS LAST`
  );
  let touched = 0;
  for (const r of rows) {
    const diff = { state: r.state, dateDiffusion: r.date_diffusion, media: r.media, sousMedia: r.sous_media, format: r.format };
    const name = diffusionFolderName(diff);
    const parent = expectedParent(diff);
    if (r.drive_folder_id && r.drive_folder_name === name && r.drive_folder_parent === parent) continue;
    try {
      const cFolder = await clientFolder(r.client_id, r.client_name, r.client_folder_id);
      const target = parent === 'cancelled' ? await cancelledFolder() : cFolder;
      let id = r.drive_folder_id;
      if (!id) {
        const found = await d.findFolderByProperty('openstudioDiffusion', String(r.planning_id));
        id = found ? found.id : (await d.createFolder(name, target, { openstudioDiffusion: String(r.planning_id), openstudioClient: r.client_id })).id;
        if (found) {
          const cur = (found.parents || [])[0];
          await d.updateFolder(id, { name, addParent: cur !== target ? target : undefined, removeParent: cur !== target ? cur : undefined });
        }
      } else {
        const from = r.drive_folder_parent === 'cancelled' ? await cancelledFolder() : cFolder;
        const move = r.drive_folder_parent !== parent;
        await d.updateFolder(id, { name, addParent: move ? target : undefined, removeParent: move ? from : undefined });
      }
      await db.query(
        'UPDATE diffusions SET drive_folder_id = $2, drive_folder_name = $3, drive_folder_parent = $4, updated_at = now() WHERE planning_id = $1',
        [r.planning_id, id, name, parent]
      );
      touched++;
    } catch (e) {
      console.warn(`[drive] dossier de la diffusion ${r.planning_id} : ${e.message}`);
    }
  }
  return touched;
}

/** Importe au plus une vidéo déposée (traitement lourd : une à la fois). Renvoie true si une vidéo a été importée. */
async function importNextVideo() {
  const d = getDrive();
  const { rows } = await db.query(
    `SELECT d.planning_id, d.client_id, d.media, d.format, d.state, d.drive_folder_id,
            to_char(d.date_diffusion, 'YYYY-MM-DD') AS date_diffusion
     FROM diffusions d
     WHERE d.drive_folder_id IS NOT NULL AND d.video_id IS NULL AND d.state <> 'cancelled'
     ORDER BY d.date_diffusion ASC NULLS LAST LIMIT 50`
  );
  for (const r of rows) {
    let file;
    try {
      file = pickVideo(await d.listFiles(r.drive_folder_id), { settleMs: config.drive.settleMin * 60 * 1000 });
    } catch (e) {
      console.warn(`[drive] lecture du dossier de la diffusion ${r.planning_id} : ${e.message}`);
      continue;
    }
    if (!file) continue;
    const ext = (path.extname(file.name || '').toLowerCase() || '.mp4').replace(/[^.a-z0-9]/g, '');
    const tmp = path.join(os.tmpdir(), `drive-${r.planning_id}-${file.id}${ext}`);
    try {
      await d.downloadToFile(file.id, tmp);
      const size = fs.statSync(tmp).size;
      const fd = fs.openSync(tmp, 'r');
      const durationSec = await mp4DurationSec(async (start, end) => {
        const buf = Buffer.alloc(end - start + 1);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf;
      }, size).catch(() => null).finally(() => fs.closeSync(fd));
      const key = `clients/${r.client_id}/diffusions/${r.planning_id}/${file.id}${ext}`;
      await storage.uploadFile(key, tmp, file.mimeType && /^video\//.test(file.mimeType) ? file.mimeType : 'video/mp4');
      const video = await clients.addVideo(r.client_id, {
        programmeId: programmeFor(r.media),
        title: [r.media, r.format].filter(Boolean).join(' – '),
        sourceKey: key,
        broadcastDate: r.state === 'active' ? r.date_diffusion : null,
        durationSec: durationSec ? Math.round(durationSec * 10) / 10 : null,
      });
      // Invisible tant que la date n'est pas fixée (date_pending) ; ensuite, visible à partir du jour de diffusion
      if (r.state !== 'active') await clients.setVideoActive(r.client_id, video.id, false);
      await db.query(
        `UPDATE diffusions SET video_id = $2, video_file_id = $3, video_imported_at = now(), video_import_error = NULL, updated_at = now()
         WHERE planning_id = $1`,
        [r.planning_id, video.id, file.id]
      );
      console.log(`[drive] vidéo importée pour la diffusion ${r.planning_id} (${file.name}, ${Math.round(size / 1e6)} Mo)`);
      return true;
    } catch (e) {
      console.error(`[drive] import de la vidéo de la diffusion ${r.planning_id} : ${e.message}`);
      await db.query('UPDATE diffusions SET video_import_error = $2, updated_at = now() WHERE planning_id = $1', [r.planning_id, e.message.slice(0, 500)]);
      return false;
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }
  return false;
}

let running = false;
let lastRun = 0;
let lastResult = null;

/** Un passage : dossiers puis une vidéo. Ne bloque pas le reste du worker (appelé sans await). */
async function tick({ force = false } = {}) {
  if (!enabled() || running) return lastResult;
  if (!force && Date.now() - lastRun < config.drive.intervalMin * 60 * 1000) return lastResult;
  running = true;
  lastRun = Date.now();
  try {
    const folders = await ensureFolders();
    const imported = await importNextVideo();
    lastResult = { ok: true, at: new Date().toISOString(), folders, imported };
    if (imported) lastRun = 0; // une autre vidéo attend peut-être : passage suivant sans délai
  } catch (e) {
    lastResult = { ok: false, at: new Date().toISOString(), error: e.message };
    console.error('[drive]', e.message);
  } finally {
    running = false;
  }
  return lastResult;
}

module.exports = {
  diffusionFolderName, clientFolderName, expectedParent, programmeFor, pickVideo,
  ensureFolders, importNextVideo, tick, enabled, lastResult: () => lastResult,
};
