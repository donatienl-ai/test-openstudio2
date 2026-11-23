'use strict';
/**
 * Habillage vidéo : logos du client (entreprise, média) et logo OpenMedias de l'écran de fin.
 */
const path = require('path');
const db = require('../db');
const mapping = require('../opusclip.config');

const DEFAULT_OM_LOGO = path.join(__dirname, '..', '..', 'assets', 'logos', 'openmedias-blanc.png');
const KEY = 'video_branding';
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

async function get() {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
  const v = rows[0] ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value) : {};
  return { openmediasLogoKey: v.openmediasLogoKey || null };
}

async function setOpenmediasLogo(key, actor) {
  const v = { ...(await get()), openmediasLogoKey: key || null };
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify(v), actor || null]
  );
  return v;
}

/** Logos et positions d'un client (valeurs par défaut comprises). */
function clientLogos(client, programmeId = null) {
  const progLogo = programmeId ? mapping.programmes[programmeId]?.logoKey || null : null;
  return {
    company: { key: client.logo_key || null, position: POSITIONS.includes(client.logo_position) ? client.logo_position : mapping.logos.clientPosition },
    media: { key: client.media_logo_key || progLogo, position: POSITIONS.includes(client.media_logo_position) ? client.media_logo_position : mapping.logos.programmePosition },
  };
}

module.exports = { DEFAULT_OM_LOGO, POSITIONS, get, setOpenmediasLogo, clientLogos };
