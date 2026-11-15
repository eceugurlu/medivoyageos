// Sean Ellis PMF sorusu hesabı — DB yok, ağ yok. Run: npm run check:pmf
import { summarizePmf, ANSWERS, MIN_RESPONSES, PMF_THRESHOLD_PCT } from '../src/services/pmfSurvey.js';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const rows = (...answers) => answers.map((a) => ({ answer: a }));

console.log('▶ Örneklem tabanı: az cevapla PMF kararı verilmez');
{
  const thin = summarizePmf(rows('very_disappointed', 'very_disappointed', 'not_disappointed'));
  check('enough=false', thin.enough === false, thin.total);
  check('signal null (ne var ne yok)', thin.signal === null);
  check('yüzdeler null, sayılar yine doğru', thin.shares.very_disappointed === null && thin.counts.very_disappointed === 2);

  const enough = summarizePmf(rows(...Array(5).fill('very_disappointed')));
  check('tam tabanda karar verilir', enough.enough === true);
  check('signal true (%100 >= %40)', enough.signal === true);
}

console.log('\n▶ Eşik tam sınırda');
{
  // 2/5 = %40 — eşiğe EŞİT, PMF VAR sayılmalı (>= , > değil).
  const exact = summarizePmf(rows('very_disappointed', 'very_disappointed', 'somewhat_disappointed', 'somewhat_disappointed', 'not_disappointed'));
  check('%40 tam eşikte signal true', exact.shares.very_disappointed === 40 && exact.signal === true, exact);

  const below = summarizePmf(rows('very_disappointed', 'somewhat_disappointed', 'somewhat_disappointed', 'somewhat_disappointed', 'not_disappointed'));
  check('%20 eşiğin altında signal false', below.shares.very_disappointed === 20 && below.signal === false, below);
}

console.log('\n▶ Geçersiz cevaplar paydaya girmez');
{
  const r = summarizePmf([...rows('very_disappointed', 'very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'not_disappointed'), { answer: 'bilmiyorum' }, { answer: null }, {}]);
  check('geçersizler ayrı sayılır', r.invalid === 3, r.invalid);
  check('toplam yalnızca geçerli cevaplar', r.total === 5, r.total);
  check('yüzdeler geçerli taban üzerinden (2/5=%40)', r.shares.very_disappointed === 40, r.shares);
}

console.log('\n▶ Yüzdeler toplamı %100');
{
  const r = summarizePmf(rows('very_disappointed', 'very_disappointed', 'very_disappointed', 'somewhat_disappointed', 'somewhat_disappointed', 'not_disappointed', 'not_disappointed'));
  const sum = r.shares.very_disappointed + r.shares.somewhat_disappointed + r.shares.not_disappointed;
  check('üç pay toplamı 100e çok yakın (yuvarlama payı)', Math.abs(sum - 100) < 0.5, sum);
}

console.log('\n▶ Sabitler uydurma değil, metodolojiden');
{
  check('taban 5', MIN_RESPONSES === 5, MIN_RESPONSES);
  check('eşik %40', PMF_THRESHOLD_PCT === 40, PMF_THRESHOLD_PCT);
  check('3 cevap seçeneği', ANSWERS.length === 3);
}

console.log('\n▶ Dayanıklılık');
{
  for (const bad of [undefined, null, 'metin', 42, {}, [null], [{}], [{ answer: 123 }]]) {
    let ok = true;
    try { summarizePmf(bad); } catch { ok = false; }
    check(`girdi ${JSON.stringify(bad)} → hata yok`, ok);
  }
  const empty = summarizePmf([]);
  check('boş girdide enough false, patlamaz', empty.enough === false && empty.signal === null);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
