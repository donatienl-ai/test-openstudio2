'use strict';
/**
 * Durée d'une vidéo MP4 / MOV / M4V lue directement dans l'en-tête (atome moov > mvhd),
 * par lectures partielles : ni ffmpeg ni téléchargement complet du fichier.
 * readRange(start, endInclusive) doit renvoyer un Buffer.
 */
const MAX_MOOV = 64 * 1024 * 1024;

function mvhdDuration(buf) {
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    if (size === 0) size = buf.length - off;
    if (size < header) return null;
    if (type === 'mvhd') {
      const p = off + header;
      const version = buf[p];
      let timescale; let duration;
      if (version === 1) { timescale = buf.readUInt32BE(p + 20); duration = Number(buf.readBigUInt64BE(p + 24)); }
      else { timescale = buf.readUInt32BE(p + 12); duration = buf.readUInt32BE(p + 16); }
      return timescale > 0 && duration > 0 ? duration / timescale : null;
    }
    off += size;
  }
  return null;
}

async function mp4DurationSec(readRange, fileSize) {
  let pos = 0;
  for (let i = 0; i < 200 && pos + 8 <= fileSize; i += 1) {
    const h = await readRange(pos, Math.min(pos + 15, fileSize - 1));
    if (h.length < 8) return null;
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) { if (h.length < 16) return null; size = Number(h.readBigUInt64BE(8)); header = 16; }
    else if (size === 0) size = fileSize - pos;
    if (size < header || !/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (type === 'moov') {
      if (size > MAX_MOOV) return null;
      return mvhdDuration(await readRange(pos + header, pos + size - 1));
    }
    pos += size;
  }
  return null;
}

module.exports = { mp4DurationSec, mvhdDuration };
