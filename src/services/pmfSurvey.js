// Sean Ellis PMF Sorusu — saf hesap.
//
// "Bu ürünü artık kullanamasaydınız ne hissederdiniz?" cevaplarından PMF
// skorunu çıkarır. Literatürdeki eşik sabit: "çok hayal kırıklığına
// uğrarım" oranı %40'ı geçerse güçlü sinyal sayılır — bu eşiği biz
// uydurmuyoruz, Sean Ellis'in kendi metodolojisinden alıyoruz.
//
// Aynı disiplin: ÖRNEKLEM YETERSİZSE SKOR YOK. 2 koordinatörün cevabından
// "%100 PMF var" çıkarmak, ölçüm değil gürültüdür.

export const ANSWERS = ['very_disappointed', 'somewhat_disappointed', 'not_disappointed'];

// Sean Ellis'in kendi testinde önerdiği taban budur; altında yüzde anlamsız.
export const MIN_RESPONSES = 5;
// Metodolojinin sabit eşiği — bizim seçimimiz değil.
export const PMF_THRESHOLD_PCT = 40;

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : null;
}

/**
 * @param {Array<{answer:string}>} responses
 */
export function summarizePmf(responses) {
  const rows = Array.isArray(responses) ? responses : [];
  const counts = { very_disappointed: 0, somewhat_disappointed: 0, not_disappointed: 0, invalid: 0 };
  for (const r of rows) {
    const a = r && r.answer;
    counts[ANSWERS.includes(a) ? a : 'invalid'] += 1;
  }
  const total = counts.very_disappointed + counts.somewhat_disappointed + counts.not_disappointed;
  const enough = total >= MIN_RESPONSES;
  const veryPct = pct(counts.very_disappointed, total);

  return {
    total,
    invalid: counts.invalid,
    min_responses: MIN_RESPONSES,
    enough,
    threshold_pct: PMF_THRESHOLD_PCT,
    counts: {
      very_disappointed: counts.very_disappointed,
      somewhat_disappointed: counts.somewhat_disappointed,
      not_disappointed: counts.not_disappointed,
    },
    shares: {
      very_disappointed: enough ? veryPct : null,
      somewhat_disappointed: enough ? pct(counts.somewhat_disappointed, total) : null,
      not_disappointed: enough ? pct(counts.not_disappointed, total) : null,
    },
    // signal null = henüz karar verilemez (örneklem az), yoksa true/false.
    signal: enough ? veryPct >= PMF_THRESHOLD_PCT : null,
  };
}
