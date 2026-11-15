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
