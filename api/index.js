import { app } from '../src/app.js';

// Vercel serverless entry. An Express app is itself a valid (req, res)
// handler, so exporting it directly is enough — no app.listen() here (Vercel
// owns the HTTP server) and no schedulers (see api/cron/*.js instead, driven
// by Vercel Cron rather than the setInterval timers src/server.js uses
// locally).
export default app;
