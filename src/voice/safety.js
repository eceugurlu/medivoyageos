// Deterministic safety net for live voice calls — the FIRST line of defense,
// checked on every Deepgram interim transcript (not just the final one) so a
// danger phrase can interrupt mid-utterance. This is intentionally crude
// (keyword/regex, not an LLM call): it has to return in microseconds, not
// seconds, because it is what src/voice/session.js uses to decide whether to
// fire Twilio's `clear` event and cut off whatever the AI is in the middle of
// saying. The slower, smarter backstop for anything this list misses is
// brain.js's extractTurnSignal() — see docs/VOICE.md.
//
// NOT a replacement for concierge.js's CLINICAL SAFETY prompt rules (which
// still govern the full conversation and what the model itself decides to
// say) — this is a tripwire underneath them for the cases where a phone call
// can't afford to wait for a full model round-trip.
//
// Translations below are a first pass, not reviewed by native speakers —
// flagged explicitly per the plan's honesty requirement. Before the pilot
// goes live with real patients, a native speaker (or the clinic's own staff)
// for each language MUST review both the trigger phrases and the scripts.

const COMPLICATION_PATTERNS = {
  en: [/\bbleed(?:ing)?\b/i, /can'?t breathe/i, /trouble breathing/i, /infect(?:ion|ed)/i, /\bpus\b/i, /high fever/i, /allergic reaction/i, /chest pain/i, /faint(?:ed|ing)?/i, /severe pain/i],
  tr: [/\bkanama\b/i, /kan geliyor/i, /nefes alamıyorum/i, /nefes almakta zorlan/i, /enfeksiyon/i, /\biltihap\b/i, /yüksek ateş/i, /alerjik tepki/i, /göğüs ağrısı/i, /bayıl/i, /şiddetli ağrı/i],
  ar: [/نزيف/, /لا أستطيع التنفس/, /صعوبة في التنفس/, /عدوى/, /حمى شديدة/, /رد فعل تحسسي/, /ألم في الصدر/, /إغماء/, /ألم شديد/],
  de: [/\bblutung\b/i, /kann nicht atmen/i, /atemnot/i, /infektion/i, /\beiter\b/i, /hohes fieber/i, /allergische reaktion/i, /brustschmerzen/i, /ohnmächtig/i, /starke schmerzen/i],
  ru: [/кровотечение/i, /не могу дышать/i, /трудно дышать/i, /инфекция/i, /\bгно[йя]\b/i, /высокая температура/i, /аллергическая реакция/i, /боль в груди/i, /обморок/i, /сильная боль/i],
  fr: [/saignement/i, /je ne peux pas respirer/i, /difficulté[s]? à respirer/i, /infection/i, /\bpus\b/i, /forte fièvre/i, /réaction allergique/i, /douleur (?:thoracique|dans la poitrine)/i, /évanoui/i, /douleur (?:sévère|intense)/i],
  it: [/sanguinamento/i, /non riesco a respirare/i, /difficoltà a respirare/i, /infezione/i, /\bpus\b/i, /febbre alta/i, /reazione allergica/i, /dolore al petto/i, /svenut[oa]/i, /dolore (?:forte|intenso)/i],
  // Azerice (az) ve Kürtçe-Sorani (ku) — Azerbaycan ve Irak (Kürdistan
  // Bölgesi) doğrulanmış ilk-5 kaynak ülke. Diğer dillerle aynı dürüstlük:
  // ilk geçiş, ana dil konuşanı tarafından incelenmedi (üstteki nota bakın).
  az: [/qanaxma/i, /nəfəs ala bilmirəm/i, /nəfəs almaqda çətinlik/i, /infeksiya/i, /\birin\b/i, /yüksək hərarət/i, /allergik reaksiya/i, /sinə ağrısı/i, /huşunu itir/i, /şiddətli ağrı/i],
  ku: [/خوێن ڕشتنەوە/, /ناتوانم هەناسە بدەم/, /گرفت لە هەناسەدان/, /تووشبوون/, /پیو/, /تای بەرز/, /کنوشت[ی]?ی هەستیاری/, /ئازاری سنگ/, /لاڵبوونەوە/, /ئازاری توند/],
};

const CRISIS_PATTERNS = {
  en: [/want to die/i, /kill myself/i, /suicid(?:e|al)/i, /end my life/i, /don'?t want to (?:live|be alive)/i],
  tr: [/ölmek istiyorum/i, /kendimi öldür/i, /intihar/i, /yaşamak istemiyorum/i, /canıma kıy/i],
  ar: [/أريد أن أموت/, /أقتل نفسي/, /انتحار/, /لا أريد أن أعيش/],
  de: [/will sterben/i, /mich umbringen/i, /suizid/i, /nicht mehr leben/i],
  ru: [/хочу умереть/i, /покончить с собой/i, /суицид/i, /не хочу жить/i],
  fr: [/envie de mourir/i, /me suicider/i, /suicide/i, /ne veux plus vivre/i],
  it: [/voglio morire/i, /uccidermi/i, /suicid(?:io|arsi)/i, /non voglio più vivere/i],
  az: [/ölmək istəyirəm/i, /özümü öldür/i, /intihar/i, /yaşamaq istəmirəm/i],
  ku: [/دەمەوێت بمرم/, /خۆم بکوژم/, /خۆکوشتن/, /نامەوێت بژیم/],
};

// Pre-scripted, non-LLM lines — spoken verbatim the instant the net fires.
// Short on purpose: this has to be sayable while the rest of the pipeline
// (handover notification, coordinator assignment) happens in the background.
const COMPLICATION_SCRIPT = {
  en: "I'm sorry you're going through that. Please get emergency care right now or call your local emergency number, and our medical team is being alerted to contact you urgently.",
  tr: 'Bunu duyduğuma çok üzüldüm. Lütfen hemen bir acil servise başvurun veya 112\'yi arayın. Tıbbi ekibimiz de sizinle acil olarak iletişime geçmesi için şimdi bilgilendiriliyor.',
  ar: 'أنا آسف لما تعانيه. يرجى طلب الرعاية الطارئة فورًا أو الاتصال برقم الطوارئ المحلي لديك، وسيتم تنبيه فريقنا الطبي للتواصل معك بشكل عاجل.',
  de: 'Das tut mir sehr leid. Bitte suchen Sie jetzt sofort einen Notarzt auf oder rufen Sie Ihre lokale Notrufnummer an. Unser medizinisches Team wird ebenfalls benachrichtigt, um Sie dringend zu kontaktieren.',
  ru: 'Мне очень жаль это слышать. Пожалуйста, немедленно обратитесь за неотложной помощью или позвоните по местному номеру экстренной службы. Наша медицинская команда также получает уведомление, чтобы срочно связаться с вами.',
  fr: "Je suis désolé d'entendre cela. Veuillez consulter immédiatement les urgences ou appeler votre numéro d'urgence local. Notre équipe médicale est également alertée pour vous contacter en urgence.",
  it: 'Mi dispiace molto. La prego di rivolgersi immediatamente al pronto soccorso o di chiamare il numero di emergenza locale. Anche il nostro team medico viene avvisato per contattarla con urgenza.',
  az: 'Bunu eşitdiyimə çox üzüldüm. Zəhmət olmasa dərhal təcili yardıma müraciət edin və ya yerli təcili yardım nömrəsinə zəng edin. Tibbi komandamız da sizinlə təcili əlaqə saxlamaq üçün xəbərdar edilir.',
  ku: 'زۆر دڵگرانم بۆ ئەمە. تکایە دەستبەجێ پەیوەندی بە یارمەتی خێرا بکە یان ژمارەی یارمەتی خێرای ناوچەکەت بگرە، تیمی پزیشکیمان ئاگادار دەکرێنەوە تا پەلە پەیوەندیت پێوە بکەن.',
};

const CRISIS_SCRIPT = {
  en: "I hear you, and I'm really glad you told me. Please reach out to a crisis line or someone you trust right now — you don't have to go through this alone. Our team is also being alerted to reach you.",
  tr: 'Sizi dinliyorum ve bunu bana söylemenize gerçekten çok sevindim. Lütfen hemen bir kriz hattını veya güvendiğiniz birini arayın — bunu tek başınıza yaşamak zorunda değilsiniz. Ekibimiz de size ulaşmak için bilgilendiriliyor.',
  ar: 'أنا أسمعك، ويسعدني جدًا أنك أخبرتني بذلك. يرجى التواصل الآن مع خط أزمات أو شخص تثق به — لا يجب أن تمر بهذا وحدك. سيتم أيضًا تنبيه فريقنا للتواصل معك.',
  de: 'Ich höre Sie, und ich bin wirklich froh, dass Sie mir das erzählt haben. Bitte wenden Sie sich jetzt an eine Krisenhotline oder an jemanden, dem Sie vertrauen — Sie müssen das nicht allein durchstehen. Auch unser Team wird benachrichtigt, um Sie zu erreichen.',
  ru: 'Я вас слышу, и я действительно рад, что вы мне это сказали. Пожалуйста, обратитесь прямо сейчас на кризисную линию или к тому, кому вы доверяете — вам не нужно проходить через это одному. Наша команда также получает уведомление, чтобы связаться с вами.',
  fr: "Je vous entends, et je suis vraiment content que vous me le disiez. Contactez dès maintenant une ligne d'écoute ou une personne de confiance — vous n'avez pas à traverser cela seul. Notre équipe est également alertée pour vous contacter.",
  it: 'La sento, e sono davvero contento che me l\'abbia detto. La prego di contattare subito una linea di ascolto per le crisi o una persona di cui si fida — non deve affrontare questo da solo. Anche il nostro team viene avvisato per contattarla.',
  az: 'Sizi eşidirəm və bunu mənə dediyinizə həqiqətən sevindim. Zəhmət olmasa indi bir böhran xəttinə və ya etibar etdiyiniz birinə müraciət edin — bunu tək başınıza yaşamaq zorunda deyilsiniz. Komandamız da sizinlə əlaqə saxlamaq üçün xəbərdar edilir.',
  ku: 'گوێم لێت دەبێت، و زۆر دڵخۆشم کە ئەمەت پێ ڕاگەیاندم. تکایە ئێستا پەیوەندی بە هێڵی کرایسس یان کەسێک کە متمانەی پێیە بکە — پێویست ناکات ئەمە بە تەنها بەسەرببەیت. تیمەکەشمان ئاگادار دەکرێنەوە تا پەیوەندیت پێوە بکەن.',
};

const FALLBACK_LANG = 'en';

/**
 * Scan one piece of transcript text for a complication/crisis signal.
 * @returns {{ type: 'complication'|'crisis', matched: string } | null}
 */
export function scanForSafetySignal(text, lang) {
  if (!text) return null;
  const key = (lang || FALLBACK_LANG).toLowerCase().slice(0, 2);

  const complicationPatterns = COMPLICATION_PATTERNS[key] || COMPLICATION_PATTERNS[FALLBACK_LANG];
  for (const re of complicationPatterns) {
    const m = text.match(re);
    if (m) return { type: 'complication', matched: m[0] };
  }

  const crisisPatterns = CRISIS_PATTERNS[key] || CRISIS_PATTERNS[FALLBACK_LANG];
  for (const re of crisisPatterns) {
    const m = text.match(re);
    if (m) return { type: 'crisis', matched: m[0] };
  }

  return null;
}

/** The pre-scripted spoken line for a safety-net hit, with an English fallback. */
export function getSafetyScript(type, lang) {
  const key = (lang || FALLBACK_LANG).toLowerCase().slice(0, 2);
  const table = type === 'crisis' ? CRISIS_SCRIPT : COMPLICATION_SCRIPT;
  return table[key] || table[FALLBACK_LANG];
}

// Exported for scripts/simulate-call.mjs and unit tests — not meant for
// callers outside this module to depend on the exact pattern shapes.
export const _internal = { COMPLICATION_PATTERNS, CRISIS_PATTERNS, COMPLICATION_SCRIPT, CRISIS_SCRIPT };
