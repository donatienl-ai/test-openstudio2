'use strict';
/**
 * Envoi d'e-mails par Mailjet (API Send v3.1), sans dépendance.
 * Mêmes garde-fous que l'ancien serveur : tant que MAIL_ALLOW_REAL_RECIPIENTS n'est pas à 1, tout part
 * vers MAIL_REDIRECT_TO (adresse de test) ; sans l'un ni l'autre, rien n'est envoyé.
 */
const config = require('./config');

class MailError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function problem(cfg = config.mail) {
  if (!cfg.apiKey || !cfg.secretKey || !cfg.fromEmail) {
    return 'Mailjet non configuré (MAILJET_API_KEY, MAILJET_SECRET_KEY, MAILJET_FROM_EMAIL).';
  }
  if (!cfg.redirectTo && !cfg.allowRealRecipients) {
    return 'Envoi réel désactivé : renseignez MAIL_REDIRECT_TO (tests) ou MAIL_ALLOW_REAL_RECIPIENTS=1.';
  }
  return null;
}

/**
 * Construit le message Mailjet. Avec templateId : modèle Mailjet + variables.
 * Sans : sujet + texte fournis (contenu de secours tant que le modèle n'est pas créé).
 */
function buildMessage({ to, subject, text, html, templateId, variables = {}, customId }, cfg = config.mail) {
  const redirected = Boolean(cfg.redirectTo);
  // Un destinataire, ou plusieurs (alertes à l'équipe) : [{ email, name }]
  const list = Array.isArray(to) ? to : [to];
  to = { ...list[0], email: list.map((x) => x.email).join(', ') }; // pour l'affichage en mode redirigé
  const msg = {
    From: { Email: cfg.fromEmail, Name: cfg.fromName },
    To: redirected ? [{ Email: cfg.redirectTo, Name: 'Test OpenStudio' }] : list.map((x) => ({ Email: x.email, ...(x.name ? { Name: x.name } : {}) })),
    CustomID: String(customId || ''),
    Variables: { ...variables, ...(redirected ? { destinataire_reel: to.email } : {}) },
  };
  if (templateId) {
    Object.assign(msg, { TemplateID: templateId, TemplateLanguage: true });
  } else {
    msg.Subject = `${redirected ? '[TEST] ' : ''}${subject}${redirected ? ` (pour ${to.email})` : ''}`;
    msg.TextPart = text;
    // E-mail mis en page (templates du dossier src/emails), sinon le texte simple en HTML minimal
    msg.HTMLPart = html || `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${esc(text)}</div>`;
  }
  return msg;
}

async function send(opts, { cfg = config.mail, fetchImpl = fetch, retries = 2 } = {}) {
  const p = problem(cfg);
  if (p) throw new MailError(p);
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.secretKey}`).toString('base64')}`;
  const body = JSON.stringify({ Messages: [buildMessage(opts, cfg)], ...(cfg.sandbox ? { SandboxMode: true } : {}) });
  for (let attempt = 0; ; attempt++) {
    let r;
    let data = null;
    try {
      r = await fetchImpl(cfg.apiUrl, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20000),
      });
      data = await r.json().catch(() => null);
    } catch (e) {
      if (attempt < retries) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
      throw new MailError('Mailjet injoignable', { retryable: true });
    }
    const m = data && data.Messages && data.Messages[0];
    if (r.ok && m && m.Status === 'success') {
      const t = (m.To && m.To[0]) || {};
      return { messageId: t.MessageID != null ? String(t.MessageID) : null, redirectedTo: cfg.redirectTo || null };
    }
    if ((r.status === 429 || r.status >= 500) && attempt < retries) {
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
      continue;
    }
    const detail = m && Array.isArray(m.Errors) && m.Errors.length
      ? m.Errors.map((e) => e.ErrorMessage || e.ErrorCode).join(' ; ')
      : (data && data.ErrorMessage) || `HTTP ${r.status}`;
    throw new MailError(`Mailjet : ${detail}`, { retryable: r.status === 429 || r.status >= 500 });
  }
}

module.exports = { send, buildMessage, problem, MailError };
