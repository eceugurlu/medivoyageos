-- Risk & Uyum maddesi düzeltmesi (16.11.2026 denetimi).
--
-- Resmî Gazete 32882'nin metni birebir doğrulandı: "7/24 çok dilli erişim"
-- (ve ona bağlı 'call_center_contract' belge türü) Madde 6/2-b ile ARACI
-- KURULUŞA aittir, SAĞLIK TESİSİNE (klinik) değil. Bu modül yalnızca klinik
-- skoru ürettiği için o madde YANLIŞ ATIFLIYDI ve kaldırıldı.
--
-- Yerine Madde 7/2'nin birebir karşılığı geldi: "Uluslararası sağlık
-- turizmi biriminde çalışan personelin en az birinin yabancı dil bilmesi
-- ve bunun belgelendirilmesi zorunludur." — bu SAĞLIK TESİSİNE ait,
-- 'foreign_language_staff' olarak eklendi.
--
-- Var olan 'call_center_contract' kayıtları SİLİNMİYOR, yeniden
-- adlandırılıyor: bir klinik o alana zaten bir şey yazmışsa (beyan), o
-- veri kaybolmasın — yalnızca artık doğru maddenin altında durur. Klinik
-- muhtemelen bunu yeniden gözden geçirmeli (eski beyan farklı bir konu
-- içindi) ama veri sessizce silinmiyor.

ALTER TABLE compliance_records DROP CONSTRAINT IF EXISTS compliance_records_kind_check;

UPDATE compliance_records SET kind = 'foreign_language_staff', updated_at = now()
  WHERE kind = 'call_center_contract';

ALTER TABLE compliance_records ADD CONSTRAINT compliance_records_kind_check
  CHECK (kind IN (
    'health_tourism_authorization',
    'accreditation',
    'complication_insurance',
    'kvkk_registry',
    'foreign_language_staff'
  ));
