'use strict';
/**
 * Habillage vidéo : logos des émissions (communs à tous les clients), logos de chaque client
 * (entreprise, et logo du média s'il faut le remplacer pour ce client) et logo OpenMedias de l'écran de fin.
 *
 * Logo du média d'une vidéo = logo propre à la fiche client s'il existe, sinon logo de l'émission
 * (rubrique « Émissions » du back-office), repris automatiquement : rien à déposer à la création du client.
 */
const path = require('path');
const db = require('../db');
const mapping = require('../opusclip.config');
const { programmeFor } = require('../drive/rules');

const DEFAULT_OM_LOGO = path.join(__dirname, '..', '..', 'assets', 'logos', 'openmedias-blanc.png');
const KEY = 'video_branding';
const PROG_KEY = 'programme_logos';
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

async function readSetting(key) {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0] ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value) : {};
}

async function writeSetting(key, value, actor) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), actor || null]
  );
}

async function get() {
  const v = await readSetting(KEY);
  return { openmediasLogoKey: v.openmediasLogoKey || null };
}

async function setOpenmediasLogo(key, actor) {
  const v = { ...(await get()), openmediasLogoKey: key || null };
  await writeSetting(KEY, v, actor);
  return v;
}

/** Logos des émissions : celui déposé dans le back-office, sinon celui de la configuration. */
async function programmeLogos() {
  const saved = await readSetting(PROG_KEY);
  const out = {};
  for (const [id, p] of Object.entries(mapping.programmes)) out[id] = { id, title: p.title, key: saved[id] || p.logoKey || null, uploaded: Boolean(saved[id]) };
  return out;
}

async function setProgrammeLogo(id, key, actor) {
  if (!mapping.programmes[id]) throw new Error('Émission inconnue');
  const saved = await readSetting(PROG_KEY);
  if (key) saved[id] = key; else delete saved[id];
  await writeSetting(PROG_KEY, saved, actor);
}

/** Émission principale d'un client : celle de sa vidéo la plus récente, sinon celle de sa diffusion. */
async function clientProgrammeId(clientId) {
  if (!clientId) return null;
  const v = await db.query(
    'SELECT programme_id FROM client_videos WHERE client_id = $1 AND active = true AND programme_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    [clientId]
  ).catch(() => ({ rows: [] }));
  if (v.rows[0]) return v.rows[0].programme_id;
  const d = await db.query(
    "SELECT media FROM diffusions WHERE client_id = $1 AND state <> 'cancelled' AND media IS NOT NULL ORDER BY date_diffusion DESC NULLS LAST LIMIT 1",
    [clientId]
  ).catch(() => ({ rows: [] }));
  return d.rows[0] ? programmeFor(d.rows[0].media) : null;
}

/**
 * Logos et positions d'un client (valeurs par défaut comprises).
 * @param programmeId  émission de la vidéo traitée ; à défaut, émission principale du client
 */
async function clientLogos(client, programmeId = null) {
  const progId = programmeId || (await clientProgrammeId(client.id));
  const progs = await programmeLogos();
  const prog = progId ? progs[progId] || null : null;
  // Logo du média propre au client : seulement pour l'émission où il a été déposé (un client diffusé sur
  // Le Figaro et sur BFM Business garde le bon logo sur chaque vidéo). Ancien logo sans émission : partout.
  const own = client.media_logo_key && (!client.media_logo_programme_id || client.media_logo_programme_id === progId) ? client.media_logo_key : null;
  return {
    company: { key: client.logo_key || null, position: POSITIONS.includes(client.logo_position) ? client.logo_position : mapping.logos.clientPosition },
    media: {
      key: own || (prog && prog.key) || null,
      position: POSITIONS.includes(client.media_logo_position) ? client.media_logo_position : mapping.logos.programmePosition,
      source: own ? 'client' : prog && prog.key ? 'programme' : null,
      programmeId: progId || null,
      programmeTitle: prog ? prog.title : null,
    },
  };
}

module.exports = { DEFAULT_OM_LOGO, POSITIONS, get, setOpenmediasLogo, programmeLogos, setProgrammeLogo, clientProgrammeId, clientLogos };
