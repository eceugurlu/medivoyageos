// Demo ortamı sayfası — statik doğruluk kontrolü. Ağ yok (sayfa zaten hiç
// fetch/XHR içermiyor — bu da testin bir parçası). Run: npm run check:demo-page
import { readFileSync } from 'node:fs';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};

const html = readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');

console.log('▶ Sayfa gerçekten salt-okunur ve izole');
{
  // Bu testin tüm amacı bu: demo sayfası GERÇEK API'ye veya DB'ye hiçbir
  // şekilde dokunmamalı. "fetch" veya "XMLHttpRequest" geçen tek bir satır
  // bile bu garantiyi bozar.
  check('fetch() hiç kullanılmıyor', !/\bfetch\s*\(/.test(html));
  check('XMLHttpRequest hiç ÇAĞRILMIYOR', !/new\s+XMLHttpRequest\s*\(/.test(html));
  check('/api/ yoluna hiç referans yok', !/["']\/api\//.test(html));
  check('form submit yok (yanlışlıkla bir yere veri gönderemez)', !/<form[\s>]/i.test(html));
  check('yer tutucu kalıntısı yok (${..._PLACEHOLDER})', !/PLACEHOLDER/.test(html));
  check('"DEMO" uyarı şeridi var', /demo ortamı/i.test(html));
  check('salt-okunur olduğunu açıkça söylüyor', /salt okunur/i.test(html));

  // Herhangi bir dış sunucuya İSTEK ATAN bir etiket yok — favicon'un
  // data: URI'si içindeki SVG xmlns="http://www.w3.org/2000/svg" bir ağ
  // isteği DEĞİL (asla fetch edilmez), o yüzden bilerek hariç tutuluyor.
  check('<link href="https?://..."> yok (örn. Google Fonts — eski bir dış bağımlılıktı, kaldırıldı)',
    !/<link[^>]+href=["']https?:/i.test(html));
  check('<img src="https?://..."> yok (örn. eski api.qrserver.com QR görseli)',
    !/<img[^>]+src=["']https?:/i.test(html));
  check('<script src="https?://..."> yok', !/<script[^>]+src=["']https?:/i.test(html));
  check('CSS @import ile dış kaynak çekilmiyor', !/@import/i.test(html));
  check('preconnect/dns-prefetch ile dış host ön-bağlantısı yok', !/rel=["'](preconnect|dns-prefetch)["']/i.test(html));
}

console.log('\n▶ "Este" / klinik adı sızıntısı yok (Demo Day Kesin Kural 3)');
{
  check('"Este" geçmiyor (klinik adı olarak — "estetik"/"destek" gibi sözcükler hariç)',
    !/este/i.test(html.replace(/estetik/gi, '').replace(/destek\w*/gi, '')));
  check('"Leon" geçmiyor', !/leon/i.test(html));
  check('demo kliniğinin adı "Demo Klinik" (A.Ş. yok)', /Demo Klinik/.test(html) && !/Demo Klinik\s*A\.?Ş\.?/i.test(html));
}

console.log('\n▶ Jüriye görünen metinde iç geliştirme notu / gerçeğe benzer tam isim yok');
{
  // Önce <style> ayıklanır: CSS yorumunda geçen "<script>" kelimesi aksi hâlde
  // sahte bir script başlangıcı gibi eşleşip sayfanın çoğunu yutuyordu.
  const visible = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  check('"Görev" (iç görev numarası) görünür metinde geçmiyor', !/Görev/.test(visible));
  check('kaynak dosya yolu (örn. services/x.js) görünür metinde geçmiyor', !/\w+\/\w+\.js\b/.test(visible));
  check('"n<5" gibi istatistik jargonu görünür metinde geçmiyor', !/n&lt;\d|n<\d/.test(visible));
  // Örnek doktorlar "Doktor A/B/C" — yaygın Ad Soyad gerçek bir hekimle çakışabilir (Kural 1).
  check('örnek doktor adları gerçek kişiye benzemiyor (Dr. Ad Soyad yok)', !/"Dr\. [A-ZÇĞİÖŞÜ][a-zçğıöşü]+ [A-ZÇĞİÖŞÜ][a-zçğıöşü]+"/.test(html));
}

console.log('\n▶ "Örnek veri" etiketi her bölümde görünür (Görev 4)');
{
  const sectionTitles = (html.match(/<div class="section-title"[^>]*>.*?<\/div>/gs) || []);
  check('en az 10 bölüm başlığı var', sectionTitles.length >= 10, sectionTitles.length);
  check('HER bölüm başlığında "Örnek veri" etiketi var (tek tek)',
    sectionTitles.every((t) => /demo-tag">Örnek veri</.test(t)),
    sectionTitles.filter((t) => !/demo-tag">Örnek veri</.test(t)));
  // 02/03 ekran görüntüleri tek tek .chat bloklarını kırpar (başlığın
  // DIŞINDA) — o yüzden etiket ayrıca HER sohbet balonunun içinde de olmalı.
  check('her iki örnek sohbet bloğu da (handover+skor, çeviri) KENDİ içinde "Örnek veri" taşıyor',
    /id="chatHandoverScore">\s*<div class="meta"><span class="demo-tag"[^>]*>Örnek veri</.test(html)
    && /id="chatTranslation">\s*<div class="meta"><span class="demo-tag"[^>]*>Örnek veri</.test(html));
}

console.log('\n▶ Görev 4\'ün 4 senaryosu sayfada gerçekten var');
{
  check('(a) Cuma 23:10 mesai-dışı mesaj + 09:00 devir anlatımı var',
    /23:10/.test(html) && /09:00/.test(html) && /mesai/i.test(html));
  check('(b) Almanca hasta cevabı + panelde Türkçe çeviri gösterimi var',
    /Guten Tag/.test(html) && /Türkçe çeviri/i.test(html));
  check('(c) teklif + teklif linki senaryosu var', /Teklif linki/.test(html) && /quote-card|Teklif/i.test(html));
  // Üründe hastanın tıklayıp onayladığı bir link YOK (api.js: "there is no online
  // accept flow yet") — kabulü koordinatör işaretler. Ekran bunu iddia etmemeli.
  check('olmayan "onay linki" akışı iddia edilmiyor', !/onay linki/i.test(html) && !/Hasta onayladı/.test(html));
  check('başkasına ait olabilecek uydurma alan adı (medivoyage.app) yok', !/medivoyage\.app/.test(html));
  check('"her sürümde otomatik test" iddiası yok (check:ai npm test içinde değil)', !/her sürümde/i.test(html));
  check('(d) yanıt süresi (AI\\/insan, ortalama\\/medyan) paneli var',
    /İlk Yanıt Süresi/.test(html) && /medyan/i.test(html) && /AI/.test(html));
}

console.log('\n▶ Slayt 3 ekranları: devir/güvenlik ve ameliyat sonrası takip');
{
  // Ekranda gösterilen 9 kural concierge.js'teki "HAND OVER TO A HUMAN" listesiyle
  // aynı sayıda olmalı — sayı değişirse ekran yalan söylemeye başlar.
  const concierge = readFileSync(new URL('../src/services/concierge.js', import.meta.url), 'utf8');
  const block = concierge.split('# HAND OVER TO A HUMAN')[1].split('\n# ')[0];
  const ruleCount = (block.match(/^- /gm) || []).length;
  const shown = ((html.match(/<ol class="rules">([\s\S]*?)<\/ol>/) || [])[1] || '').match(/<li/g) || [];
  check('ekrandaki devir kuralı sayısı concierge.js ile aynı', shown.length === ruleCount, { shown: shown.length, ruleCount });
  check('"9 devir kuralı" yazısı gerçek sayıyla uyumlu', !/\b9 devir kural/.test(html) || ruleCount === 9, ruleCount);
  check('devir bölümü var ve "Örnek veri" taşıyor', /id="shotHandover">\s*<div class="section-title">[^<]*<span class="demo-tag">Örnek veri</.test(html));
  check('AI\'ın devirde susmadığı, koordinatör devralınca sustuğu doğru anlatılıyor', /devraldığında AI tamamen susar/.test(html));
  // Ameliyat sonrası adımlar repository.js POST_OP_SEQUENCE ile aynı olmalı.
  const repo = readFileSync(new URL('../src/store/repository.js', import.meta.url), 'utf8');
  const days = [...repo.split('const POST_OP_SEQUENCE')[1].split('];')[0].matchAll(/days:\s*(\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const shownDays = [...new Set([...html.matchAll(/\["(\d+)\. gün"|\["1 yıl"/g)].map((m) => (m[1] ? Number(m[1]) : 365)))].sort((a, b) => a - b);
  check('ameliyat sonrası gün dizisi gerçek kodla aynı', JSON.stringify(days) === JSON.stringify(shownDays), { days, shownDays });
  check('ameliyat sonrası bölümü var ve "Örnek veri" taşıyor', /id="shotPostOp">\s*<div class="section-title">[^<]*<span class="demo-tag">Örnek veri</.test(html));
  check('kodda olmayan "fotoğraf talebi" adımı ekranda yok', !/fotoğraf talebi/i.test(html));
}

console.log('\n▶ Sahte veri kendi içinde tutarlı');
{
  check('<script> içinde gömülü veri dizileri var', /var INBOX = \[/.test(html) && /var CAMPAIGNS = \[/.test(html) && /var DOCTORS = \[/.test(html));
  // Gerçek üründe olmayan bir veri biçimi kullanmak demoyu yanıltıcı kılar.
  check('ROAS değeri olmayan kampanya "İZLENMİYOR" değil "0×" gösteriyor (gerçekten ölçülmüş, izlenmiyor değil)',
    /roas: 0/.test(html));
}

console.log('\n▶ HTML temel bütünlük');
{
  const opens = (html.match(/<div/g) || []).length;
  const closes = (html.match(/<\/div>/g) || []).length;
  check('<div> açılış/kapanış sayısı eşit', opens === closes, { opens, closes });
  check("esc() fonksiyonu tanımlı (XSS'e karşı — statik olsa da alışkanlık)", /function\s*\(\s*s\s*\)/.test(html) && /&amp;/.test(html));
  check('<title> var', /<title>[^<]+<\/title>/.test(html));
  check('noindex meta var (arama motorlarında görünmesin)', /name="robots" content="noindex"/.test(html));
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
