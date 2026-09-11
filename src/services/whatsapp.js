import { config, sendEnabled } from '../config.js';

/**
 * Send a plain text WhatsApp message via the Meta Cloud API.
 * If credentials aren't set, logs the message instead of sending (dry-run),
 * so you can exercise the full receive→reply pipeline without live Meta access.
 */
export async function sendText(to, body) {
  if (!sendEnabled) {
    console.log(`[whatsapp:dry-run] would send → ${to}: ${body}`);
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] send failed', res.status, JSON.stringify(data));
    throw new Error(`WhatsApp send failed: ${res.status}`);
  }
  return data;
}

/**
 * Send an APPROVED WhatsApp template message. Templates are the only way to
 * message a patient OUTSIDE the 24-hour customer-service window (re-engagement,
 * reminders, campaigns). The template must be pre-approved in the Meta dashboard;
 * here we just supply its name, language, and body variables ({{1}}, {{2}}, …).
 * Dry-run when credentials aren't set.
 *
 * @param {string} to           recipient in E.164 without '+'
 * @param {string} templateName approved template name
 * @param {string} langCode     template language (e.g. 'en')
 * @param {string[]} variables  ordered values for the body {{1}}, {{2}}, …
 */
export async function sendTemplate(to, templateName, langCode = 'en', variables = []) {
  const components = variables.length
    ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v) })) }]
    : [];

  if (!sendEnabled) {
    console.log(`[whatsapp:dry-run] would send TEMPLATE "${templateName}" → ${to} (vars: ${variables.join(', ') || 'none'})`);
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: langCode },
        ...(components.length ? { components } : {}),
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] template send failed', res.status, JSON.stringify(data));
    throw new Error(`WhatsApp template send failed: ${res.status}`);
  }
  return data;
}

/**
 * Send a document (a quote PDF, in practice) as a WhatsApp message by public
 * link. This only works inside Meta's 24-hour customer-service window — the
 * same constraint sendText has; outside it, use an approved template instead
 * (see sendTemplate). Dry-run when credentials aren't set, same as the rest
 * of this file.
 *
 * @param {string} to        recipient in E.164 without '+'
 * @param {string} url       a URL Meta's servers can fetch the PDF from
 * @param {string} filename  suggested filename on the patient's device
 * @param {string} caption   short message shown alongside the document
 */
export async function sendDocument(to, url, filename, caption) {
  if (!sendEnabled) {
    console.log(`[whatsapp:dry-run] would send DOCUMENT → ${to}: ${filename} (${url})`);
    return { dryRun: true };
  }

  const apiUrl = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: { link: url, filename, caption },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] document send failed', res.status, JSON.stringify(data));
    throw new Error(`WhatsApp document send failed: ${res.status}`);
  }
  return data;
}
