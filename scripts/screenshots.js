// Demo ortamının ekran görüntülerini alır (Görev 5). Run: node scripts/screenshots.js
//
// Yerel sunucuyu başlatır, public/demo.html'i (ve mobil görünüm için aynı
// sayfayı tekrar) 1920x1080 @2x Chromium ile açar, altı dosyayı
// screenshots/ altına yazar. Bu script GERÇEK bir tarayıcı başlatır —
// Playwright devDependency olarak eklidir (bkz. package.json); ilk
// çalıştırmadan önce `npx playwright install chromium` gerekir.
//
// ÖNEMLİ: Bu script sadece public/demo.html'i çeker — gerçek /panel (kimlik
// doğrulamalı, gerçek veritabanına bağlı) DEĞİL. demo.html zaten ağa hiç
// istek atmayan, sahte veri taşıyan statik bir sayfa (bkz.
// scripts/test-demo-page.mjs) — ekran görüntüleri bu güvenli yüzeyden alınır.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.SCREENSHOT_PORT || 4173);
const BASE = `http://localhost:${PORT}`;

mkdirSync(OUT_DIR, { recursive: true });

function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(url).then(() => resolve()).catch(() => {
        if (Date.now() > deadline) reject(new Error(`sunucu ${timeoutMs}ms içinde ayağa kalkmadı: ${url}`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function main() {
  console.log(`▶ Sunucu başlatılıyor (PORT=${PORT})...`);
  const server = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });
  server.on('exit', (code) => {
    if (code && code !== 0) console.error(`[server] beklenmedik çıkış (${code}):\n${serverLog}`);
  });

  try {
    await waitForServer(`${BASE}/panel/demo.html`);
    console.log('  ✓ sunucu hazır');

    const browser = await chromium.launch();
    const results = [];

    // ── Masaüstü: 1920x1080, deviceScaleFactor 2 ──
    const desktopCtx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
    });
    const page = await desktopCtx.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    // Gerçekten hiçbir dış/API isteği atılmadığını KANITLAMAK için tüm ağ
    // isteklerini logluyoruz — demo.html'in kendi başına verdiği söz bu.
    const requests = [];
    page.on('request', (req) => requests.push(req.url()));

    await page.goto(`${BASE}/panel/demo.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#inboxList .row');

    const shots = [
      { file: '01-gelen-kutusu.png', selector: '#shotInbox' },
      { file: '02-hasta-dilinde-yanit.png', selector: '#chatTranslation' },
      { file: '03-devir-lead-skoru.png', selector: '#chatHandoverScore' },
      { file: '04-teklif-onay.png', selector: '#shotQuote' },
      { file: '05-yanit-suresi.png', selector: '#shotResponseTime' },
    ];
    for (const s of shots) {
      const el = page.locator(s.selector);
      await el.scrollIntoViewIfNeeded();
      const outPath = path.join(OUT_DIR, s.file);
      await el.screenshot({ path: outPath });
      console.log(`  ✓ ${s.file}`);
      results.push({ file: s.file, selector: s.selector, path: outPath });
    }

    // ── Tam kare 1920x1080 (deviceScaleFactor 1 → dosya tam olarak 1920x1080
    // piksel): sunum slaytına doğrudan konabilen, tarayıcı çubuğu olmayan
    // görüntüler. Her bölüm görünümün en üstüne kaydırılıp yalnızca görünüm
    // (viewport) çekilir. ──
    const FRAME_DIR = path.join(OUT_DIR, '1920x1080');
    mkdirSync(FRAME_DIR, { recursive: true });
    const frameCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const framePage = await frameCtx.newPage();
    framePage.on('request', (req) => requests.push(req.url()));
    framePage.on('pageerror', (err) => consoleErrors.push(String(err)));
    await framePage.goto(`${BASE}/panel/demo.html`, { waitUntil: 'networkidle' });
    await framePage.waitForSelector('#inboxList .row');
    const frames = [
      { file: '01-gelen-kutusu.png', locate: (p) => p.locator('#shotInbox') },
      { file: '02-konusma-turkce-ceviri.png', locate: (p) => p.locator('#chatTranslation') },
      { file: '03-devir-handover.png', locate: (p) => p.locator('#chatHandoverScore') },
      { file: '04-teklif-onay.png', locate: (p) => p.locator('#shotQuote') },
      { file: '05-kpi-paneli.png', locate: (p) => p.locator('.section-title', { hasText: 'Komuta Merkezi' }) },
      { file: '06-risk-uyum.png', locate: (p) => p.locator('.section-title', { hasText: 'Risk' }) },
      { file: '07-yanit-suresi.png', locate: (p) => p.locator('#shotResponseTime') },
    ];
    for (const f of frames) {
      const el = f.locate(framePage).first();
      await el.evaluate((node) => window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 24));
      await framePage.waitForTimeout(150);
      const outPath = path.join(FRAME_DIR, f.file);
      await framePage.screenshot({ path: outPath });
      console.log(`  ✓ 1920x1080/${f.file}`);
      results.push({ file: `1920x1080/${f.file}`, selector: '(viewport 1920x1080)', path: outPath });
    }

    // ── Mobil: iPhone boyutlu görünüm, tüm sayfa (QR'ı telefonla okutan
    // kişinin gerçekte göreceği şey) ──
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileCtx.newPage();
    const mobileRequests = [];
    mobilePage.on('request', (req) => mobileRequests.push(req.url()));
    await mobilePage.goto(`${BASE}/panel/demo.html`, { waitUntil: 'networkidle' });
    await mobilePage.waitForSelector('#inboxList .row');
    const mobilePath = path.join(OUT_DIR, '06-demo-mobil.png');
    await mobilePage.screenshot({ path: mobilePath, fullPage: true });
    console.log('  ✓ 06-demo-mobil.png');
    results.push({ file: '06-demo-mobil.png', selector: '(full page, mobile viewport)', path: mobilePath });

    // ── Kanıt: hiç ağ isteği var mı (eski api.qrserver.com/Google Fonts
    // türünden dış çağrılar demo.html'den tamamen kaldırılmıştı) ──
    const allRequests = [...requests, ...mobileRequests];
    const external = allRequests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:'));
    writeFileSync(
      path.join(OUT_DIR, 'network-report.json'),
      JSON.stringify({ total_requests: allRequests.length, external_requests: external, all_requests: allRequests }, null, 2),
    );
    console.log(`\n▶ Ağ isteği raporu: toplam ${allRequests.length}, dış sunucuya giden ${external.length}`);
    if (external.length) {
      console.error('  ✗ DIŞ İSTEK BULUNDU:', external);
      process.exitCode = 1;
    } else {
      console.log('  ✓ demo.html gerçekten hiçbir dış sunucuya istek atmadı (yalnızca kendi sunucumuzdan dosya istekleri)');
    }
    if (consoleErrors.length) {
      console.error('  ✗ Tarayıcı konsolunda hata var:', consoleErrors);
      process.exitCode = 1;
    } else {
      console.log('  ✓ konsolda hata yok');
    }

    await browser.close();
    console.log(`\nTamamlandı: ${results.length} dosya yazıldı → ${OUT_DIR}`);
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
