'use strict';
/**
 * Mise en page commune des e-mails envoyés aux clients (charte OpenMedias, maquettes validées).
 * Écrite en tableaux et styles en ligne : c'est ce que Gmail, Outlook et les messageries mobiles
 * affichent de façon fiable (pas de flex, de grid ni de positionnement absolu).
 * Images : hébergées sur le site (dossier email/), adresse réglable avec EMAIL_ASSETS_URL.
 */
const config = require('../config');

const C = {
  bg: '#F2F3F8', card: '#FFFFFF', navy: '#0E084D', text: '#2A2660', muted: '#3A3670',
  accent: '#2154D1', line: '#DDE1F0', ticketLine: '#C9D3F2', ticketBg: '#EEF2FC', ticketDash: '#B7C4EE',
};
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const TITLE_FONT = "Outfit, Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const asset = (name) => `${config.mail.assetsUrl}/${name}`;

/** Bouton compatible avec toutes les messageries (cellule colorée + lien). */
function button(href, label, { align = 'left' } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="border-collapse:separate"><tr>
<td bgcolor="${C.accent}" style="border-radius:999px;background:${C.accent}"><a href="${esc(href)}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:500;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:999px">${esc(label)}</a></td>
</tr></table>`;
}

/** Pastille « 300 crédits » des cartes. */
function pill(href, label) {
  return `<a href="${esc(href)}" target="_blank" style="display:inline-block;padding:6px 12px;border:1px solid ${C.line};border-radius:999px;font-family:${FONT};font-size:12px;font-weight:500;color:${C.navy};text-decoration:none;white-space:nowrap"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${C.accent};vertical-align:middle;margin-right:6px"></span>${esc(label)}</a>`;
}

/**
 * Enveloppe : fond, carte blanche de 600 px, en-tête (libellé + logo), pied bleu nuit.
 * @param {{ title, preheader, kicker, body }} p  body : HTML des sections (lignes <tr>)
 */
function layout({ title, preheader, kicker, body }) {
  return `<!doctype html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Outfit:wght@700;800&amp;display=swap" rel="stylesheet">
<!--[if mso]><style>table,td,a,span,p,h1,h2{font-family:Arial,sans-serif !important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){
  .os-wrap{padding:12px 0 !important}
  .os-pad{padding-left:20px !important;padding-right:20px !important}
  .os-h1{font-size:28px !important}
  .os-stack{display:block !important;width:100% !important;box-sizing:border-box}
  .os-ticket-right{border-left:0 !important;border-top:2px dashed ${C.ticketDash} !important}
  .os-card-half{padding-right:0 !important;padding-bottom:16px !important}
  .os-card-half-r{padding-left:0 !important}
  .os-foot td{display:block !important;width:100% !important;text-align:left !important}
  .os-foot img{margin-top:16px}
}
a{color:${C.accent}}
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${esc(preheader || '')}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg}">
<tr><td align="center" class="os-wrap" style="padding:24px 12px 48px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${C.card};border-radius:16px;overflow:hidden" bgcolor="${C.card}">
<tr><td class="os-pad" style="padding:26px 40px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${C.navy}"><tr>
    <td style="padding:0 0 16px;font-family:${FONT};font-size:12px;color:${C.navy}" valign="bottom">${esc(kicker)}</td>
    <td align="right" style="padding:0 0 16px" valign="bottom"><img src="${asset('logo-openmedias.png')}" alt="OpenMedias" height="30" style="display:block;height:30px;width:auto;border:0"></td>
  </tr></table>
</td></tr>
${body}
<tr><td style="height:48px;line-height:48px;font-size:0">&nbsp;</td></tr>
<tr><td bgcolor="${C.navy}" class="os-pad" style="background:${C.navy};padding:32px 40px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="os-foot"><tr>
    <td style="font-family:${FONT}" valign="middle">
      <div style="font-size:14px;line-height:1.5;color:#FFFFFF">Une question ? Répondez simplement à cet e-mail.</div>
      <div style="font-size:12px;line-height:1.5;padding-top:6px"><a href="https://openmedias.fr" target="_blank" style="color:#FFFFFF">openmedias.fr</a></div>
    </td>
    <td align="right" valign="middle"><img src="${asset('logo-openmedias-blanc.png')}" alt="OpenMedias" height="34" style="display:block;height:34px;width:auto;border:0"></td>
  </tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { layout, button, pill, esc, asset, C, FONT, TITLE_FONT };
