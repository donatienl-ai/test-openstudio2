'use strict';
/**
 * Envoi d'e-mails par Mailjet (Send API v3.1), avec les mêmes garde-fous que le moteur d'e-mails de server/ :
 * - tant que MAIL_ALLOW_REAL_RECIPIENTS n'est pas à 1, tout part vers MAIL_REDIRECT_TO (adresse de test) ;
 * - modèle Mailjet si son identifiant est configuré (maquette de l'équipe communication), sinon contenu de
 *   secours généré ici, marqué [TEST] ;
 * - nouvel essai automatique si Mailjet est saturé (429) ou en panne (5xx).
 */
class MailError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

const backoff = (attempt) => Math.min(8000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
const errText = (m) => (m && Array.isArray(m.Errors) && m.Errors.length ? m.Errors.map((e) => e.ErrorMessage || e.ErrorCode).join(' ; ') : '');

function createMailjet({
  apiKey, secretKey, fromEmail, fromName = 'OpenMedias', redirectTo = '', allowRealRecipients = false,
  apiUrl = 'https://api.mailjet.com/v3.1/send', fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 3,
}) {
  const auth = 'Basic ' + Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

  /** message = { to: {email, name}, templateId?, variables, fallback: {subject, html, text}, customId } */
  function build({ to, templateId, variables = {}, fallback, customId }) {
    const realTo = redirectTo ? { Email: redirectTo, Name: 'Test OpenStudio' } : { Email: to.email, ...(to.name ? { Name: to.name } : {}) };
    const msg = { From: { Email: fromEmail, Name: fromName }, To: [realTo], CustomID: String(customId || '') };
    if (templateId) {
      Object.assign(msg, { TemplateID: Number(templateId), TemplateLanguage: true, Variables: { ...variables, ...(redirectTo ? { original_recipient: to.email } : {}) } });
    } else {
      msg.Subject = `${redirectTo || !allowRealRecipients ? '[TEST] ' : ''}${fallback.subject}${redirectTo ? ` (pour ${to.email})` : ''}`;
      msg.HTMLPart = fallback.html;
      msg.TextPart = fallback.text;
    }
    return msg;
  }

  async function send(message) {
    if (!apiKey || !secretKey || !fromEmail) throw new MailError('Mailjet non configuré (MAILJET_API_KEY, MAILJET_SECRET_KEY, MAILJET_FROM_EMAIL)');
    if (!redirectTo && !allowRealRecipients) throw new MailError('Envoi réel désactivé : renseignez MAIL_REDIRECT_TO (tests) ou MAIL_ALLOW_REAL_RECIPIENTS=1');
    const body = JSON.stringify({ Messages: [build(message)] });
    for (let attempt = 0; ; attempt++) {
      let r;
      let data = null;
      try {
        r = await fetchImpl(apiUrl, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body });
        data = await r.json().catch(() => null);
      } catch {
        if (attempt < retries) { await sleep(backoff(attempt)); continue; }
        throw new MailError('Mailjet injoignable', { retryable: true });
      }
      const m = data && data.Messages && data.Messages[0];
      if (r.ok && m && m.Status === 'success') {
        const to = (m.To && m.To[0]) || {};
        return { messageId: to.MessageID != null ? String(to.MessageID) : null, redirected: Boolean(redirectTo) };
      }
      if ((r.status === 429 || r.status >= 500) && attempt < retries) { await sleep(backoff(attempt)); continue; }
      throw new MailError(errText(m) || (data && data.ErrorMessage) || `Mailjet : HTTP ${r.status}`, { retryable: r.status === 429 || r.status >= 500 });
    }
  }

  return { send, build };
}

module.exports = { createMailjet, MailError };
