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
  check('(c) teklif + onay linki senaryosu var', /Onay linki/.test(html) && /quote-card|Teklif/i.test(html));
  check('(d) yanıt süresi (AI\\/insan, ortalama\\/medyan) paneli var',
    /İlk Yanıt Süresi/.test(html) && /medyan/i.test(html) && /AI/.test(html));
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
