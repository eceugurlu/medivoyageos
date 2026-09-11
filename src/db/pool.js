import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// No DATABASE_URL → don't even try to connect (keeps local echo-mode testing
// possible without a database, same spirit as the AI/WhatsApp dry-run flags).
export const dbEnabled = Boolean(config.db.url);

export const pool = dbEnabled
  ? new Pool({ connectionString: config.db.url })
  : null;

if (dbEnabled) {
  pool.on('error', (err) => {
    // A background/idle client error shouldn't crash the whole server.
    console.error('[db] unexpected pool error', err.message);
  });
}
