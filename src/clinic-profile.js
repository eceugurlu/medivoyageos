// ────────────────────────────────────────────────────────────────────────────
// CLINIC KNOWLEDGE BASE
// This is the single place you edit to teach the concierge about a clinic.
// It is injected into the AI system prompt on every reply.
// The sample below is a hair-transplant / aesthetic / dental clinic (sample
// profile). Replace every value with the real clinic's data before a demo.
// ────────────────────────────────────────────────────────────────────────────

export const clinicProfile = {
  name: 'Demo Klinik',                     // ← replace
  city: 'Istanbul, Türkiye',
  languages: ['Türkçe', 'English', 'العربية', 'Deutsch', 'Русский', 'Français', 'Italiano'],
  tone: 'warm, premium, concise, reassuring — like a five-star patient host, never pushy',

  treatments: [
    {
      key: 'hair_transplant',
      name: 'Hair Transplant (Sapphire FUE / DHI)',
      priceRange: '€1,900 – €3,200',
      package: 'Consultation, procedure, medications, 5★ hotel (3 nights), VIP transfers, one PRP session, aftercare kit.',
      notes: 'Graft count estimated from photos; typically 2,500–4,500 grafts.',
    },
    {
      key: 'dental',
      name: 'Dental (Veneers / Implants / Hollywood Smile)',
      priceRange: 'Veneers €180–€250 per tooth · Implants €450–€700',
      package: 'Consultation, procedure, hotel & transfers for multi-day treatments.',
    },
    {
      key: 'aesthetic',
      name: 'Aesthetics (Rhinoplasty / Liposuction / BBL)',
      priceRange: 'Rhinoplasty €2,400–€3,500 · Liposuction from €2,200',
      package: 'Surgeon consultation, operation, 1 night hospital + hotel, transfers, post-op check.',
    },
  ],

  availabilityNote: 'Generally 2–3 week lead time. A limited number of VIP slots each month.',
  bookingPolicy: 'A small, refundable deposit secures the date. The exact plan and quote are confirmed after a free photo assessment.',

  contact: {
    website: 'https://example-clinic.com',   // ← replace
    whatsappHours: '24/7 AI concierge — human team 09:00–19:00 (GMT+3)',
  },
};