#!/usr/bin/env -S node --loader tsx
/**
 * Sanity check: cogs_log turn-idempotency contract (Days 8–12 plan REV 5).
 *
 * Invariants asserted (N3-S5):
 *   (a) EXPLAIN on SELECT … WHERE session_id = $sid AND turn_number = 1 AND
 *       service = 'gemini' AND operation = 'voice_audio_input_seconds' plans
 *       an Index Scan using the `cogs_log_turn_idempotency` partial unique
 *       index.
 *   (b) Two inserts with identical (session_id, turn_number, service,
 *       operation) — the second raises SQLSTATE 23505 (unique_violation).
 *       The idempotency key is the 4-tuple; `service` alone is not unique
 *       because the free path writes two legs under service='gemini' with
 *       distinct operations.
 *   (c) Two inserts with turn_number=NULL (non-turn writers: voice-clone
 *       upload COGS leg, resume-context-tokens) both succeed — the partial
 *       index's `WHERE turn_number IS NOT NULL` predicate excludes NULLs.
 *
 * PREREQUISITE (audit C3): run `scripts/install-sanity-helper.sql` once
 * against the target project (Supabase SQL Editor). This creates
 * `public.cogs_sanity_check_scratch_v1()` which the script below invokes
 * via `supabase.rpc()`. Supabase does not expose a generic exec_sql RPC, so
 * the helper cannot be installed at runtime from a JS client.
 *
 * PRODUCTION GUARD (audit M5): the helper function INSERTs into cogs_log
 * and cannot DELETE those rows (append-only trigger; FK cascade sets
 * session_id=NULL instead). Rows persist forever tagged metadata.sanity=true.
 * This script REFUSES to run when SUPABASE_URL looks like a production host
 * unless `ALLOW_PROD_POLLUTION=1` is set explicitly.
 *
 * Required env:
 *   SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Exit 0 on all pass, 1 otherwise.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    'SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.',
  );
  process.exit(2);
}

// Prod-pollution guard. If URL matches a known prod host and the user hasn't
// opted in, refuse. The substring list stays small on purpose — expand when
// new prod project refs land.
const PROD_HINTS = [
  'oakleague',           // project slug
  '.supabase.co/prod',   // any vanity alias
];
const urlLower = SUPABASE_URL.toLowerCase();
const looksProd = PROD_HINTS.some((h) => urlLower.includes(h));
if (looksProd && process.env.ALLOW_PROD_POLLUTION !== '1') {
  console.error(
    `[sanity] SUPABASE_URL=${SUPABASE_URL} looks like production. This script ` +
      `inserts non-deletable rows into cogs_log (append-only trigger blocks ` +
      `cleanup). Refusing to run. Set ALLOW_PROD_POLLUTION=1 if you really ` +
      `mean to, or point at a staging project.`,
  );
  process.exit(3);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SCRATCH_FN = 'cogs_sanity_check_scratch_v1';

type AssertionRow = { assertion: string; passed: boolean; detail: string };

async function runAssertions(): Promise<AssertionRow[]> {
  const { data, error } = await admin.rpc(SCRATCH_FN as never);
  if (error) {
    throw new Error(
      `scratch fn failed: ${error.message}. Did you run ` +
        `scripts/install-sanity-helper.sql against this project first?`,
    );
  }
  return (data ?? []) as AssertionRow[];
}

async function main() {
  console.log('[sanity] running assertions…');
  const rows = await runAssertions();

  let allPassed = true;
  for (const r of rows) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.assertion} — ${r.detail}`);
    if (!r.passed) allPassed = false;
  }

  if (!allPassed) {
    console.error('[sanity] one or more assertions failed.');
    process.exit(1);
  }
  console.log('[sanity] all assertions passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
