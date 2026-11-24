'use strict';
/**
 * E-mails de la séquence de relance et de commande (maquettes validées sur la planche « Mail du jour de diffusion »).
 * Pas encore branchés sur des déclencheurs : ils servent aux envois de test depuis le back-office (E-mails).
 *
 *  - Cas 1 · avis à J+30 (connecté + vidéo créée sous 2 jours)          → avisVideo
 *  - Cas 2 · relance 1 à J+2 (connecté, pas de vidéo)                     → relanceVideo1
 *  - Cas 2 · relance 2 à J+7 (toujours pas de vidéo)                      → relanceVideo2
 *  - Cas 3 · relance 1 à J+2 (pas connecté)                               → relanceConnexion1
 *  - Cas 3 · relance 2 à J+20 (toujours pas connecté, crédits expirent)   → relanceConnexion2
 *  - Commande · confirmation                                             → commandeConfirmee
 *  - Commande · avis à J+30                                              → avisCommande
 *
 * Mise en page en tableaux et styles en ligne (voir layout.js).
 */
const { layout, button, esc, asset, C, FONT, TITLE_FONT } = require('./layout');
const { firstName } = require('./accessDay');

const nb = (n) => Number(n).toLocaleString('fr-FR').replace(/\s/g, ' ');
const shortDate = (d) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
const B = (s) => `<b style="font-weight:600;color:${C.navy}">${s}</b>`;
const hello = (v) => { const f = firstName(v.name); return f ? `Bonjour ${esc(f)}` : 'Bonjour'; };
const helloText = (v) => { const f = firstName(v.name); return f ? `Bonjour ${f},` : 'Bonjour,'; };
/** « dans Smart Impact sur BFM Business » */
function where(v, html = true) {
  const p = v.programme, m = v.media;
  if (p && m && p !== m) return html ? `dans ${B(esc(p))} sur ${esc(m)}` : `dans ${p} sur ${m}`;
  if (p || m) return html ? `dans ${B(esc(p || m))}` : `dans ${p || m}`;
  return 'à l’antenne';
}

/* ------------------------------------------------------------------ blocs */

const row = (inner, top = 40, extra = '') => `<tr><td class="os-pad"${extra} style="padding:${top}px 40px 0;font-family:${FONT}">${inner}</td></tr>`;

function hero(eyebrow, title, intro) {
  return row(`${eyebrow ? `<div style="font-size:13px;color:${C.muted};padding-bottom:16px">${esc(eyebrow)}</div>` : ''}
  <h1 class="os-h1" style="margin:0;font-family:${TITLE_FONT};font-weight:700;font-size:34px;line-height:1.15;letter-spacing:-0.01em;color:${C.navy}">${title}</h1>
  <p style="margin:16px 0 0;font-size:16px;line-height:1.6;color:${C.text}">${intro}</p>`);
}

const h2 = (t) => `<h2 style="margin:0 0 18px;font-family:${TITLE_FONT};font-weight:800;font-size:22px;line-height:1.25;color:${C.navy}">${esc(t)}</h2>`;
const small = (html) => `<p style="margin:0;font-size:14px;line-height:1.6;color:${C.muted}">${html}</p>`;
const center = (html) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${html}</td></tr></table>`;

/** Bouton secondaire (contour bleu nuit). */
function button2(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
<td style="border-radius:999px;border:1px solid ${C.navy}"><a href="${esc(href)}" target="_blank" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;font-weight:500;line-height:1.2;color:${C.navy};text-decoration:none;border-radius:999px">${esc(label)}</a></td>
</tr></table>`;
}
/** Deux boutons côte à côte (empilés sur mobile). */
function buttons(a, b, { align = 'left' } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}"><tr>
<td class="os-stack" style="padding:0 12px 10px 0">${a}</td><td class="os-stack" style="padding:0 0 10px 0">${b}</td>
</tr></table>`;
}

/** Ligne discrète « 1 000 crédits disponibles, valables jusqu’au … ». */
function creditsLine(html) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
<td bgcolor="${C.ticketBg}" style="background:${C.ticketBg};border-radius:999px;padding:10px 18px 10px 12px;font-family:${FONT}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="30" valign="middle" style="width:30px"><div style="width:30px;height:30px;line-height:30px;border-radius:50%;background:${C.accent};color:#FFFFFF;text-align:center;font-size:14px;font-weight:700">+</div></td>
    <td valign="middle" style="padding-left:12px;font-size:14px;line-height:1.45;color:${C.navy}">${html}</td>
  </tr></table>
</td></tr></table>`;
}

const image = (name, alt) => `<img src="${asset(name)}" alt="${esc(alt)}" width="520" style="display:block;width:100%;height:auto;border:0;border-radius:12px">`;

/** Trois étapes côte à côte reliées par des flèches (empilées sur mobile, flèches masquées). */
function steps(items) {
  const cell = (it, i) => `<td class="os-stack os-step" valign="top" width="31%" bgcolor="#F2F4FB" style="width:31%;background:#F2F4FB;border-radius:14px;padding:18px 14px 20px;font-family:${FONT}">
  <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted}">Étape ${i + 1}</div>
  <div style="font-family:${TITLE_FONT};font-weight:700;font-size:16px;line-height:1.25;color:${C.navy};padding-top:8px">${esc(it[0])}</div>
  <div style="font-size:13px;line-height:1.5;color:${C.text};padding-top:6px">${esc(it[1])}</div>
</td>`;
  const arrow = `<td class="os-hide" width="30" align="center" valign="middle" style="width:30px"><div style="width:26px;height:26px;line-height:25px;border-radius:50%;background:${C.accent};color:#FFFFFF;text-align:center;font-size:14px;font-weight:700">&rarr;</div></td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
${cell(items[0], 0)}${arrow}${cell(items[1], 1)}${arrow}${cell(items[2], 2)}
</tr></table>`;
}

function testimonial() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#F7F8FC" style="background:#F7F8FC;border-left:3px solid ${C.accent};border-radius:0 12px 12px 0;padding:22px 24px;font-family:${FONT}">
  <p style="margin:0;font-size:17px;line-height:1.55;color:${C.navy}">« [Témoignage d’un client : ce que ses vidéos OpenStudio lui ont apporté.] »</p>
  <p style="margin:12px 0 0;font-size:13px;color:${C.muted}">[Prénom Nom], [Fonction], [Entreprise]</p>
</td></tr></table>`;
}

/** Cartes « Ce que vos crédits vous permettent » (une grande, deux petites). */
function benefits(link) {
  const card = (img, w, title, desc) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:12px;border-collapse:separate;overflow:hidden">
<tr><td style="padding:0;line-height:0"><a href="${esc(link)}" target="_blank"><img src="${asset(img)}" alt="${esc(title)}" width="${w}" style="display:block;width:100%;height:auto;border:0;border-radius:11px 11px 0 0"></a></td></tr>
<tr><td style="padding:18px 18px 20px;font-family:${FONT}">
  <div style="font-family:${TITLE_FONT};font-weight:700;font-size:16px;line-height:1.3;color:${C.navy}">${esc(title)}</div>
  <div style="font-size:14px;line-height:1.55;color:${C.text};padding-top:6px">${esc(desc)}</div>
</td></tr></table>`;
  return `${card('capsules.jpg', 518, 'Des capsules pour vos réseaux', 'Transformez votre émission en vidéos courtes pour LinkedIn, Instagram ou TikTok, en quelques clics.')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr>
  <td class="os-stack os-card-half" width="50%" valign="top" style="width:50%;padding-right:8px">${card('sous-titres.jpg', 250, 'Une image soignée', 'Logos et sous-titres intégrés automatiquement, sans monteur.')}</td>
  <td class="os-stack os-card-half-r" width="50%" valign="top" style="width:50%;padding-left:8px">${card('teaser.jpg', 250, 'Votre passage TV, prolongé', 'Publiez vos extraits sur vos réseaux et votre site pour renforcer votre crédibilité.')}</td>
</tr></table>`;
}

/** Billet « pass » : code d'accès à gauche, crédits à droite (talon clair ou bleu nuit). */
function ticket(v, { btn = 'Accéder à mon espace', label = 'crédits offerts', sub = 'Valables jusqu’au', date, dark = false } = {}) {
  const right = dark
    ? `bgcolor="${C.navy}" style="width:176px;background-color:${C.navy};background-image:linear-gradient(150deg,${C.navy} 0%,#1A2A9A 60%,${C.accent} 100%);padding:22px 18px 20px 22px;font-family:${FONT}"`
    : `bgcolor="${C.ticketBg}" style="width:176px;background:${C.ticketBg};border-left:2px dashed ${C.ticketDash};padding:22px 18px 20px 22px;font-family:${FONT}"`;
  const num = dark ? '#FFFFFF' : C.accent, lab = dark ? '#FFFFFF' : C.navy, sb = dark ? 'rgba(255,255,255,0.82)' : C.muted, st = dark ? '#FFFFFF' : C.navy;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.ticketLine};border-radius:18px;border-collapse:separate;overflow:hidden"><tr>
    <td class="os-tk-l" valign="middle" style="padding:22px 20px 20px 24px;font-family:${FONT}">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:${C.muted}">Votre code d’accès</div>
      <div class="os-code" style="font-family:${TITLE_FONT};font-weight:700;font-size:28px;line-height:1;letter-spacing:0.06em;white-space:nowrap;color:${C.navy};padding:14px 0 16px">${esc(v.code)}</div>
      ${button(v.link, btn, { small: true })}
      <div style="clear:both;font-size:12px;line-height:1.5;color:${C.muted};padding-top:12px">Le bouton vous connecte directement. Ce code vous est personnel.</div>
    </td>
    <td class="os-tk-r" width="176" valign="middle" ${right}>
      <div class="os-credits" style="font-weight:700;font-size:36px;line-height:1;letter-spacing:-0.02em;color:${num}">${nb(v.credits)}</div>
      <div style="font-family:${TITLE_FONT};font-weight:700;font-size:16px;color:${lab};padding-top:10px">${esc(label)}</div>
      ${date ? `<div style="font-size:12px;line-height:1.5;color:${sb};padding-top:14px">${esc(sub)}<br><b style="font-weight:600;color:${st}">${esc(date)}</b></div>` : ''}
    </td>
  </tr></table>`;
}

/** Bloc d'avis : 5 étoiles et bouton, tous vers la page Google d'OpenMedias. */
function rating(question, reviewUrl) {
  const star = `<td style="padding:0 4px"><a href="${esc(reviewUrl)}" target="_blank" style="display:inline-block;width:42px;height:42px;line-height:42px;border-radius:50%;background:#FFFFFF;border:1px solid ${C.line};text-align:center;font-size:22px;color:${C.accent};text-decoration:none">&#9733;</a></td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
<td bgcolor="${C.ticketBg}" align="center" style="background:${C.ticketBg};border-radius:12px;padding:28px 24px;font-family:${FONT}">
  <div style="font-family:${TITLE_FONT};font-weight:700;font-size:18px;color:${C.navy}">${esc(question)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:16px auto"><tr>${star.repeat(5)}</tr></table>
  ${button(reviewUrl, 'Laisser mon avis sur Google', { align: 'center' })}
  <div style="clear:both;font-size:13px;color:${C.muted};padding-top:14px">Votre avis est publié sur la page Google d’OpenMedias. Deux minutes suffisent.</div>
</td></tr></table>`;
}

function orderBox(o) {
  const line = (k, val) => `<tr><td style="padding:12px 0;border-top:1px solid ${C.line};font-size:14px;color:${C.muted}">${esc(k)}</td><td align="right" style="padding:12px 0;border-top:1px solid ${C.line};font-size:14px;font-weight:600;color:${C.navy}">${esc(val)}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:12px;border-collapse:separate"><tr><td style="padding:20px 24px 8px;font-family:${FONT}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding-bottom:14px;font-family:${TITLE_FONT};font-weight:700;font-size:16px;color:${C.navy}">Commande n° ${esc(o.ref)}</td>
        <td align="right" style="padding-bottom:14px"><span style="display:inline-block;font-size:12px;font-weight:600;color:#146C3A;background:#E6F6EC;border-radius:999px;padding:5px 12px">Confirmée</span></td></tr>
    ${line('Prestation', o.offer)}${line('Émission', o.programme)}${line('Montant', o.amount)}${line('Livraison estimée', o.delay)}
  </table>
</td></tr></table>`;
}

/** Suivi vertical : fait, en cours, à venir. */
function tracker(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items.map(([state, title, desc], i) => {
    const dot = state === 'done'
      ? `<div style="width:26px;height:26px;line-height:26px;border-radius:50%;background:${C.accent};color:#FFFFFF;text-align:center;font-size:14px;font-weight:700">&#10003;</div>`
      : state === 'now'
        ? `<div style="width:22px;height:22px;border-radius:50%;border:2px solid ${C.accent};background:#FFFFFF;text-align:center;line-height:22px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${C.accent};vertical-align:middle"></span></div>`
        : `<div style="width:22px;height:22px;border-radius:50%;border:2px solid ${C.line};background:#FFFFFF"></div>`;
    const badge = state === 'now' ? ` <span style="display:inline-block;font-family:${FONT};font-size:11px;font-weight:600;color:${C.accent};background:${C.ticketBg};border-radius:999px;padding:3px 9px;margin-left:6px;vertical-align:2px">En cours</span>` : '';
    const last = i === items.length - 1;
    return `<tr>
  <td width="26" valign="top" style="width:26px">${dot}${last ? '' : `<div style="width:2px;height:40px;margin:4px 0 0 12px;background:${state === 'done' ? C.accent : C.line}"></div>`}</td>
  <td valign="top" style="padding:3px 0 ${last ? 0 : 14}px 16px;font-family:${FONT}">
    <div style="font-family:${TITLE_FONT};font-weight:700;font-size:16px;color:${state === 'next' ? C.muted : C.navy}">${esc(title)}${badge}</div>
    <div style="font-size:14px;line-height:1.55;color:${C.text};padding-top:4px">${esc(desc)}</div>
  </td></tr>`;
  }).join('')}</table>`;
}

function wrap(subject, preheader, kicker, rows) {
  return layout({ title: subject, preheader, kicker, body: rows.join('\n') });
}
const textOf = (lines) => [...lines, '', 'Une question ? Répondez simplement à cet e-mail.', '', 'L’équipe OpenMedias'].join('\n');

/* ------------------------------------------------------------------ e-mails */

/** Cas 2 · relance 1 (J+2) : connecté, aucune vidéo créée. */
function relanceVideo1(v) {
  const subject = 'Votre première vidéo est à 3 clics';
  const until = shortDate(v.creditsUntil);
  const html = wrap(subject, 'Votre émission est déjà dans votre espace : créez votre première vidéo en quelques minutes.', 'OpenStudio · Vos premiers pas', [
    hero('Vos crédits vous attendent', 'Votre première vidéo est à 3&nbsp;clics.', `${hello(v)}, votre émission est déjà dans votre espace. Il ne manque plus que votre première vidéo : voici comment la créer en quelques minutes.`),
    row(creditsLine(`<b style="font-weight:700">${nb(v.credits)} crédits</b> disponibles, valables jusqu’au ${esc(until)}`), 24),
    row(image('espace.jpg', 'Votre espace OpenStudio'), 24),
    row(steps([['Choisissez l’extrait', 'Le passage de votre émission qui vous met en valeur.'], ['Choisissez le format', `Capsule, teaser ou sous-titres : ${nb(v.prices.capsules)} crédits.`], ['Publiez', 'Téléchargez et partagez sur vos réseaux ou votre site.']])
      + `<div style="height:18px;line-height:18px;font-size:0">&nbsp;</div>` + center(button(v.link, 'Créer ma première vidéo', { align: 'center' })), 28),
    row(h2('Témoignages') + testimonial()),
  ]);
  const text = textOf([helloText(v), '', 'Votre émission est déjà dans votre espace OpenStudio. Il ne manque plus que votre première vidéo :', '',
    '1. Choisissez l’extrait qui vous met en valeur.', `2. Choisissez le format : capsule, teaser ou sous-titres (${nb(v.prices.capsules)} crédits).`, '3. Téléchargez et partagez.', '',
    `${nb(v.credits)} crédits disponibles, valables jusqu’au ${until}.`, `Créer ma première vidéo : ${v.link}`]);
  return { subject, html, text };
}

/** Cas 2 · relance 2 (J+7) : toujours aucune vidéo. */
function relanceVideo2(v) {
  const subject = `Vos ${nb(v.credits)} crédits offerts n’attendent que vous`;
  const until = shortDate(v.creditsUntil);
  const html = wrap(subject, 'Transformez votre passage TV en vidéos pour vos réseaux.', 'OpenStudio · Votre passage TV', [
    hero(`Vos ${nb(v.credits)} crédits vous attendent`, 'Votre première vidéo est prête à être créée : lancez-vous.',
      `${hello(v)}, votre passage ${where(v)} est un contenu précieux. Transformé en vidéos courtes, il continue de convaincre vos clients et prospects bien après la diffusion.`),
    row(creditsLine(`<b style="font-weight:700">${nb(v.credits)} crédits</b> disponibles, valables jusqu’au ${esc(until)}`), 24),
    row(h2('Ce que vos crédits vous permettent') + benefits(v.link)),
    row(center(button(v.link, 'Utiliser mes crédits', { align: 'center' }) + `<div style="clear:both;height:12px;line-height:12px;font-size:0">&nbsp;</div>`
      + small(`Pas le temps ? Nos monteurs peuvent créer vos vidéos pour vous. <a href="${esc(v.orderUrl)}" target="_blank" style="color:${C.accent}">Commander un montage</a>`)), 32),
  ]);
  const text = textOf([helloText(v), '', `Votre passage ${where(v, false)} est un contenu précieux : transformé en vidéos courtes, il continue de convaincre vos clients et prospects.`, '',
    `${nb(v.credits)} crédits disponibles, valables jusqu’au ${until}.`, `Utiliser mes crédits : ${v.link}`, '', `Pas le temps ? Nos monteurs peuvent créer vos vidéos pour vous : ${v.orderUrl}`]);
  return { subject, html, text };
}

/** Cas 3 · relance 1 (J+2) : pas encore connecté. */
function relanceConnexion1(v) {
  const subject = 'Connectez-vous et créez vos premières vidéos';
  const until = shortDate(v.creditsUntil);
  const html = wrap(subject, `Votre code d’accès et vos ${nb(v.credits)} crédits offerts vous attendent.`, 'OpenStudio · Votre espace', [
    hero('Votre espace est prêt', 'Connectez-vous et créez vos premières vidéos.',
      `${hello(v)}, votre passage ${where(v)} est disponible dans votre espace OpenStudio depuis sa diffusion. Il ne vous reste plus qu’à vous connecter pour en tirer vos premières vidéos.`),
    row(ticket(v, { date: until }), 32),
    row(h2('Ce que vos crédits vous permettent') + benefits(v.link)),
    row(center(button(v.link, 'Utiliser mes crédits', { align: 'center' })), 28),
  ]);
  const text = textOf([helloText(v), '', `Votre passage ${where(v, false)} vous attend dans votre espace OpenStudio.`, '',
    `Votre code d’accès : ${v.code}`, `Pour vous connecter (le code est déjà rempli) : ${v.link}`, '', `${nb(v.credits)} crédits offerts, valables jusqu’au ${until}.`]);
  return { subject, html, text };
}

/** Cas 3 · relance 2 (J+20) : toujours pas connecté, les crédits expirent dans 10 jours. */
function relanceConnexion2(v) {
  const until = shortDate(v.creditsUntil);
  const subject = `Vos ${nb(v.credits)} crédits expirent dans 10 jours`;
  const html = wrap(subject, `Utilisez vos crédits avant le ${until}.`, 'OpenStudio · Vos crédits', [
    hero('Dernier rappel', esc(`Vos ${nb(v.credits)} crédits expirent dans 10 jours.`),
      `${hello(v)}, les crédits offerts avec votre passage ${where(v)} sont valables jusqu’au ${esc(until)}. Après cette date, ils ne pourront plus être utilisés : connectez-vous pour créer vos vidéos avant qu’il ne soit trop tard.`),
    row(ticket(v, { btn: 'Utiliser mes crédits', label: 'crédits à utiliser', sub: 'Expirent le', date: until }), 32),
    row(small('Votre espace reste ouvert après cette date : vous pourrez toujours recharger des crédits pour créer de nouvelles vidéos.'), 28),
  ]);
  const text = textOf([helloText(v), '', `Vos ${nb(v.credits)} crédits offerts sont valables jusqu’au ${until}. Après cette date, ils ne pourront plus être utilisés.`, '',
    `Votre code d’accès : ${v.code}`, `Utiliser mes crédits : ${v.link}`, '', 'Votre espace reste ouvert ensuite : vous pourrez toujours recharger des crédits.']);
  return { subject, html, text };
}

/** Cas 1 · avis à J+30 (connecté et vidéo créée). */
function avisVideo(v) {
  const f = firstName(v.name);
  const subject = f ? `Donnez-nous votre avis, ${f} !` : 'Donnez-nous votre avis !';
  const html = wrap(subject, 'Un clic suffit pour nous dire ce que vous pensez d’OpenStudio.', 'OpenStudio · Votre avis', [
    hero('Votre expérience OpenStudio', 'Donnez-nous votre avis !', `${hello(v)}, vous avez créé vos premières vidéos à partir de votre passage ${where(v)}. Nous aimerions savoir ce que vous en pensez.`),
    row(rating('Recommanderiez-vous OpenStudio ?', v.reviewUrl), 32),
    row(h2('Envie de continuer ?') + `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${C.muted}">Vos crédits offerts arrivent à échéance le ${esc(shortDate(v.creditsUntil))}. Vous pouvez recharger votre compte pour continuer à créer des vidéos, ou confier le montage à nos équipes.</p>`
      + buttons(button(v.link, 'Recharger mes crédits'), button2(v.orderUrl, 'Commander un montage'))),
  ]);
  const text = textOf([helloText(v), '', `Vous avez créé vos premières vidéos à partir de votre passage ${where(v, false)}. Nous aimerions savoir ce que vous en pensez.`, '',
    `Laisser votre avis sur Google : ${v.reviewUrl}`, '', `Recharger vos crédits : ${v.link}`, `Commander un montage : ${v.orderUrl}`]);
  return { subject, html, text };
}

/** Commande de montage · confirmation immédiate. */
function commandeConfirmee(v) {
  const o = v.order;
  const subject = 'Votre commande est confirmée';
  const html = wrap(subject, 'Nos monteurs travaillent sur vos vidéos.', 'OpenStudio · Commande confirmée', [
    hero('Commande confirmée', 'C’est lancé : vos vidéos sont en cours de montage.',
      `${hello(v)}, merci pour votre commande. Notre équipe de montage travaille dès maintenant à partir de votre passage ${where(v)}. Vous n’avez plus rien à faire.`),
    row(image('montage.jpg', 'Montage en cours'), 32),
    row(orderBox(o), 24),
    row(h2('Suivi de votre commande') + tracker([
      ['done', 'Commande confirmée', 'Aujourd’hui. Votre facture est disponible dans votre espace.'],
      ['now', 'Montage', 'Nos monteurs découpent, sous-titrent et habillent vos vidéos aux couleurs de votre marque.'],
      ['next', `Livraison ${o.delay}`, 'Vous recevez un e-mail dès que vos vidéos sont prêtes.'],
      ['next', 'Vos vidéos dans votre espace', 'Téléchargez-les et partagez-les où vous le souhaitez.'],
    ]) + `<div style="height:18px;line-height:18px;font-size:0">&nbsp;</div>` + center(buttons(button(o.url, 'Suivre ma commande'), button2(o.invoiceUrl, 'Voir ma facture'), { align: 'center' }))),
  ]);
  const text = textOf([helloText(v), '', 'Merci pour votre commande : notre équipe de montage travaille dès maintenant sur vos vidéos.', '',
    `Commande n° ${o.ref}`, `Prestation : ${o.offer}`, `Émission : ${o.programme}`, `Montant : ${o.amount}`, `Livraison estimée : ${o.delay}`, '',
    `Suivre ma commande : ${o.url}`, `Voir ma facture : ${o.invoiceUrl}`]);
  return { subject, html, text };
}

/** Commande de montage · avis à J+30. */
function avisCommande(v) {
  const subject = 'Vos vidéos vous ont plu ? Dites-le-nous !';
  const html = wrap(subject, 'Un clic suffit pour nous dire ce que vous pensez de vos vidéos.', 'OpenStudio · Votre avis', [
    hero(`Commande n° ${v.order.ref}`, 'Vos vidéos vous ont plu ? Dites-le-nous !',
      `${hello(v)}, nos monteurs ont réalisé vos vidéos à partir de votre passage ${where(v)}. Un clic suffit pour nous dire ce que vous en pensez.`),
    row(rating('Êtes-vous satisfait de vos vidéos ?', v.reviewUrl), 32),
    row(h2('Besoin d’autres vidéos ?') + `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${C.muted}">Nos monteurs peuvent réaliser de nouveaux formats à partir de votre émission, quand vous le souhaitez.</p>`
      + button(v.orderUrl, 'Commander un nouveau montage')),
  ]);
  const text = textOf([helloText(v), '', `Nos monteurs ont réalisé vos vidéos à partir de votre passage ${where(v, false)}. Un clic suffit pour nous dire ce que vous en pensez.`, '',
    `Laisser votre avis sur Google : ${v.reviewUrl}`, '', `Commander un nouveau montage : ${v.orderUrl}`]);
  return { subject, html, text };
}

/** « Code oublié ? » : le même code, renvoyé sur demande (maquette « Code oublié »). Version HTML seule : le texte reste dans client-access.js. */
function codeOublieHtml(v) {
  const subject = 'Votre code d’accès OpenStudio';
  const box = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>
<td bgcolor="${C.ticketBg}" align="center" style="background:${C.ticketBg};border-radius:12px;padding:28px 24px;font-family:${FONT}">
  <div style="font-size:14px;color:${C.muted}">Votre code d’accès personnel</div>
  <div class="os-code" style="font-family:${TITLE_FONT};font-weight:700;font-size:36px;line-height:1;letter-spacing:0.1em;color:${C.navy};padding:16px 0 18px">${esc(v.code)}</div>
  ${button(v.link, 'Accéder à mon espace', { align: 'center' })}
  <div style="clear:both;font-size:13px;color:${C.muted};padding-top:14px">Le bouton vous connecte directement. Ce code vous est personnel.</div>
</td></tr></table>`;
  return layout({ title: subject, preheader: `Votre code d’accès : ${v.code}`, kicker: 'OpenStudio · Votre code d’accès', body: [
    v.byTeam
      ? hero('Votre code d’accès', 'Voici votre code d’accès.', `${hello(v)}, voici votre code de connexion à votre espace OpenStudio${v.company ? ` (${esc(v.company)})` : ''}.`)
      : hero('Demande de code', 'Voici votre code d’accès.', `${hello(v)}, vous avez demandé à recevoir à nouveau votre code de connexion à OpenStudio${v.company ? ` (${esc(v.company)})` : ''}. Le voici.`),
    row(box, 32),
    row(small(v.byTeam ? 'Ce code vous est réservé : ne le transmettez pas en dehors de votre entreprise.' : 'Vous n’êtes pas à l’origine de cette demande ? Ignorez simplement cet e-mail : votre code ne change pas et votre espace reste protégé.'), 28),
  ].join('\n') });
}

module.exports = { codeOublieHtml, relanceVideo1, relanceVideo2, relanceConnexion1, relanceConnexion2, avisVideo, commandeConfirmee, avisCommande, ticket };
