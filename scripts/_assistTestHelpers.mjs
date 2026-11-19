// Test yardımcısı: varsayılan klinik id'si (uygulamanın getDefaultClinicId'siyle aynı mantık).
export async function getClinicIdForTest(pool) {
  const r = await pool.query('SELECT id FROM clinics ORDER BY created_at LIMIT 1');
  if (!r.rows[0]) throw new Error('clinics tablosu boş');
  return r.rows[0].id;
}
