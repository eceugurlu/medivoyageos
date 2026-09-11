import express from 'express';
import { config, aiEnabled, sendEnabled } from './config.js';
import { dbEnabled } from './db/pool.js';
import { zohoEnabled } from './services/zoho.js';
import { notifyEnabled } from './services/notify.js';
import { webhookRouter } from './routes/webhook.js';
import { apiRouter, publicRouter } from './routes/api.js';
import { seedCampaignsIfEmpty, seedCoordinatorsIfEmpty, seedDevicesIfEmpty, getDuePostOpTasks, markPostOpSent } from './store/repository.js';
import { seedProfileIfEmpty } from './services/profile.js';
import { sendTemplate } from './services/whatsapp.js';

const app = express();

// Parse JSON, and keep the raw body so we can verify Meta's webhook signature.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, ai: aiEnabled, whatsapp: sendEnabled, db: dbEnabled, zoho: zohoEnabled }),
);

app.use('/webhook', webhookRouter);
app.use('/api/public', publicRouter); // unauthenticated widget endpoint (mounted first)
app.use('/api', apiRouter);

// Serve the management panel (static, no build step) at /panel.
app.use('/panel', express.static('public'));

// Unknown /api path → JSON. Express's default is an HTML error page, which the
// panel's api() helper cannot parse, so a typo'd route surfaced as a confusing
// "Unexpected token <" instead of a clear 404.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

// Last-resort error handler. Catches what the route wrappers miss — most often a
// malformed JSON body rejected by express.json() — and answers in JSON too.
app.use((err, _req, res, _next) => {
  console.error('[http]', err.message);
  if (res.headersSent) return;
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Internal error' });
});

// Background failures shouldn't take the server down. Modern Node terminates on
// an unhandled rejection by default, which would kill the panel over one failed
// CRM sync or scheduler tick — the same spirit as the pool's error handler.
// (Deliberate trade-off: we stay up and log loudly. In production, behind a
// supervisor, you'd exit here and let it restart clean.)
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception:', err && err.stack ? err.stack : err);
});

app.listen(config.port, () => {
  console.log(`\n🩺  MediVoyage OS backend listening on :${config.port}`);
  console.log(`    AI concierge    : ${aiEnabled ? 'ON  (' + config.anthropic.model + ')' : 'OFF → echo fallback'}`);
  console.log(`    WhatsApp send   : ${sendEnabled ? 'ON' : 'OFF → dry-run (logs only)'}`);
  console.log(`    Database        : ${dbEnabled ? 'ON  (Postgres)' : 'OFF → in-memory (resets on restart)'}`);
  console.log(`    CRM (Zoho)      : ${zohoEnabled ? 'ON' : 'OFF (set ZOHO_* to enable)'}`);
  console.log(`    Handover ping   : ${notifyEnabled ? 'ON  (webhook)' : 'OFF → panel queue only'}`);
  console.log(`    Signature check : ${config.whatsapp.appSecret ? 'ON' : 'OFF (set WHATSAPP_APP_SECRET to enable)'}`);
  console.log(`\n    📊  Panel: http://localhost:${config.port}/panel`);
  console.log(`    🧩  Lead widget demo: http://localhost:${config.port}/panel/widget.html\n`);

  // Seed a few demo ad campaigns so the analytics view has data (only if empty).
  if (dbEnabled) {
    seedCampaignsIfEmpty()
      .then((seeded) => seeded && console.log('[seed] demo campaigns inserted for analytics'))
      .catch((err) => console.error('[seed] campaigns failed:', err.message));
    seedProfileIfEmpty()
      .then((seeded) => seeded && console.log('[seed] clinic profile initialised (editable in Prompt Studio)'))
      .catch((err) => console.error('[seed] profile failed:', err.message));
    seedCoordinatorsIfEmpty()
      .then((seeded) => seeded && console.log('[seed] demo coordinators inserted for language matching'))
      .catch((err) => console.error('[seed] coordinators failed:', err.message));
    seedDevicesIfEmpty()
      .then((seeded) => seeded && console.log('[seed] demo devices inserted for booking'))
      .catch((err) => console.error('[seed] devices failed:', err.message));

    // Post-op scheduler: every minute, send any due follow-up (thank-you, review
    // request, day-7/30 check-in, fit-to-fly, 1-year checkup) as a WhatsApp
    // template. Runs shortly after boot too, so freshly-due tasks fire promptly.
    const processPostOp = async () => {
      try {
        const due = await getDuePostOpTasks();
        for (const t of due) {
          try {
            await sendTemplate(t.phone, t.kind, t.language || 'en', [t.name || 'there']);
            console.log(`[post-op] sent "${t.kind}" → ${t.name || t.phone}`);
          } catch (err) {
            console.error(`[post-op] "${t.kind}" send failed (marking done to avoid a retry loop):`, err.message);
          }
          // Mark processed regardless of send outcome — a permanent failure
          // (e.g. an unapproved template) must not retry every minute forever.
          try { await markPostOpSent(t.id); } catch (e) { console.error('[post-op] mark failed:', e.message); }
        }
      } catch (err) {
        console.error('[post-op] scheduler error:', err.message);
      }
    };
    setTimeout(processPostOp, 5000);
    setInterval(processPostOp, 60000);
  }
});