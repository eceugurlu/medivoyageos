// Approved WhatsApp message templates (registry).
// In production these names + languages must match templates approved in your
// Meta Business dashboard. The `preview` here is just for the panel UI.
// Variables map to {{1}}, {{2}}, … in the template body, in order.

export const TEMPLATES = {
  reengagement: {
    name: 'reengagement',
    language: 'en',
    label: 'Re-engagement (past patients)',
    params: ['name'],
    preview: 'Hi {{1}}, it has been a while since we spoke! We now have new seasonal packages. Would you like an updated quote?',
  },
  hot_lead_followup: {
    name: 'hot_lead_followup',
    language: 'en',
    label: 'Hot-lead follow-up (gone silent)',
    params: ['name'],
    preview: 'Hi {{1}}, just checking in — your consultation details are still on file. Any questions before we go ahead? Happy to help whenever you are ready.',
  },
  appointment_reminder: {
    name: 'appointment_reminder',
    language: 'en',
    label: 'Appointment reminder',
    params: ['name', 'date'],
    preview: 'Hi {{1}}, this is a reminder about your consultation on {{2}}. Reply here if you need to reschedule.',
  },
  review_request: {
    name: 'review_request',
    language: 'en',
    label: 'Review request (post-op)',
    params: ['name'],
    preview: 'Hi {{1}}, we hope you are recovering well! Would you mind leaving us a quick review? It really helps.',
  },
  seasonal_offer: {
    name: 'seasonal_offer',
    language: 'en',
    label: 'Seasonal offer',
    params: ['name', 'offer'],
    preview: 'Hi {{1}}! For a limited time we are offering {{2}}. Interested? Reply here and our team will help.',
  },
};

// Render the preview text with actual variable values (for panel display/logs).
export function renderPreview(templateKey, variables = []) {
  const t = TEMPLATES[templateKey];
  if (!t) return '';
  let text = t.preview;
  variables.forEach((v, i) => {
    text = text.replaceAll(`{{${i + 1}}}`, v);
  });
  return text;
}

export function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({
    key,
    name: t.name,
    language: t.language,
    label: t.label,
    params: t.params,
    preview: t.preview,
  }));
}
