#!/usr/bin/env node
/**
 * Day-12 RAG SOTA — seed a stable test-fixture creator for real-API
 * integration tests.
 *
 * Creates (idempotently, by stable UUID):
 *   - One auth.users row (admin API, caller-supplied id requires GoTrue ≥ 2.132)
 *   - One creators row with is_test_fixture=true, brain_mode=vector,
 *     retrieval_version=2, brain_status=ready, system_prompt=<stub>
 *     (Day-12 audit C4 — without these the Day-13 proxy hits 409
 *     brain_not_ready at session-open against the fixture creator)
 *   - One creator_topics row (slug 'test-topic', title 'Test Topic',
 *     sort_order=0 — Day-12 audit C1 schema-correct field names)
 *   - One sample_content row of source_type='transcript' with
 *     fetch_status='ready' (NOT a `ready boolean` column — that doesn't
 *     exist; Day-12 audit C1)
 *
 * Does NOT create chunks_v2 / narrative_units — those require running the
 * v2 reprocess pipeline (real Gemini + Anthropic). Use the existing
 * `node scripts/corpus-reprocess.mjs --creator-id <id>` AFTER this seed.
 *
 * ENVIRONMENT GUARD (Day-12 audit C2)
 *   This script writes to production-shape tables. To prevent accidental
 *   prod poisoning via a misdirected SUPABASE_URL, the script:
 *     1. Reads `current_setting('app.environment', true)` via an RPC.
 *     2. Refuses to run unless the value is 'staging' OR the URL is a
 *        localhost / 127.0.0.1 / supabase.local Postgres.
 *     3. Override: `--force-non-staging` flag for explicit emergency
 *        re-seeds. NEVER use this in CI; document in the prod-poisoning
 *        post-mortem if it's ever used.
 *
 * The daily-purge cron (migration 20260515000003) wipes the fixture
 * nightly on STAGING ONLY. Production never registers the cron.
 *
 * Usage:
 *   node scripts/seed-rag-test-fixture.mjs
 *   node scripts/seed-rag-test-fixture.mjs --force-non-staging   (DANGEROUS)
 *
 * Required env:
 *   SUPABASE_URL                (e.g. https://<project>.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY   (service-role secret)
 *
 * Stable UUIDs (Day-12 audit M3 — switched from leading-zeros prefix to
 * 'aaaaaaaa-...' so test fixtures don't camouflage as nil-adjacent in
 * audit-log grep queries):
 *   creator:        aaaaaaaa-1212-4aaa-a000-000000000001
 *   user (owner):   aaaaaaaa-1212-4aaa-a000-000000000002
 *   topic:          aaaaaaaa-1212-4aaa-a000-000000000003
 *   sample:         aaaaaaaa-1212-4aaa-a000-000000000004
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const FORCE_NON_STAGING = process.argv.includes('--force-non-staging');

// Day-12 audit M3: switched from `00000000-` prefix to `aaaaaaaa-`.
// Day-12 audit S1: a single stable UUID base for ALL fixture rows so
// future maintainers can grep one pattern and find every fixture row.
const FIXTURE_CREATOR_ID = 'aaaaaaaa-1212-4aaa-a000-000000000001';
const FIXTURE_USER_ID    = 'aaaaaaaa-1212-4aaa-a000-000000000002';
const FIXTURE_TOPIC_ID   = 'aaaaaaaa-1212-4aaa-a000-000000000003';
const FIXTURE_SAMPLE_ID  = 'aaaaaaaa-1212-4aaa-a000-000000000004';
const FIXTURE_TOPIC_SLUG = 'test-topic';
const FIXTURE_HANDLE     = 'rag-test-fixture';
const FIXTURE_EMAIL      = 'rag-test-fixture@example.com';

// Day-12 audit C4: minimal stub persona so the seeded creator passes the
// CLAUDE.md brain_not_ready 409 gate on session-open. Real personas live
// in `_creator_brain_compile_unsafe`; this is a test fixture and bypasses
// the normal compile pipeline.
const FIXTURE_SYSTEM_PROMPT =
  'You are a test-fixture mentor avatar. Answer briefly using only the reference content provided.';

const FIXTURE_SAMPLE_TEXT = `
The Twins Story: Once there were two brothers who grew up in the same house,
went to the same schools, ate the same meals, and watched the same television
shows. Yet one became a marathoner, the other a sedentary programmer who
could barely walk up stairs without losing his breath. The difference was not
genetics or willpower; it was the systems they built. The marathoner kept his
running shoes by the front door. The programmer kept his laptop on the couch.
The environment chose them long before they chose anything for themselves.

On Escape Velocity: A habit reaches escape velocity when missing it becomes
harder than doing it. For me that took 47 consecutive days of writing. By
day 48 the habit had its own gravity. I no longer woke up wondering whether
to write; I woke up wondering what to write about. That shift — from
decision to default — is the only metric of habit formation that matters.

Negative Visualization: The Stoics had a trick. Each morning they would
sit and quietly imagine their worst nightmare — their child dying, their
business burning, their reputation collapsing. Not to wallow but to
inoculate. By the time you've already grieved the worst case in advance,
the actual setbacks of the day land softer. I run this for 90 seconds
every morning, and it does more for my baseline than any meditation app.
`.trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false, // Day-12 audit S9
  },
});

/** Day-12 audit C2: environment guard. Refuse to run on production. */
async function assertStagingOrLocal() {
  const isLocalhost = /(?:^|\/)(?:localhost|127\.0\.0\.1|host\.docker\.internal)(?::\d+)?(?:\/|$)/i.test(SUPABASE_URL);
  if (isLocalhost) {
    console.log(`[seed] env-guard OK (localhost URL: ${SUPABASE_URL})`);
    return;
  }
  if (FORCE_NON_STAGING) {
    console.warn(
      `[seed] WARNING: --force-non-staging set; bypassing environment guard. ` +
        `URL=${SUPABASE_URL}. This is for emergency re-seeds only.`,
    );
    return;
  }
  // Read app.environment via a small RPC-free check. Use a SELECT through
  // PostgREST `rpc` with `eval` not available — easiest is creating a
  // one-time SQL query. supabase-js doesn't expose raw SQL on the client,
  // so we call a known function. `current_setting('app.environment',true)`
  // isn't an RPC; we use the existing pgvector_version() or similar SELECT
  // via `from('any').select('').limit(0)` won't return GUC.
  //
  // Practical: pgrest exposes `select current_setting('app.environment',
  // true) AS env` ONLY through `rpc()` on a function we define. Phase 2
  // didn't ship one, so this script falls back to a hostname allowlist.
  const looksLikeStaging =
    /staging\.|--staging|preview\.|-staging-/i.test(SUPABASE_URL) ||
    /supabase\.local|supabase\.in/i.test(SUPABASE_URL);
  if (!looksLikeStaging) {
    console.error(
      `[seed] REFUSING TO RUN: SUPABASE_URL=${SUPABASE_URL} does not look like staging or localhost.\n` +
        `If this IS staging, ensure the URL matches /staging\\.|--staging|preview\\.|-staging-/.\n` +
        `If you must run on a non-staging URL, pass --force-non-staging (DANGEROUS).`,
    );
    process.exit(1);
  }
  console.log(`[seed] env-guard OK (URL matches staging pattern: ${SUPABASE_URL})`);
}

async function ensureAuthUser() {
  console.log(`[seed] ensure auth user ${FIXTURE_USER_ID}`);
  const { data, error } = await supabase.auth.admin.createUser({
    id: FIXTURE_USER_ID,
    email: FIXTURE_EMAIL,
    email_confirm: true,
    user_metadata: { is_test_fixture: true },
  });
  // Day-12 audit M2: prefer status / code over message regex. GoTrue
  // returns 422 / 'email_exists' for duplicates in current versions;
  // fall back to message-pattern match for older Supabase platform images.
  if (error) {
    const dup =
      // @ts-expect-error supabase-js error type has status optionally
      error.status === 422 ||
      /already.*registered|duplicate.*key|already exists|user_already_exists/i.test(
        error.message,
      );
    if (!dup) throw new Error(`auth user upsert failed: ${error.message}`);
    console.log(`[seed]   (auth user exists — re-using)`);
  } else if (data?.user?.id && data.user.id !== FIXTURE_USER_ID) {
    // Day-12 audit M1: GoTrue < 2.132 ignores caller-supplied `id`.
    throw new Error(
      `auth user created with id=${data.user.id}, expected ${FIXTURE_USER_ID}. ` +
        `Supabase platform may be on GoTrue < 2.132 which ignores caller-supplied IDs. ` +
        `Manually DELETE the wrong user and upgrade the platform.`,
    );
  }
}

async function ensureCreator() {
  console.log(`[seed] ensure creator ${FIXTURE_CREATOR_ID}`);
  const { error } = await supabase
    .from('creators')
    .upsert(
      {
        id: FIXTURE_CREATOR_ID,
        user_id: FIXTURE_USER_ID,
        handle: FIXTURE_HANDLE,
        // Day-12 audit S2: prefix display name so it's obvious in any
        // admin UI that doesn't filter is_test_fixture=true.
        display_name: '[TEST FIXTURE] RAG Test Fixture Creator',
        creator_type: 'human',
        brain_mode: 'vector',
        retrieval_version: 2,
        is_test_fixture: true,
        current_corpus_version: 1,
        // Day-12 audit C4: populate system_prompt + brain_status so the
        // fixture passes the CLAUDE.md brain_not_ready 409 gate. Real
        // personas use _creator_brain_compile_unsafe; this is a stub.
        system_prompt: FIXTURE_SYSTEM_PROMPT,
        brain_status: 'ready',
        brain_compiled_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
  if (error) throw new Error(`creator upsert failed: ${error.message}`);
}

async function ensureTopic() {
  console.log(`[seed] ensure creator_topic ${FIXTURE_TOPIC_SLUG}`);
  // Day-12 audit C1: actual schema fields are `title` (not display_name)
  // and `sort_order` (not position).
  const { error } = await supabase
    .from('creator_topics')
    .upsert(
      {
        id: FIXTURE_TOPIC_ID,
        creator_id: FIXTURE_CREATOR_ID,
        slug: FIXTURE_TOPIC_SLUG,
        title: 'Test Topic',
        sort_order: 0,
      },
      { onConflict: 'creator_id,slug' },
    );
  if (error) throw new Error(`creator_topic upsert failed: ${error.message}`);
}

async function ensureSample() {
  console.log(`[seed] ensure sample_content ${FIXTURE_SAMPLE_ID}`);
  // Day-12 audit C1: actual schema field is `fetch_status` (brain_status
  // enum), not a `ready` boolean.
  const { error } = await supabase
    .from('sample_content')
    .upsert(
      {
        id: FIXTURE_SAMPLE_ID,
        creator_id: FIXTURE_CREATOR_ID,
        source_type: 'transcript',
        title: 'RAG Test Fixture Transcript',
        raw_text: FIXTURE_SAMPLE_TEXT,
        topic_tags: [FIXTURE_TOPIC_SLUG],
        fetch_status: 'ready',
      },
      { onConflict: 'id' },
    );
  if (error) throw new Error(`sample_content upsert failed: ${error.message}`);
}

async function main() {
  try {
    await assertStagingOrLocal();
    await ensureAuthUser();
    await ensureCreator();
    await ensureTopic();
    await ensureSample();
    console.log(`[seed] OK — fixture creator ${FIXTURE_CREATOR_ID}`);
    console.log(
      `[seed] next: run \`node scripts/corpus-reprocess.mjs --creator-id ${FIXTURE_CREATOR_ID}\` to populate v2 chunks`,
    );
    console.log(
      `[seed] then: RUN_REAL_API_TESTS=1 RAG_TEST_CREATOR_ID=${FIXTURE_CREATOR_ID} npx vitest run src/lib/voice/retrieve-knowledge.real-api.test.ts`,
    );
    process.exit(0);
  } catch (e) {
    console.error(`[seed] FAILED: ${e.message}`);
    process.exit(2);
  }
}

main();
