// Koordinatör (insan) için AI yardımcıları: konuşma özeti + görev önerisi,
// yanıt taslağı, metin düzenleme. Hastaya HİÇBİR ŞEY GÖNDERMEZ — hepsi
// koordinatörün önüne taslak olarak düşer; göndermeyi insan yapar.
//
// AI konsiyerjin (concierge.js) kullandığı modeli ve aynı klinik profilini
// (fiyat/politika/güvenlik kuralları) kullanır; böylece Prompt Stüdyosu'nda
// yapılan değişiklikler burada da geçerli olur. Zorunlu tool_choice
// KULLANILMAZ (yeni model ailelerinde kaldırıldı); yapılandırılmış çıktı
// düz JSON olarak istenir ve toleranslı ayrıştırılır — ayrışmazsa uydurma
// bir şey döndürmek yerine hata verilir.
import Anthropic from '@anthropic-ai/sdk';
import { config, aiEnabled } from '../config.js';
import { getProfile } from './profile.js';
import { buildSystemPrompt } from './concierge.js';

const client = aiEnabled ? new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 22_000 }) : null;

export class AssistError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const MAX_TRANSCRIPT_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 600;

export function buildTranscript(messages) {
  return (messages || [])
    .filter((m) => m && m.content && !String(m.content).startsWith('[template:'))
    .slice(-MAX_TRANSCRIPT_MESSAGES)
    .map((m) => `${m.role === 'user' ? 'HASTA' : 'KLİNİK'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_CHARS)}`)
    .join('\n');
}

// Modelin döndürdüğü metinden ilk JSON nesnesini çıkarır (kod çiti ya da
// önsöz gelse bile). Bulunamazsa null.
export function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function textOf(resp) {
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function ask({ system, user, maxTokens = 1200 }) {
  if (!client) throw new AssistError('AI is not configured (ANTHROPIC_API_KEY).', 503);
  let resp;
  try {
    resp = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: maxTokens,
      // Düşünme KAPALI: yapılandırılmış kısa çıktıda düşünme tokenleri
      // max_tokens'ı yiyip JSON'u yarıda kesiyordu (ölçüldü: ~500-600 token)
      // ve gecikmeyi birkaç saniye artırıyordu.
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    throw new AssistError(`AI call failed: ${err.message}`, 502);
  }
  return { text: textOf(resp), usage: resp.usage || null };
}

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** Özet (Türkçe, koordinatöre) + önerilen sonraki adımlar. */
export async function summarizeConversation({ lead, messages }) {
  const transcript = buildTranscript(messages);
  if (!transcript) throw new AssistError('Conversation has no messages to summarize.', 400);
  const system =
    'Sen bir sağlık turizmi kliniğinin koordinatörüne yardım eden bir asistansın. ' +
    'Yalnızca konuşmada YAZANLARA dayan; olmayan bir bilgiyi (fiyat, tarih, tedavi, bütçe) ASLA uydurma. ' +
    'Tıbbi teşhis ya da tavsiye verme. Çıktı yalnızca geçerli JSON olsun, başka metin yazma.';
  const user =
    `Hasta kaydı: ${JSON.stringify({ ad: lead?.name || null, ulke: lead?.country || null, dil: lead?.language || null, tedavi: lead?.treatment_interest || null, butce: lead?.budget_hint || null, skor: lead?.score ?? null })}\n\n` +
    `Konuşma (eskiden yeniye):\n${transcript}\n\n` +
    'Şu JSON biçiminde cevap ver, Türkçe yaz:\n' +
    '{"summary":["en fazla 5 kısa madde: hasta ne istiyor, ne söylendi, açık kalan soru"],' +
    '"tasks":[{"title":"koordinatörün yapacağı somut iş (en fazla 8 kelime)","why":"konuşmadaki dayanağı (en fazla 14 kelime)"}]}\n' +
    'tasks 1 ila 4 öğe olsun. Hasta bir tıbbi sorun/acil durum bildirdiyse ilk görev bunun hemen insana yönlendirilmesi olsun.';
  const { text, usage } = await ask({ system, user, maxTokens: 1200 });
  const j = extractJson(text);
  if (!j || !Array.isArray(j.summary)) {
    console.error('[assist] unreadable summary, model output starts:', JSON.stringify(text.slice(0, 300)));
    throw new AssistError('AI returned an unreadable summary.', 502);
  }
  return {
    summary: j.summary.map((x) => clip(x, 240)).filter(Boolean).slice(0, 5),
    tasks: (Array.isArray(j.tasks) ? j.tasks : [])
      .map((t) => ({ title: clip(t?.title, 90), why: clip(t?.why, 140) }))
      .filter((t) => t.title).slice(0, 4),
    usage,
  };
}

/** Hastanın dilinde yanıt taslağı + Türkçe çeviri. Göndermez. */
export async function suggestReply({ lead, messages }) {
  const transcript = buildTranscript(messages);
  if (!transcript) throw new AssistError('Conversation has no messages to reply to.', 400);
  const profile = await getProfile();
  const system =
    buildSystemPrompt(profile) +
    '\n\n# YOUR ROLE RIGHT NOW\n' +
    'You are NOT talking to the patient. You are drafting ONE reply for a HUMAN coordinator, who will read and edit it before sending. ' +
    'Reply in the language the PATIENT is writing in. Follow every rule above (no diagnosis, no medical advice, no invented prices, no promised links). ' +
    'State ONLY facts that appear in the clinic profile above or in this conversation. Do NOT invent availability, free dates, how many slots are left, lead times, discounts, urgency or scarcity ("limited places", "2-3 weeks in advance"), and do not say the patient can upload something "here" unless the conversation already established it. ' +
    'If you do not know something, say the coordinator will confirm it. Keep the draft short (2-4 sentences). ' +
    'If the patient reports a complication or emergency, the draft must tell them to seek immediate in-person care and that the medical team is being alerted. ' +
    'Output ONLY valid JSON, no other text.';
  const user =
    `Conversation (oldest to newest):\n${transcript}\n\n` +
    'Return: {"language":"ISO code of the patient\'s language","reply":"the draft reply, plain text, no markdown","translation_tr":"Turkish translation of the draft for the coordinator"}';
  const { text, usage } = await ask({ system, user, maxTokens: 1200 });
  const j = extractJson(text);
  const reply = clip(j?.reply, 2000);
  if (!reply) {
    console.error('[assist] unreadable draft, model output starts:', JSON.stringify(text.slice(0, 300)), '| stop usage:', JSON.stringify(usage));
    throw new AssistError('AI returned an unreadable draft.', 502);
  }
  return { reply, translation_tr: clip(j?.translation_tr, 2000), language: clip(j?.language, 8) || lead?.language || null, usage };
}

const REWRITE_INSTRUCTIONS = {
  shorter: 'Make it shorter and clearer. Keep every fact.',
  warmer: 'Make the tone warmer and more reassuring. Keep every fact.',
  professional: 'Make the tone more formal and professional. Keep every fact.',
  fix: 'Fix spelling and grammar only. Do not change the meaning or the style.',
  translate: 'Translate it into the target language. Keep every fact and the tone.',
};
export const REWRITE_MODES = Object.keys(REWRITE_INSTRUCTIONS);

/** Koordinatörün kendi taslağını yeniden yazar / çevirir. Yeni bilgi eklemez. */
export async function rewriteText({ text, mode, targetLanguage }) {
  const body = clip(text, 2000);
  if (!body) throw new AssistError('Nothing to rewrite.', 400);
  if (!REWRITE_INSTRUCTIONS[mode]) throw new AssistError('Unknown mode.', 400);
  if (mode === 'translate' && !clip(targetLanguage, 40)) throw new AssistError('targetLanguage is required for translate.', 400);
  const system =
    'You edit short messages a clinic coordinator is about to send to a patient. ' +
    'NEVER add facts, prices, promises, links or medical statements that are not in the original. ' +
    'Output ONLY the rewritten message text: no quotes, no explanation, no markdown.';
  const user =
    `${REWRITE_INSTRUCTIONS[mode]}${mode === 'translate' ? ` Target language: ${clip(targetLanguage, 40)}.` : ' Keep the same language as the original.'}\n\nMessage:\n${body}`;
  const { text: out, usage } = await ask({ system, user, maxTokens: 1200 });
  const result = clip(out.replace(/^["“]|["”]$/g, ''), 2000);
  if (!result) throw new AssistError('AI returned an empty rewrite.', 502);
  return { text: result, usage };
}
