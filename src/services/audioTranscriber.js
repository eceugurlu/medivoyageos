// Voice-message transcription (OpenAI Whisper) for patients who send a
// WhatsApp voice note instead of typing. A separate provider from the
// concierge's own Anthropic key on purpose — Whisper is a narrow, cheap,
// single-purpose call, not a reason to route audio through a second LLM.
import { config } from '../config.js';

export const transcriptionEnabled = Boolean(config.openai.apiKey);

// Same reasoning as whatsapp.js's HTTP_TIMEOUT_MS (shared 30s Vercel function
// budget, and the same caveat: this is one of FOUR budgets a single voice
// note chains through in one invocation — downloadMedia, this, Claude, then
// the reply send — so it's kept as tight as Whisper's real processing time
// reasonably allows, not padded further "to be safe".
const HTTP_TIMEOUT_MS = 12_000;

/**
 * Transcribe one voice-note buffer to text.
 * @param {Buffer} buffer   raw audio bytes (as downloaded from WhatsApp)
 * @param {string} mimeType e.g. 'audio/ogg; codecs=opus' (WhatsApp's usual voice-note format)
 * @returns {Promise<string>} the transcribed text
 */
export async function transcribeAudio(buffer, mimeType) {
  if (!transcriptionEnabled) {
    throw new Error('OPENAI_API_KEY not set — voice transcription is disabled');
  }

  // WhatsApp voice notes are usually audio/ogg, but a forwarded (rather than
  // recorded) message can arrive as aac or amr — matching only mpeg/mp4 and
  // falling back to .ogg for everything else sent OpenAI a mislabeled file
  // for those, producing a spurious "could not be transcribed" fallback.
  const ext = mimeType?.includes('mpeg') ? 'mp3'
    : mimeType?.includes('mp4') ? 'm4a'
    : mimeType?.includes('aac') ? 'aac'
    : mimeType?.includes('amr') ? 'amr'
    : mimeType?.includes('wav') ? 'wav'
    : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), `voice-note.${ext}`);
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whisper] transcription failed', res.status, JSON.stringify(data));
    throw new Error(`Whisper transcription failed: ${res.status}`);
  }
  return data.text || '';
}
