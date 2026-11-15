// Dil Doğrulama Kontrolü — DB yok, ağ yok. Run: npm run check:lang
//
// Test seti, sistemin iddia ettiği TÜM dilleri kapsıyor (9): "7 dil"
// dediğimizde test 7'yi, "9 dil" dediğimizde 9'u kapsamalı — SUPPORTED_LANGS
// ile senkron kalması için aşağıda bir bütünlük kontrolü var.
import { detectLanguage, checkReplyLanguage, applyLanguageGuard, SUPPORTED_LANGS, MIN_WORDS, MIN_CHARS } from '../src/services/langCheck.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

// Her dilden, kısa bir AI cevabını andıran gerçek bir cümle. Hepsi
// MIN_WORDS/MIN_CHARS üstünde — asıl testin konusu bu cümlelerin doğru
// tanınması.
const SAMPLES = {
  en: 'Thank you for your message, we can schedule your consultation for next week.',
  tr: 'Mesajınız için teşekkür ederiz, danışmanızı önümüzdeki hafta için planlayabiliriz.',
  de: 'Vielen Dank für Ihre Nachricht, wir können Ihre Beratung für nächste Woche planen.',
  ar: 'شكرًا لرسالتك، يمكننا تحديد موعد استشارتك للأسبوع المقبل مع الفريق الطبي.',
  ru: 'Спасибо за ваше сообщение, мы можем запланировать вашу консультацию на следующую неделю.',
  fr: 'Merci pour votre message, nous pouvons programmer votre consultation pour la semaine prochaine.',
  it: 'Grazie per il suo messaggio, possiamo programmare la sua consulenza per la prossima settimana.',
  az: 'Mesajınız üçün təşəkkür edirik, konsultasiyanızı gələn həftəyə planlaşdıra bilərik.',
  ku: 'سوپاس بۆ پەیامەکەت، دەتوانین ژووانی تۆ بۆ هەفتەی داهاتوو ڕێکبخەین لەگەڵ تیمی پزیشکی.',
};

console.log('▶ Bütünlük: test seti SUPPORTED_LANGS ile senkron');
{
  check('örnek cümle sayısı SUPPORTED_LANGS ile eşit', Object.keys(SAMPLES).length === SUPPORTED_LANGS.length,
    { samples: Object.keys(SAMPLES).length, supported: SUPPORTED_LANGS.length });
  check('her desteklenen dil için örnek var', SUPPORTED_LANGS.every((l) => SAMPLES[l]),
    SUPPORTED_LANGS.filter((l) => !SAMPLES[l]));
}

console.log('\n▶ Her dil doğru tanınıyor (9/9)');
{
  for (const [lang, text] of Object.entries(SAMPLES)) {
    const r = detectLanguage(text);
    check(`[${lang}] "${text.slice(0, 30)}…" → ${lang} tanındı`, r.lang === lang && r.confidence === 'high', r);
  }
}

console.log('\n▶ Yazı sistemi katmanı');
{
  check('Kiril → ru (başka Kiril dili yok, ayrım gerekmez)', detectLanguage(SAMPLES.ru).script === 'cyrillic');
  check('Arapça yazı, Kürtçe harfi yok → ar', detectLanguage(SAMPLES.ar).script === 'arabic' && detectLanguage(SAMPLES.ar).lang === 'ar');
  check('Arapça yazı, Kürtçe-özel harf var → ku', detectLanguage(SAMPLES.ku).script === 'arabic' && detectLanguage(SAMPLES.ku).lang === 'ku');
}

console.log('\n▶ Azerice ↔ Türkçe en yakın çift — ə harfi kesin imza');
{
  check("'ə' içeren cümle her zaman az, Türkçe kelime olsa bile",
    detectLanguage('Bu məsələ çox önəmlidir və sizin üçün həll edəcəyik').lang === 'az');
  check('ə olmadan da Azerice bağlaçlarla (və, üçün) az tanınır',
    detectLanguage('Sizin üçün bu təklifi hazırladıq və göndəririk').lang === 'az');
  check('Türkçe kendine özgü bağlaçlarla (için, ile) tr tanınır',
    detectLanguage(SAMPLES.tr).lang === 'tr');
}

console.log('\n▶ Örneklem/belirsizlik tabanı: kısa metin UYDURULMAZ');
{
  const short = detectLanguage('Tamam');
  check('tek kelime → lang null, confidence low', short.lang === null && short.confidence === 'low', short);
  check("kısalık nedeni 'too_short'", short.reason === 'too_short');

  const empty = detectLanguage('');
  check('boş metin patlamaz, lang null', empty.lang === null);

  // MIN_CHARS/MIN_WORDS sınırının TAM ALTINDA kalan bir örnek.
  const belowWords = Array.from({ length: MIN_WORDS - 1 }, () => 'the').join(' ');
  check(`${MIN_WORDS - 1} kelime (taban altı) → too_short`, detectLanguage(belowWords).reason === 'too_short');
}

console.log('\n▶ checkReplyLanguage(): eşleşme / uyuşmazlık / bilinmiyor');
{
  const ok = checkReplyLanguage(SAMPLES.de, 'de');
  check("beklenen=de, tespit=de → 'ok'", ok.status === 'ok', ok);

  const mismatch = checkReplyLanguage(SAMPLES.fr, 'de');
  check("beklenen=de, tespit=fr → 'mismatch'", mismatch.status === 'mismatch', mismatch);
  check('tespit edilen dil raporda görünür', mismatch.detected.lang === 'fr');

  const noExpected = checkReplyLanguage(SAMPLES.en, null);
  check('beklenen dil yoksa karşılaştırma yapılmaz → unknown', noExpected.status === 'unknown' && noExpected.reason === 'no_expected_language');

  const unsupportedExpected = checkReplyLanguage(SAMPLES.en, 'xx');
  check('desteklenmeyen beklenen dil → unknown', unsupportedExpected.status === 'unknown');

  const lowConfReply = checkReplyLanguage('Ok, thanks!', 'de');
  check('kısa/belirsiz cevap → unknown, mismatch DEĞİL (alarm vermiyor)', lowConfReply.status === 'unknown', lowConfReply);

  // Büyük/küçük harf ve bölge varyantı (ör. "TR" ya da "tr-TR") normalize edilmeli.
  const normalized = checkReplyLanguage(SAMPLES.tr, 'TR');
  check("'TR' (büyük harf) 'tr' ile eşleşir", normalized.status === 'ok', normalized);
  const regionVariant = checkReplyLanguage(SAMPLES.de, 'de-DE');
  check("'de-DE' bölge varyantı 'de' ile eşleşir", regionVariant.status === 'ok', regionVariant);
}

console.log('\n▶ Karışık/yanlış pozitif riski taşıyan girdiler');
{
  // Sayı, isim, tarih gibi dil-bağımsız içerik tek başına yanlış bir dile
  // yönlendirmemeli — ya doğru tanınır ya da 'unknown' döner, asla rastgele.
  const mixed = detectLanguage('WhatsApp +90 212 000 00 00 2026-11-20');
  check('yalnızca sayı/sembol içeren metin bir dile zorlanmaz', mixed.lang === null || SUPPORTED_LANGS.includes(mixed.lang), mixed);
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, 42, {}, []]) {
    let ok1 = true, ok2 = true;
    try { detectLanguage(bad); } catch { ok1 = false; }
    try { checkReplyLanguage(bad, 'en'); } catch { ok2 = false; }
    check(`detectLanguage(${JSON.stringify(bad)}) → hata yok`, ok1);
    check(`checkReplyLanguage(${JSON.stringify(bad)}, 'en') → hata yok`, ok2);
  }
}


console.log('\n▶ applyLanguageGuard(): webhook.js entegrasyonu (Express/DB olmadan)');
{
  const FALLBACK = 'Thank you for your message — our team will get back to you shortly.';
  const baseMeta = { detected_language: 'de', lead: { score: 70 }, handover: { needed: false } };

  const matched = applyLanguageGuard({ reply: SAMPLES.de, meta: baseMeta, fallbackReply: FALLBACK });
  check('eşleşen dilde cevap AYNEN kalır', matched.reply === SAMPLES.de && matched.guarded === false, matched);
  check('eşleşince handover zorlanmaz', matched.meta.handover.needed === false);

  const mismatched = applyLanguageGuard({ reply: SAMPLES.fr, meta: baseMeta, fallbackReply: FALLBACK });
  check('uyuşmazlıkta cevap FALLBACK ile değişir', mismatched.reply === FALLBACK, mismatched);
  check('guarded=true raporlanır', mismatched.guarded === true);
  check('handover zorla needed=true, urgent=false olur',
    mismatched.meta.handover.needed === true && mismatched.meta.handover.urgent === false, mismatched.meta.handover);
  check('devir nedeni hangi dillerin karıştığını söylüyor',
    /expected de/.test(mismatched.meta.handover.reason) && /detected fr/.test(mismatched.meta.handover.reason),
    mismatched.meta.handover.reason);
  check('orijinal meta.lead korunur (kopyalanmadan kaybolmadı)', mismatched.meta.lead.score === 70);

  // AI çağrısı başarısız olduğunda webhook.js meta.detected_language'ı
  // null yapıyor — bu durumda guard hiçbir şeye DOKUNMAMALI, çünkü o yol
  // zaten kendi devrini (FALLBACK_REPLY + handover) kurmuş durumda.
  const aiFailedMeta = { detected_language: null, lead: null, handover: { needed: true, urgent: false, reason: 'AI could not answer' } };
  const onAiFailure = applyLanguageGuard({ reply: FALLBACK, meta: aiFailedMeta, fallbackReply: FALLBACK });
  check('AI zaten başarısızsa guard devreye girmez (guarded=false)', onAiFailure.guarded === false);
  check('mevcut handover nedeni DEĞİŞTİRİLMEZ', onAiFailure.meta.handover.reason === 'AI could not answer');

  // Kısa/belirsiz bir cevapta (çağrı başarılı ama cevap "Ok, thanks!" gibi)
  // guard ateşlenmemeli — iyi çalışan bir turu insana devretmemeli.
  const shortReply = applyLanguageGuard({ reply: 'Ok, thanks!', meta: baseMeta, fallbackReply: FALLBACK });
  check('kısa cevapta guard tetiklenmez', shortReply.guarded === false && shortReply.reply === 'Ok, thanks!', shortReply);

  const noMeta = applyLanguageGuard({ reply: SAMPLES.fr, meta: null, fallbackReply: FALLBACK });
  check('meta yoksa (ör. erken dönüş yolu) guard sessizce atlar', noMeta.guarded === false && noMeta.reply === SAMPLES.fr);
}
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
