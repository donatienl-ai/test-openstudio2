'use strict';
/**
 * Contenu des e-mails du jour de diffusion (texte validé dans la fiche technique « Chaîne diffusion »).
 * Sert de secours tant que les modèles Mailjet de l'équipe communication ne sont pas créés : dès que
 * MJ_TPL_DIFFUSION_FIRST / MJ_TPL_DIFFUSION_NEXT / MJ_TPL_TEAM_ALERT sont renseignés, Mailjet utilise la
 * maquette avec les mêmes variables.
 *
 * Variables : prenom, entreprise, nom_emission, code, lien, date_expiration.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « 2027-01-03 » → « 3 janvier 2027 ». */
function dateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MOIS[Number(m[2]) - 1]} ${m[1]}` : '';
}

/** Ajoute n jours à une date AAAA-MM-JJ. */
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Prénom à partir du nom du contact (« Claire Dumas » → « Claire ») ; vide si inconnu. */
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

function layout(inner) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td style="background:#0f1f3d;color:#ffffff;padding:20px 28px;font-size:18px;font-weight:bold;border-radius:8px 8px 0 0">OpenStudio</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.55">${inner}</td></tr>
<tr><td style="padding:16px 28px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">L'équipe OpenMedias</td></tr>
</table></td></tr></table></body></html>`;
}

const hello = (v) => (v.prenom ? `Bonjour ${esc(v.prenom)},` : 'Bonjour,');

/** Premier mail : diffusion du jour, vidéo disponible, code de connexion, arguments, expiration des crédits. */
function diffusionFirst(v) {
  const subject = 'Votre émission est diffusée aujourd’hui';
  const html = layout(`<p>${hello(v)}</p>
<p>C’est le grand jour : votre passage dans <strong>${esc(v.nom_emission)}</strong> est diffusé aujourd’hui, et votre vidéo vous attend dès maintenant dans votre espace OpenStudio.</p>
<p style="background:#eef2ff;border-radius:6px;padding:14px 16px;font-size:16px">Votre code de connexion : <strong style="letter-spacing:1px">${esc(v.code)}</strong></p>
<p><a href="${esc(v.lien)}" style="display:inline-block;background:#0f1f3d;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">Accéder à mon espace</a></p>
<p><strong>Pourquoi utiliser OpenStudio ?</strong></p>
<ul style="padding-left:20px;margin:0 0 16px">
<li>Transformez votre émission en capsules courtes, prêtes pour LinkedIn, Instagram ou TikTok, en quelques clics.</li>
<li>Vos logos et vos sous-titres sont intégrés automatiquement, pour un rendu professionnel sans monteur.</li>
<li>Prolongez l’effet de votre passage TV : publiez des extraits sur vos réseaux et votre site pour renforcer votre crédibilité.</li>
</ul>
<p>Vos crédits inclus sont valables jusqu’au <strong>${esc(v.date_expiration)}</strong> (30 jours à partir d’aujourd’hui). Profitez-en pour créer vos premières vidéos.</p>`);
  const text = `${v.prenom ? `Bonjour ${v.prenom},` : 'Bonjour,'}

C'est le grand jour : votre passage dans ${v.nom_emission} est diffusé aujourd'hui, et votre vidéo vous attend dès maintenant dans votre espace OpenStudio.

Votre code de connexion : ${v.code}
Connectez-vous sur ${v.lien}

Pourquoi utiliser OpenStudio ?
- Transformez votre émission en capsules courtes, prêtes pour LinkedIn, Instagram ou TikTok, en quelques clics.
- Vos logos et vos sous-titres sont intégrés automatiquement, pour un rendu professionnel sans monteur.
- Prolongez l'effet de votre passage TV : publiez des extraits sur vos réseaux et votre site pour renforcer votre crédibilité.

Vos crédits inclus sont valables jusqu'au ${v.date_expiration} (30 jours à partir d'aujourd'hui). Profitez-en pour créer vos premières vidéos.

L'équipe OpenMedias`;
  return { subject, html, text };
}

/** Diffusions suivantes : la nouvelle vidéo est dans l'espace, avec le même code. */
function diffusionNext(v) {
  const subject = 'Votre nouvelle émission est en ligne';
  const html = layout(`<p>${hello(v)}</p>
<p>Votre passage dans <strong>${esc(v.nom_emission)}</strong> est diffusé aujourd’hui. La vidéo est déjà disponible dans votre espace OpenStudio, avec votre code habituel.</p>
<p><a href="${esc(v.lien)}" style="display:inline-block;background:#0f1f3d;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">Accéder à mon espace</a></p>`);
  const text = `${v.prenom ? `Bonjour ${v.prenom},` : 'Bonjour,'}

Votre passage dans ${v.nom_emission} est diffusé aujourd'hui. La vidéo est déjà disponible dans votre espace OpenStudio, avec votre code habituel : ${v.lien}

L'équipe OpenMedias`;
  return { subject, html, text };
}

/** Alerte à l'équipe : diffusions proches ou du jour encore incomplètes. items = [{ entreprise, emission, date, manque }] */
function teamAlert({ titre, intro, items }) {
  const rows = items.map((i) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(i.date)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(i.entreprise)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(i.emission)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#b45309">${esc(i.manque)}</td></tr>`).join('');
  const html = layout(`<p><strong>${esc(titre)}</strong></p><p>${esc(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;border-collapse:collapse">
<tr style="text-align:left;color:#6b7280"><th style="padding:6px 8px">Diffusion</th><th style="padding:6px 8px">Entreprise</th><th style="padding:6px 8px">Émission</th><th style="padding:6px 8px">Manque</th></tr>${rows}</table>`);
  const text = `${titre}\n\n${intro}\n\n${items.map((i) => `- ${i.date} · ${i.entreprise} · ${i.emission} : ${i.manque}`).join('\n')}`;
  return { subject: titre, html, text };
}

module.exports = { diffusionFirst, diffusionNext, teamAlert, dateFr, addDays, firstName };
