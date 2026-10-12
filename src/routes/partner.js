import { Router } from 'express';
import { dbEnabled } from '../db/pool.js';
import { requireEntityToken } from '../middleware/requireEntityToken.js';
import { getPartnerByToken, getPartnerDashboard } from '../store/repository.js';

// Partner Portal API — deliberately NOT behind PANEL_API_TOKEN (see api.js's
// apiRouter): a referral partner has no clinic-staff login. Each partner
// authenticates with their own long random token instead (partners.api_token,
// issued once by a coordinator when the partner is created in the panel).
// Mounted at /api/partner, before apiRouter, same reasoning as publicRouter.
export const partnerRouter = Router();

partnerRouter.use((req, res, next) => {
  if (!dbEnabled) return res.status(503).json({ error: 'Database not configured' });
  next();
});

const requirePartner = requireEntityToken({ lookup: getPartnerByToken, reqKey: 'partner', entityLabel: 'partner' });

partnerRouter.get('/dashboard', requirePartner, (req, res) => {
  getPartnerDashboard(req.partner.id)
    .then((data) => res.json(data))
    .catch((err) => res.status(500).json({ error: err.message }));
});
