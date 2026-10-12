import { aiEnabled, sendEnabled } from '../config.js';
import { dbEnabled } from '../db/pool.js';
import { zohoEnabled } from './zoho.js';
import { transcriptionEnabled } from './audioTranscriber.js';
import { metaMessagingEnabled } from './metaMessaging.js';
import { checkAccessToken } from './whatsapp.js';

// The Workflow tab used to be a static list of nine "when X → then Y" claims.
// Every one of them is genuinely implemented, but four only actually run once a
// credential is in place (Zoho, Whisper, an approved WhatsApp template), and the
// page presented all nine identically — so a clinic could be shown an automation
// as live when nothing would happen. Each row now reports what it really needs
// and whether that is currently satisfied, which makes the same screen both an
// honest demo and the fastest way to see what is left to configure.
//
// `requires` is the list of conditions; a row is live only when all of them
// hold. `blockedBy` names the first unmet one, which is what the panel shows.
export async function getAutomationStatus() {
  const token = await checkAccessToken();
  // A configured-but-expired token is not a working send path, so the flag the
  // automations key off is "configured AND actually accepted by Meta". Unknown
  // (a failed check, not a failed token) is treated as configured, so a network
  // blip doesn't paint working automations as broken.
  const canSendWhatsApp = sendEnabled && token.ok !== false;

  const conditions = {
    ai: { ok: aiEnabled, label: 'ANTHROPIC_API_KEY' },
    db: { ok: dbEnabled, label: 'DATABASE_URL' },
    whatsappSend: { ok: canSendWhatsApp, label: sendEnabled ? 'a valid WhatsApp access token' : 'WhatsApp credentials' },
    inbound: { ok: sendEnabled || metaMessagingEnabled, label: 'a connected WhatsApp/Instagram channel' },
    zoho: { ok: zohoEnabled, label: 'Zoho CRM credentials' },
    whisper: { ok: transcriptionEnabled, label: 'OPENAI_API_KEY (voice transcription)' },
    // The scheduled sends go out as pre-approved WhatsApp templates. Whether a
    // given template is approved lives in Meta, not here, so this is reported
    // as a caveat on the row rather than silently assumed.
    templates: { ok: canSendWhatsApp, label: 'approved WhatsApp message templates', caveat: true },
  };

  const rows = [
    { key: 'auto.1', requires: ['inbound', 'ai'] },
    { key: 'auto.2', requires: ['ai', 'db'] },
    { key: 'auto.3', requires: ['ai', 'db'] },
    { key: 'auto.4', requires: ['zoho'] },
    { key: 'auto.5', requires: ['db'] },
    { key: 'auto.6', requires: ['db'] },
    { key: 'auto.7', requires: ['whatsappSend', 'templates'] },
    { key: 'auto.8', requires: ['whatsappSend', 'templates'] },
    { key: 'auto.9', requires: ['whisper', 'ai'] },
  ];

  return rows.map((r) => {
    const unmet = r.requires.filter((c) => !conditions[c].ok);
    const caveat = r.requires.some((c) => conditions[c].caveat && conditions[c].ok);
    return {
      key: r.key,
      live: unmet.length === 0,
      needsCheck: unmet.length === 0 && caveat,
      blockedBy: unmet.length ? conditions[unmet[0]].label : null,
    };
  });
}
