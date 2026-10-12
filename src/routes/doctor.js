import { Router } from 'express';
import { dbEnabled } from '../db/pool.js';
import { requireEntityToken } from '../middleware/requireEntityToken.js';
import {
  getDoctorByToken, getDoctorLeads, getDoctorLeadDetail, getDoctorMessageMedia, submitDoctorReview,
} from '../store/repository.js';

// Doctor Portal API — like partner.js, deliberately NOT behind PANEL_API_TOKEN:
// a reviewing doctor has no clinic-staff login, just their own long token
// (doctors.api_token, issued once by a coordinator when the doctor is added
// in the panel). Mounted at /api/doctor, before apiRouter.
export const doctorRouter = Router();

doctorRouter.use((req, res, next) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not configured' });
  next();
});

const requireDoctor = requireEntityToken({ lookup: getDoctorByToken, reqKey: 'doctor', entityLabel: 'doctor' });

doctorRouter.get('/leads', requireDoctor, (req, res) => {
  getDoctorLeads(req.doctor.id)
    .then((leads) => res.json({ doctor: { id: req.doctor.id, name: req.doctor.name }, leads }))
    .catch((err) => res.status(500).json({ error: err.message }));
});

doctorRouter.get('/leads/:leadId', requireDoctor, async (req, res) => {
  try {
    const detail = await getDoctorLeadDetail(req.doctor.id, req.params.leadId);
    if (!detail) return res.status(404).json({ error: 'Not found, or not assigned to you' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The photo itself — scoped to (doctor, lead, message) so one doctor can't
// pull another's patient's photo by guessing an id (see getDoctorMessageMedia).
doctorRouter.get('/leads/:leadId/media/:messageId', requireDoctor, async (req, res) => {
  try {
    const media = await getDoctorMessageMedia(req.doctor.id, req.params.leadId, req.params.messageId);
    if (!media) return res.status(404).json({ error: 'No media, or not assigned to you' });
    res.set('Content-Type', media.media_mime_type);
    res.send(media.media_data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

doctorRouter.put('/leads/:leadId/review', requireDoctor, async (req, res) => {
  const { status, note } = req.body || {};
  try {
    res.json(await submitDoctorReview(req.doctor.id, req.params.leadId, { status, note }));
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
});
