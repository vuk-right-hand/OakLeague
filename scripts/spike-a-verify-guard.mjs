#!/usr/bin/env node
/**
 * Pre-apply smoke test for migration 0005 (voice RPC caller guards).
 *
 * B4 of Round-3 audit: the new SECURITY DEFINER guard rejects callers whose
 * JWT role is not 'service_role'. If supabase-js service-role key doesn't
 * satisfy that check (PostgREST decoding, role-claim naming, etc.) the proxy
 * can't log COGS or check quota at all — and the only way to learn that is
 * to apply the migration and watch it break.
 *
 * This script exercises all three affected RPCs end-to-end against the
 * STAGING (or whatever SUPABASE_URL points at) database, using the same
 * client shape the proxy uses, and reports PASS/FAIL per RPC.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/spike-a-verify-guard.mjs
 *
 * Exit 0 = safe to push 0005 to prod. Exit 1 = the guard rejects the proxy.
 *
 * What it does NOT test:
 *   • Behaviour against a logged-in anon/authenticated caller (that's the
 *     REVOKE path — verify by Studio SQL console or a dedicated e2e).
 *   • Latch trigger correctness (0019). Assumes daily_quotas / sessions
 *     triggers still fire as designed.
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.');
  process.exit(2);
}

const supabase = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let failed = 0;
function report(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

// Pick an existing session row to probe with. We only READ + call RPCs; we do
// not mutate cogs_log or daily_quotas. If there's no session in the database,
// the guard is still exercised (function runs, then raises 23503 session_not_
// found after the guard passes — that's a PASS for our purposes because the
// guard let us through).
async function findProbeSession() {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, user_id')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function main() {
  console.log('Spike A — guard smoke test');
  console.log(`  target: ${URL}`);

  const probe = await findProbeSession();
  const probeSessionId = probe?.id ?? randomUUID();
  const probeUserId    = probe?.user_id ?? randomUUID();
  console.log(`  probe session: ${probeSessionId.slice(0, 8)}${probe ? '' : ' (synthetic — will hit 23503 after guard, still counts as PASS)'}`);

  // (1) voice_check_quota
  {
    const { error } = await supabase.rpc('voice_check_quota', { p_session_id: probeSessionId });
    const guardBlocked = error?.code === '42501';
    const downstreamOk = !error || error.code === '23503' || error.code === 'P0002';
    report('voice_check_quota guard accepts service_role',
      !guardBlocked && downstreamOk,
      error ? `${error.code || ''} ${error.message || ''}`.trim() : 'no error');
  }

  // (2) voice_accumulate_seconds — probe with 0 seconds so we never actually
  //     mutate a real user's quota. Guard still runs.
  {
    const { error } = await supabase.rpc('voice_accumulate_seconds', {
      p_session_id: probeSessionId,
      p_seconds: 0,
    });
    const guardBlocked = error?.code === '42501';
    const downstreamOk = !error || error.code === '23503' || error.code === 'P0002';
    report('voice_accumulate_seconds guard accepts service_role',
      !guardBlocked && downstreamOk,
      error ? `${error.code || ''} ${error.message || ''}`.trim() : 'no error');
  }

  // (3) cogs_insert_turn — use a bogus (non-existent) session/user so the
  //     FK on cogs_log.session_id raises 23503 AFTER the guard passes.
  //     We do not commit cogs rows from the smoke test.
  {
    const { error } = await supabase.rpc('cogs_insert_turn', {
      p_user_id:        randomUUID(),
      p_session_id:     randomUUID(),
      p_service:        'gemini',
      p_model:          'gemini-3.1-flash-live-preview',
      p_input_seconds:  0,
      p_output_seconds: 0,
      p_input_cost:     0,
      p_output_cost:    0,
      p_environment:    'dev',
      p_metadata:       { source: 'smoke_test' },
    });
    const guardBlocked = error?.code === '42501';
    // 23503 = FK violation (expected when we use random UUIDs).
    const downstreamOk = !error || error.code === '23503';
    report('cogs_insert_turn guard accepts service_role',
      !guardBlocked && downstreamOk,
      error ? `${error.code || ''} ${error.message || ''}`.trim() : 'no error');
  }

  if (failed) {
    console.log(`\n${failed} check(s) FAILED — DO NOT apply 0005 to prod until resolved.`);
    process.exit(1);
  }
  console.log('\nAll guards accept service_role. Safe to apply 0005.');
}

main().catch((e) => {
  console.error('smoke-test crashed:', e);
  process.exit(1);
});
