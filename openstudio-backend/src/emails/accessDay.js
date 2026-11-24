'use strict';
/**
 * Étape 1 · Envoi 1 : « C’est le jour J : votre espace OpenStudio est ouvert » (maquette « pass clair »).
 * Envoyé le jour de la diffusion avec le code d'accès ; variante sans « aujourd'hui » quand l'équipe
 * l'envoie à la main avant la diffusion.
 */
const { layout, button, pill, esc, asset, C, FONT, TITLE_FONT } = require('./layout');

const nb = (n) => Number(n).toLocaleString('fr-FR').replace(/\s/g, ' ');
const longDate = (d) => {
  const s = new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const shortDate = (d) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
/** « Claire Dumas » → « Claire » ; vide si le nom ressemble à une entreprise. */
function firstName(name) {
  const n = String(name || '').trim();
  if (!n || /\b(sas|sarl|sa|group|groupe|industrie|société)\b/i.test(n)) return '';
  return n.split(/\s+/)[0];
}

/**
 * @param {object} v
 * @param {string} v.name        nom du contact (« Claire Dumas »)
 * @param {string} v.code        code d'accès OM-XXXX-XX
 * @param {string} v.link        lien de connexion (code prérempli)
 * @param {boolean} v.today      diffusion aujourd'hui
 * @param {string} [v.broadcastDay]  AAAA-MM-JJ
 * @param {string} [v.programme] émission (« Smart Impact »)
 * @param {string} [v.media]     média (« BFM Business »)
 * @param {number} v.credits     crédits offerts
 * @param {Date|string} [v.creditsUntil]
 * @param {{capsules:number, teaser:number, subtitlesPer5Min:number}} v.prices
 * @param {boolean} [v.dark]   talon crédits bleu nuit dégradé (variante « test A »)
 */
function accessDayEmail(v) {
  const first = firstName(v.name);
  const hello = first ? `Bonjour ${esc(first)}` : 'Bonjour';
  const where = v.programme && v.media && v.programme !== v.media ? `dans <b style="font-weight:600;color:${C.navy}">${esc(v.programme)}</b> sur ${esc(v.media)}`
    : v.media || v.programme ? `sur <b style="font-weight:600;color:${C.navy}">${esc(v.media || v.programme)}</b>` : 'à l’antenne';
  const credits = `<b style="color:${C.navy};font-weight:600">${nb(v.credits)}&nbsp;crédits offerts</b>`;
  const title = v.today ? 'Votre émission est diffusée aujourd’hui.' : 'Votre espace OpenStudio est ouvert.';
  const intro = v.today
    ? `${hello}, c’est le grand jour : votre passage ${where} est à l’antenne aujourd’hui. Votre espace OpenStudio est ouvert, avec ${credits} pour créer vos premières vidéos.`
    : `${hello}, votre espace OpenStudio est ouvert pour préparer la diffusion de votre passage ${where}. Vous disposez de ${credits} pour créer vos premières vidéos.`;
  const until = v.creditsUntil ? shortDate(v.creditsUntil) : null;
  const subject = v.today ? 'C’est le jour J : votre espace OpenStudio est ouvert' : 'Votre espace OpenStudio est ouvert';
  const link = v.link;

  const card = (img, alt, h, titleTxt, desc, price) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:12px;border-collapse:separate;overflow:hidden">
<tr><td style="padding:0;line-height:0"><a href="${esc(link)}" target="_blank"><img src="${asset(img)}" alt="${esc(alt)}" width="${h === 200 ? 518 : 250}" style="display:block;width:100%;height:auto;border:0;border-radius:11px 11px 0 0"></a></td></tr>
<tr><td style="padding:18px 18px 16px;font-family:${FONT}">
  <div style="font-family:${TITLE_FONT};font-weight:700;font-size:16px;line-height:1.3;color:${C.navy}">${esc(titleTxt)}</div>
  <div style="font-size:14px;line-height:1.55;color:${C.text};padding-top:6px">${esc(desc)}</div>
  <div style="text-align:right;padding-top:12px">${pill(link, price)}</div>
</td></tr></table>`;

  const body = `
<tr><td class="os-pad" style="padding:40px 40px 0;font-family:${FONT}">
  ${v.broadcastDay ? `<div style="font-size:13px;color:${C.muted};padding-bottom:16px">${esc(longDate(v.broadcastDay))}</div>` : ''}
  <h1 class="os-h1" style="margin:0;font-family:${TITLE_FONT};font-weight:700;font-size:34px;line-height:1.15;letter-spacing:-0.01em;color:${C.navy}">${esc(title)}</h1>
  <p style="margin:16px 0 0;font-size:16px;line-height:1.6;color:${C.text}">${intro}</p>
</td></tr>
<tr><td class="os-pad" style="padding:32px 40px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.ticketLine};border-radius:18px;border-collapse:separate;overflow:hidden"><tr>
    <td class="os-tk-l" valign="middle" style="padding:22px 20px 20px 24px;font-family:${FONT}">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:${C.muted}">Votre code d’accès</div>
      <div class="os-code" style="font-family:${TITLE_FONT};font-weight:700;font-size:28px;line-height:1;letter-spacing:0.06em;white-space:nowrap;color:${C.navy};padding:14px 0 16px">${esc(v.code)}</div>
      ${button(link, 'Accéder à mon espace', { small: true })}
      <div style="clear:both;font-size:12px;line-height:1.5;color:${C.muted};padding-top:12px">Le bouton vous connecte directement. Ce code vous est personnel.</div>
    </td>
    <td class="os-tk-r" width="176" valign="middle" ${v.dark
      ? `bgcolor="${C.navy}" style="width:176px;background-color:${C.navy};background-image:linear-gradient(150deg,${C.navy} 0%,#1A2A9A 60%,${C.accent} 100%);padding:22px 18px 20px 22px;font-family:${FONT}"`
      : `bgcolor="${C.ticketBg}" style="width:176px;background:${C.ticketBg};border-left:2px dashed ${C.ticketDash};padding:22px 18px 20px 22px;font-family:${FONT}"`}>
      <div class="os-credits" style="font-weight:700;font-size:36px;line-height:1;letter-spacing:-0.02em;color:${v.dark ? '#FFFFFF' : C.accent}">${nb(v.credits)}</div>
      <div style="font-family:${TITLE_FONT};font-weight:700;font-size:16px;color:${v.dark ? '#FFFFFF' : C.navy};padding-top:10px">crédits offerts</div>
      ${until ? `<div style="font-size:12px;line-height:1.5;color:${v.dark ? 'rgba(255,255,255,0.82)' : C.muted};padding-top:14px">Valables jusqu’au<br><b style="font-weight:600;color:${v.dark ? '#FFFFFF' : C.navy}">${esc(until)}</b></div>` : ''}
    </td>
  </tr></table>
</td></tr>
<tr><td class="os-pad" style="padding:40px 40px 0">
  <h2 style="margin:0 0 18px;font-family:${TITLE_FONT};font-weight:800;font-size:22px;line-height:1.25;color:${C.navy}">Ce que vos crédits vous permettent</h2>
  ${card('capsules.jpg', 'Des capsules pour vos réseaux', 200, 'Des capsules pour vos réseaux', 'Votre émission découpée en vidéos courtes pour LinkedIn, Instagram ou TikTok.', `${nb(v.prices.capsules)} crédits`)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr>
    <td class="os-stack os-card-half" width="50%" valign="top" style="width:50%;padding-right:8px">${card('sous-titres.jpg', 'Sous-titres et logo', 150, 'Sous-titres et logo', 'Intégrés automatiquement, sans monteur.', `${nb(v.prices.subtitlesPer5Min)} crédits / 5 min`)}</td>
    <td class="os-stack os-card-half-r" width="50%" valign="top" style="width:50%;padding-left:8px">${card('teaser.jpg', 'Un teaser de votre passage', 150, 'Un teaser de votre passage', 'Pour annoncer et prolonger votre émission.', `${nb(v.prices.teaser)} crédits`)}</td>
  </tr></table>
</td></tr>
<tr><td class="os-pad" align="center" style="padding:28px 40px 0">${button(link, 'Utiliser mes crédits', { align: 'center' })}</td></tr>`;

  const text = [
    `${first ? `Bonjour ${first}` : 'Bonjour'},`,
    '',
    v.today
      ? `C’est le grand jour : votre passage ${[v.programme && v.programme !== v.media ? `dans ${v.programme}` : '', v.media ? `sur ${v.media}` : ''].filter(Boolean).join(' ') || 'à l’antenne'} est diffusé aujourd’hui. Votre espace OpenStudio est ouvert.`
      : 'Votre espace OpenStudio est ouvert.',
    '',
    `Votre code d’accès : ${v.code}`,
    `Pour vous connecter (le code est déjà rempli) : ${link}`,
    '',
    `${nb(v.credits)} crédits offerts${until ? `, valables jusqu’au ${until}` : ''}, pour créer vos premières vidéos :`,
    `- des capsules pour vos réseaux (${nb(v.prices.capsules)} crédits) ;`,
    `- des sous-titres et votre logo intégrés automatiquement (${nb(v.prices.subtitlesPer5Min)} crédits par tranche de 5 min) ;`,
    `- un teaser de votre passage (${nb(v.prices.teaser)} crédits).`,
    '',
    'Ce code vous est personnel. Une question ? Répondez simplement à cet e-mail.',
    '',
    'L’équipe OpenMedias',
  ].join('\n');

  return {
    subject,
    html: layout({ title: subject, preheader: `Votre code d’accès et vos ${nb(v.credits)} crédits offerts vous attendent.`, kicker: v.today ? 'OpenStudio · Jour de diffusion' : 'OpenStudio · Votre espace', body }),
    text,
  };
}

module.exports = { accessDayEmail, firstName };
