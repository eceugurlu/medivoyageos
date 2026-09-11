import { pool, dbEnabled } from '../db/pool.js';
import { clinicProfile as DEFAULT_PROFILE } from '../clinic-profile.js';
import { getDefaultClinicId } from '../store/repository.js';

// The active clinic profile is cached in memory. The concierge reads it on every
// reply (cheap: cache hit), and the Prompt Studio busts the cache on save, so
// updates take effect on the very next patient message — no restart needed.
let cache = null;

export async function getProfile() {
  if (cache) return cache;
  if (!dbEnabled) {
    cache = DEFAULT_PROFILE;
    return cache;
  }
  try {
    const clinicId = await getDefaultClinicId();
    const { rows } = await pool.query('SELECT profile FROM clinics WHERE id = $1', [clinicId]);
    const stored = rows[0]?.profile;
    cache = stored && Object.keys(stored).length ? stored : DEFAULT_PROFILE;
  } catch (err) {
    console.error('[profile] load failed, using default:', err.message);
    cache = DEFAULT_PROFILE;
  }
  return cache;
}

export async function updateProfile(patch) {
  const current = await getProfile();
  const next = { ...current, ...patch };
  if (patch.contact) next.contact = { ...current.contact, ...patch.contact };
  if (patch.treatments) next.treatments = patch.treatments; // replace the array wholesale

  if (dbEnabled) {
    const clinicId = await getDefaultClinicId();
    await pool.query('UPDATE clinics SET profile = $2 WHERE id = $1', [clinicId, JSON.stringify(next)]);
  }
  cache = next;
  return next;
}

// Seed the DB profile from the default on first boot (only if not set yet).
export async function seedProfileIfEmpty() {
  if (!dbEnabled) return false;
  const clinicId = await getDefaultClinicId();
  const { rows } = await pool.query('SELECT profile FROM clinics WHERE id = $1', [clinicId]);
  if (rows[0]?.profile) return false;
  await pool.query('UPDATE clinics SET profile = $2 WHERE id = $1', [clinicId, JSON.stringify(DEFAULT_PROFILE)]);
  cache = DEFAULT_PROFILE;
  return true;
}
