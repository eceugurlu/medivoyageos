// Rakip cevap süresi araştırması — saf hesap.
//
// Girdi, benchmark_probes satırlarının ham hâli. Burada DB yok, ağ yok:
// oran ve medyan mantığı gerçek veri olmadan test edilebilsin diye.
//
// Tek kural, compliance.js'teki ile aynı: ÖRNEKLEM YETERSİZSE RAKAM YOK.
// 6 kliniğe mesaj atıp "sektör medyanı 4 saat" demek, araştırma gibi görünen
// bir tahmindir; jüriye de kliniğe de yanlış şey söyler.

// Bu süre geçtiği hâlde cevap gelmediyse "cevap vermedi" sayılır. Daha kısa
// bir eşik, mesai saatleri dışında atılmış bir mesajı haksızca cevapsız
// gösterirdi; 48 saat iki tam iş gününü kapsıyor.
export const NO_REPLY_CUTOFF_HOURS = 48;

// Altında medyan yayımlanmaz. Dağılım ve sayılar yine gösterilir —
// "9 klinikten 4'ü cevap vermedi" doğru bir cümle; "medyan 6 saat" değil.
export const MIN_SAMPLE = 10;

// Gece penceresi. Klinikler Türkiye'de, hasta yurt dışında: asıl mesele
// kliniğin kendi gecesinde cevap verip vermediği, o yüzden saat Türkiye
// saatiyle ölçülüyor.
export const NIGHT_FROM = 23;
export const NIGHT_TO = 7;
export const CLINIC_TZ = 'Europe/Istanbul';

const MIN_MS = 60 * 1000;

export const BUCKETS = [
  { key: 'u15m', label: '15 dk altı', maxMin: 15 },
  { key: 'u1h', label: '15 dk – 1 saat', maxMin: 60 },
  { key: 'u4h', label: '1 – 4 saat', maxMin: 240 },
  { key: 'u24h', label: '4 – 24 saat', maxMin: 1440 },
  { key: 'u48h', label: '24 – 48 saat', maxMin: 2880 },
];
export const NO_REPLY_BUCKET = { key: 'none', label: 'Hiç cevap yok' };

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value == null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Türkiye saatine göre saat dilimi (0-23). Çözülemezse null. */
export function clinicHour(value) {
  const d = toDate(value);
  if (!d) return null;
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone: CLINIC_TZ, hour: '2-digit', hour12: false,
    }).format(d);
    const n = Number(h);
    return Number.isFinite(n) ? n % 24 : null;
  } catch {
    return d.getUTCHours();
  }
}

export function isNightHour(hour) {
  if (hour == null) return false;
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

/**
 * Bir ölçümün durumu. 'pending' önemli: dün atılmış ve henüz cevaplanmamış
 * bir mesajı "cevap vermedi" saymak oranı kliniğin aleyhine bozardı.
 */
export function classifyProbe(probe, now = new Date()) {
  const sent = toDate(probe && probe.sent_at);
  if (!sent) return { status: 'invalid', minutes: null };
  const reply = toDate(probe && probe.first_reply_at);
  if (reply) {
    const minutes = (reply.getTime() - sent.getTime()) / MIN_MS;
    // Negatif fark veri hatasıdır; sessizce 0'a çekmek yerine geçersiz sayılır.
    return minutes < 0 ? { status: 'invalid', minutes: null } : { status: 'replied', minutes };
  }
  const waited = (toDate(now).getTime() - sent.getTime()) / MIN_MS;
  return waited >= NO_REPLY_CUTOFF_HOURS * 60
    ? { status: 'no_reply', minutes: null }
    : { status: 'pending', minutes: null };
}

export function bucketFor(minutes) {
  for (const b of BUCKETS) if (minutes <= b.maxMin) return b.key;
  return 'u48h'; // 48 saatten uzun ama cevap gelmiş: en üst kovaya girer
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * @param {Array} probes benchmark_probes satırları
 * @param {{now?:Date, ourMedianSeconds?:number|null, ourSamples?:number}} opts
 */
export function summarizeProbes(probes, opts = {}) {
  const now = toDate(opts.now) || new Date();
  const rows = Array.isArray(probes) ? probes : [];

  const counts = { replied: 0, no_reply: 0, pending: 0, invalid: 0 };
  const minutes = [];
  const buckets = Object.fromEntries([...BUCKETS, NO_REPLY_BUCKET].map((b) => [b.key, 0]));
  const byChannel = new Map();
  const night = { sent: 0, replied: 0 };
  const day = { sent: 0, replied: 0 };

  for (const p of rows) {
    const { status, minutes: m } = classifyProbe(p, now);
    counts[status] = (counts[status] || 0) + 1;
    if (status === 'invalid') continue;

    if (status === 'replied') { minutes.push(m); buckets[bucketFor(m)] += 1; }
    if (status === 'no_reply') buckets.none += 1;

    const ch = p.channel || 'bilinmiyor';
    if (!byChannel.has(ch)) byChannel.set(ch, { channel: ch, sent: 0, replied: 0, minutes: [] });
    const c = byChannel.get(ch);
    // 'pending' hiçbir orana girmez: henüz sonucu belli değil.
    if (status !== 'pending') {
      c.sent += 1;
      const window = isNightHour(clinicHour(p.sent_at)) ? night : day;
      window.sent += 1;
      if (status === 'replied') { c.replied += 1; c.minutes.push(m); window.replied += 1; }
    }
  }

  minutes.sort((a, b) => a - b);
  const settled = counts.replied + counts.no_reply;
  const enough = settled >= MIN_SAMPLE;

  const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

  const ourSeconds = opts.ourMedianSeconds == null ? null : Number(opts.ourMedianSeconds);
  const sectorMedian = enough ? percentile(minutes, 0.5) : null;

  return {
    sample: {
      total: rows.length,
      settled,            // sonucu belli olanlar — oranların paydası
      replied: counts.replied,
      no_reply: counts.no_reply,
      pending: counts.pending,
      invalid: counts.invalid,
      min_sample: MIN_SAMPLE,
      enough,
      cutoff_hours: NO_REPLY_CUTOFF_HOURS,
    },
    // enough false ise medyan/çeyreklik NULL. Sayılar yine doğru ve gösterilir.
    median_minutes: round1(sectorMedian),
    p25_minutes: enough ? round1(percentile(minutes, 0.25)) : null,
    p75_minutes: enough ? round1(percentile(minutes, 0.75)) : null,
    no_reply_rate: rate(counts.no_reply, settled),
    buckets: [...BUCKETS, NO_REPLY_BUCKET].map((b) => ({
      key: b.key, label: b.label, n: buckets[b.key],
      share: rate(buckets[b.key], settled),
    })),
    night: { ...night, reply_rate: rate(night.replied, night.sent) },
    day: { ...day, reply_rate: rate(day.replied, day.sent) },
    by_channel: [...byChannel.values()]
      .map((c) => {
        c.minutes.sort((a, b) => a - b);
        return {
          channel: c.channel, sent: c.sent, replied: c.replied,
          reply_rate: rate(c.replied, c.sent),
          // Kanal kırılımında da aynı taban: 3 ölçümlü bir kanalın medyanı yok.
          median_minutes: c.minutes.length >= MIN_SAMPLE ? round1(percentile(c.minutes, 0.5)) : null,
        };
      })
      .sort((a, b) => b.sent - a.sent),
    ours: {
      median_seconds: ourSeconds,
      samples: Number(opts.ourSamples || 0),
      // Kat farkı yalnızca İKİ taraf da ölçülmüşse hesaplanır. Tek taraflı
      // bir "x kat hızlıyız" rakamı, kıyaslama değil reklam olurdu.
      times_faster: sectorMedian != null && ourSeconds != null && ourSeconds > 0
        ? Math.round((sectorMedian * 60) / ourSeconds)
        : null,
    },
  };
}

export const CHANNELS = ['whatsapp', 'instagram', 'web_form', 'phone', 'email'];
