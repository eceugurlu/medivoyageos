import { app } from './app.js';
import { config, aiEnabled, sendEnabled } from './config.js';
import { dbEnabled } from './db/pool.js';
import { zohoEnabled } from './services/zoho.js';
import { notifyEnabled } from './services/notify.js';
import { seedCampaignsIfEmpty, seedCoordinatorsIfEmpty, seedDevicesIfEmpty, seedBranchesIfEmpty } from './store/repository.js';
import { seedProfileIfEmpty } from './services/profile.js';
import { processPostOp, processNoShowRisk, processHotLeadFollowup, processHandoverSla } from './services/scheduler.js';

// Local-dev entry only. Runs the app as one long-lived process: app.listen()
// plus the setInterval timers that stand in for Vercel Cron in production
// (see api/cron/*.js and vercel.json).

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
  console.log(`    Handover SLA    : ${notifyEnabled ? `reminder ${config.notify.slaFirstReminderMinutes}m, escalate ${config.notify.slaEscalateMinutes}m` : 'OFF (needs HANDOVER_WEBHOOK_URL)'}`);
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
    // Branches after coordinators so the seed can assign existing staff/leads
    // across şubeler on first boot of Öncelik 4.
    seedBranchesIfEmpty()
      .then((seeded) => seeded && console.log('[seed] demo branches inserted (Ana Şube / Nişantaşı / Ataşehir)'))
      .catch((err) => console.error('[seed] branches failed:', err.message));
    seedDevicesIfEmpty()
      .then((seeded) => seeded && console.log('[seed] demo devices inserted for booking'))
      .catch((err) => console.error('[seed] devices failed:', err.message));

    setTimeout(() => processPostOp().catch((err) => console.error('[post-op] scheduler error:', err.message)), 5000);
    setInterval(() => processPostOp().catch((err) => console.error('[post-op] scheduler error:', err.message)), 60000);

    setTimeout(() => processNoShowRisk().catch((err) => console.error('[risk] scheduler error:', err.message)), 8000);
    setInterval(() => processNoShowRisk().catch((err) => console.error('[risk] scheduler error:', err.message)), 60000);

    setTimeout(() => processHotLeadFollowup().catch((err) => console.error('[hot-followup] scheduler error:', err.message)), 11000);
    setInterval(() => processHotLeadFollowup().catch((err) => console.error('[hot-followup] scheduler error:', err.message)), 60000);

    setTimeout(() => processHandoverSla().catch((err) => console.error('[handover-sla] scheduler error:', err.message)), 14000);
    setInterval(() => processHandoverSla().catch((err) => console.error('[handover-sla] scheduler error:', err.message)), 60000);
  }
});
