// Client Mailjet Send API v3.1 : envoi avec template (TemplateID + Variables), tag CustomID, retries.
// Doc : https://dev.mailjet.com/docs/email-api/send-api-v31/use-template.md, …/tag-email-messages.md,
//       …/group-campaign.md (DeduplicateCampaign), …/email-api-overview/rate-limits.md (429 : backoff + jitter).
import { TEMPLATES, templateId, renderFallback } from './emailTemplates.js';

export class MailError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) { super(message); this.retryable = retryable; this.status = status; }
}

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createMailjet({
  apiKey, secretKey, fromEmail, fromName = 'OpenMedias', sandbox = false,
  redirectTo = '', allowRealRecipients = false, errorReportTo = '',
  apiUrl = 'https://api.mailjet.com/v3.1/send', env = process.env, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), retries = 3, log
}) {
  const auth = 'Basic ' + Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

  function buildMessage({ templateKey, to, variables = {}, customId, headers }) {
    const t = TEMPLATES[templateKey]; if (!t) throw new MailError(`template inconnu : ${templateKey}`);
    // Pendant les tests, tous les envois partent vers l'adresse de test (MAIL_REDIRECT_TO).
    const realTo = redirectTo ? { Email: redirectTo, Name: 'Test OpenStudio' } : { Email: to.email, ...(to.name ? { Name: to.name } : {}) };
    const vars = { ...variables, ...(redirectTo ? { original_recipient: to.email } : {}) };
    const msg = { From: { Email: fromEmail, Name: fromName }, To: [realTo], CustomID: String(customId || ''), Variables: vars };
    const id = templateId(templateKey, env);
    if (id) {
      Object.assign(msg, { TemplateID: id, TemplateLanguage: true });
      if (errorReportTo) msg.TemplateErrorReporting = { Email: errorReportTo };
    } else {
      // Template pas encore créé : contenu texte de secours, clairement marqué.
      const f = renderFallback(templateKey, vars);
      msg.Subject = `[TEST] ${f.subject}${redirectTo ? ` (pour ${to.email})` : ''}`;
      msg.TextPart = f.text; msg.HTMLPart = `<pre style="font-family:sans-serif;white-space:pre-wrap">${escHtml(f.text)}</pre>`;
    }
    if (t.campaign) Object.assign(msg, { CustomCampaign: t.campaign, DeduplicateCampaign: true }); // filet anti-doublon côté Mailjet
    if (headers) msg.Headers = headers;
    return msg;
  }

  async function send(opts) {
    if (!apiKey || !secretKey || !fromEmail) throw new MailError('Mailjet non configuré (MAILJET_API_KEY, MAILJET_SECRET_KEY, MAILJET_FROM_EMAIL).');
    if (!redirectTo && !allowRealRecipients) throw new MailError('Envoi réel désactivé : renseignez MAIL_REDIRECT_TO (tests) ou MAIL_ALLOW_REAL_RECIPIENTS=1.');
    const body = { Messages: [buildMessage(opts)], ...(sandbox ? { SandboxMode: true } : {}) };
    for (let attempt = 0; ; attempt++) {
      let r, data = null;
      try {
        r = await fetchImpl(apiUrl, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        try { data = await r.json(); } catch (e) {}
      } catch (e) {
        if (attempt < retries) { await sleep(backoff(attempt)); continue; }
        throw new MailError('Mailjet injoignable', { retryable: true });
      }
      if (r.ok) {
        const m = data && data.Messages && data.Messages[0];
        if (!m || m.Status !== 'success') throw new MailError(errText(m) || 'réponse Mailjet inattendue');
        const to = (m.To && m.To[0]) || {};
        return { messageId: to.MessageID != null ? String(to.MessageID) : null, sandbox: !!sandbox };
      }
      if ((r.status === 429 || r.status >= 500) && attempt < retries) { await sleep(backoff(attempt)); continue; }
      const m = data && data.Messages && data.Messages[0];
      throw new MailError(errText(m) || (data && data.ErrorMessage) || `HTTP ${r.status}`, { retryable: r.status === 429 || r.status >= 500, status: r.status });
    }
  }
  return { send, buildMessage };
}

// Attente exponentielle avec variation aléatoire (recommandation Mailjet pour les 429).
export const backoff = attempt => Math.min(8000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
const errText = m => m && Array.isArray(m.Errors) && m.Errors.length ? m.Errors.map(e => e.ErrorMessage || e.ErrorCode).join(' ; ') : '';
