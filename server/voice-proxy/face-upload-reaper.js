// Auditor R3-NC2 — stale-pending face-upload reaper. Runs alongside the
// simli-face-delete worker in the proxy. A face_clone_uploads row stuck
// in state='pending' (Simli vendor outage, page closed before resume,
// network partition during finalize) blocks the M1 resume path forever.
// This reaper marks rows older than MAX_AGE_MIN as failed and enqueues
// their vendor_face_id into simli_face_delete_queue so the existing
// face-delete worker cleans up the orphaned vendor face.
//
// Tick cadence: 5 min. Single RPC call per tick — face_clone_uploads_reap_stale_pending.

import { captureException } from './sentry.js';

const TICK_MS = 5 * 60_000;
const MAX_AGE_MINUTES = 30; // Trinity training >30 min on Hobby is treated as a vendor outage.

export function makeFaceUploadReaper({ supabase } = {}) {
  if (!supabase) throw new Error('supabase required');

  async function tick() {
    const { data, error } = await supabase.rpc('face_clone_uploads_reap_stale_pending', {
      p_max_age_minutes: MAX_AGE_MINUTES,
    });
    if (error) {
      console.error('[face-upload-reaper] reap', error);
      captureException(error, { op: 'face_clone_reap' });
      return;
    }
    const count = typeof data === 'number' ? data : 0;
    if (count > 0) {
      console.log(`[face-upload-reaper] swept ${count} stale-pending row(s)`);
    }
  }

  function install() {
    tick().catch((e) => {
      console.error('[face-upload-reaper] init tick failed', e);
      captureException(e, { op: 'face_clone_reap_init' });
    });
    const handle = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
    return { handle, tick };
  }

  return { install, tick };
}
