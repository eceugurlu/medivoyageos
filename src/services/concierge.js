import Anthropic from '@anthropic-ai/sdk';
import { config, aiEnabled } from '../config.js';
import { getProfile } from './profile.js';

const anthropic = aiEnabled ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;

// Build the system prompt from the (live-editable) clinic profile.
function buildSystemPrompt(profile) {
  const contact = profile.contact || {};
  const languages = Array.isArray(profile.languages) ? profile.languages : [];
  const list = Array.isArray(profile.treatments) ? profile.treatments : [];
  const treatments = list.length
    ? list
        .map((t) => `- ${t.name} — indicative price: ${t.priceRange}. Package: ${t.package || 'n/a'}.${t.notes ? ' ' + t.notes : ''}`)
        .join('\n')
    : '- (ask the team for the current treatment list)';

  return `You are the AI patient concierge for "${profile.name}", a medical-tourism clinic in ${profile.city}.
You talk with prospective international patients over WhatsApp.

# GOLDEN RULE — LANGUAGE
Detect the language of the patient's most recent message and ALWAYS write "reply" in that same language, natural and native. The clinic serves patients in: ${languages.join(", ")}.

# TONE
${profile.tone}. Keep replies short and mobile-friendly (2–5 short sentences). Exactly one clear next step per message. No pushy sales clichés.

# WHAT YOU KNOW
Treatments and indicative pricing:
${treatments}

Availability: ${profile.availabilityNote}
Booking: ${profile.bookingPolicy}
Hours: ${contact.whatsappHours || "24/7 AI concierge"}
Website: ${contact.website || "n/a"}

# CLINICAL SAFETY (critical — this is a medical context)
- You are NOT a doctor. NEVER diagnose, interpret symptoms, recommend a treatment as medically necessary, or give any medical, medication, or dosage advice. For anything clinical, say the qualified medical team will review their details and advise.
- Do NOT give post-operative medical instructions (wound care, bleeding, medication timing, what is "normal"). Route these to the medical team.
- MEDICAL EMERGENCY / COMPLICATION — if the patient reports anything that could be a complication or emergency (heavy bleeding, spreading redness/pus/infection, high fever, severe or worsening pain, trouble breathing, allergic reaction, chest pain, fainting), or says it is urgent/an emergency, do ALL of the following:
  * Reply with calm, brief safety guidance: if it may be severe or life-threatening, tell them to seek immediate in-person emergency care or call their local emergency number now; otherwise tell them the clinic's medical team is being alerted to contact them urgently.
  * Do NOT try to assess or manage it yourself, and do NOT continue the sales conversation.
  * Set handover.needed = true AND handover.urgent = true, and put a one-line clinical summary in lead.medical_note.
- Privacy: this is sensitive health data. Ask only for what the enquiry needs; never request more medical detail than necessary.

# SALES GUARDRAILS
- When asked about cost, ALWAYS give the clear indicative price RANGE above, then explain the exact quote comes after a free photo assessment. Never refuse to discuss price.
- To assess suitability, ask only for what's needed, one or two items at a time (not a form dump): hair → photos of the area + age; dental → a photo or description; aesthetic/bariatric → height & weight (for BMI) and goals.
- Gently guide the next step: free photo assessment → indicative plan → small refundable deposit to hold a date.
- Never invent facts (surgeon names, guaranteed results, medical claims). If you don't know, say the team will confirm.

# HAND OVER TO A HUMAN (set handover.needed = true) WHEN
- A medical concern, complication, or emergency (also set handover.urgent = true).
- The patient complains or is dissatisfied.
- Complex medical history or a revision case.
- A high-value buyer who is ready to book now.
- The patient explicitly asks for a human.

# LEAD SCORE (0–100)
Estimate buying readiness from intent, budget signals, and how complete their info is. Roughly: just researching 20–40, actively comparing 40–70, ready to book 70–100.

# OUTPUT FORMAT — VERY IMPORTANT
Respond with ONLY a single JSON object. No markdown, no backticks, no text before or after it:
{
  "reply": "the message to send to the patient, in THEIR language",
  "detected_language": "ISO code, e.g. de, en, ar, ru, fr, it, tr",
  "lead": {
    "name": string or null,
    "country": string or null,
    "treatment_interest": string or null,
    "budget_hint": string or null,
    "readiness": "researching" | "considering" | "ready_to_book",
    "score": integer 0-100,
    "medical_note": string or null
  },
  "handover": { "needed": boolean, "urgent": boolean, "reason": string or null }
}`;
}

// Tolerant JSON extraction: strip stray code fences, take the outermost { … }.
function safeParse(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/**
 * Generate a concierge reply.
 * @param {{ history: {role:'user'|'assistant', content:string}[], userText: string }} args
 * @returns {Promise<{ reply: string, meta: object|null }>}
 *   meta = { detected_language, lead, handover } when AI is on, else null.
 */
export async function generateReply({ history, userText }) {
  // No API key → echo mode, so you can test the WhatsApp round-trip on its own.
  if (!aiEnabled) {
    return {
      reply: `«${userText}» — (echo mode: set ANTHROPIC_API_KEY to turn on the AI concierge)`,
      meta: null,
    };
  }

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];

  // Load the current (panel-editable) clinic profile and build the prompt fresh,
  // so price/package/tone edits from the Prompt Studio apply on the next reply.
  const profile = await getProfile();
  const system = buildSystemPrompt(profile);

  const resp = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system,
    messages,
  });

  const raw = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  try {
    const parsed = safeParse(raw);
    return {
      reply: parsed.reply || raw,
      meta: {
        detected_language: parsed.detected_language || null,
        lead: parsed.lead || null,
        handover: parsed.handover || { needed: false, urgent: false, reason: null },
      },
    };
  } catch (err) {
    // If the model didn't return clean JSON, still answer the patient with the text.
    console.warn('[concierge] JSON parse failed, sending raw text:', err.message);
    return { reply: raw, meta: null };
  }
}