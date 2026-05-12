#!/usr/bin/env node
/**
 * One-shot dogfood prep: backfill Vuk's sample_content embedding jobs +
 * wait for them to land + flip brain_mode to vector.
 *
 * Run AFTER:
 *   - git push origin main (Vercel + Fly redeployed)
 *   - npx supabase db push --linked (13 migrations applied to prod)
 *
 * Uses the SUPABASE_SERVICE_ROLE_KEY from .env.local (already targets prod).
 */

import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = 'vukpjescic@gmail.com';
const CREATOR_HANDLE = 'vuk_lehendas';

if (!SUPA_URL || !SUPA_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.');
  process.exit(1);
}

console.log(`supabase: ${SUPA_URL}`);
const supabase = createClient(SUPA_URL, SUPA_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  // 1. Resolve creator + admin caller.
  console.log('\n[1/5] resolving creator + admin…');
  const { data: userList, error: userErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (userErr) throw new Error(`list users: ${userErr.message}`);
  const adminUser = userList.users.find((u) => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  if (!adminUser) throw new Error(`no admin user with email ${ADMIN_EMAIL}`);
  console.log(`  admin caller: ${adminUser.id} (${adminUser.email})`);

  const { data: creatorRow, error: cErr } = await supabase
    .from('creators')
    .select('id, display_name, handle, brain_mode, brain_status, system_prompt')
    .eq('handle', CREATOR_HANDLE)
    .single();
  if (cErr) throw new Error(`find creator by handle=${CREATOR_HANDLE}: ${cErr.message}`);
  const creatorId = creatorRow.id;
  const vukUser = { id: adminUser.id };  // admin used for RPC + audit
  console.log(`  creator: ${creatorId} | ${creatorRow.handle} | ${creatorRow.display_name} | mode=${creatorRow.brain_mode} status=${creatorRow.brain_status}`);

  // 2. Survey existing sample_content.
  console.log('\n[2/5] surveying sample_content…');
  const { data: samples, error: sErr } = await supabase
    .from('sample_content')
    .select('id, source_type, title, fetch_status, raw_text')
    .eq('creator_id', creatorId);
  if (sErr) throw new Error(`list samples: ${sErr.message}`);
  console.log(`  ${samples.length} sample(s):`);
  for (const s of samples) {
    const charCount = s.raw_text?.length ?? 0;
    console.log(`    - [${s.source_type}] ${s.title || '(untitled)'} — ${charCount} chars (fetch=${s.fetch_status})`);
  }
  const eligible = samples.filter((s) => s.raw_text && s.fetch_status !== 'errored');
  if (eligible.length === 0) {
    console.error('  no eligible samples (need raw_text + fetch_status != errored).');
    process.exit(1);
  }

  // 3. Enqueue embedding jobs (idempotent — skip already-queued).
  console.log('\n[3/5] enqueueing embedding jobs…');
  const { data: existingJobs } = await supabase
    .from('sample_content_embedding_jobs')
    .select('sample_id')
    .in('sample_id', eligible.map((s) => s.id));
  const queuedIds = new Set((existingJobs ?? []).map((j) => j.sample_id));
  const toEnqueue = eligible.filter((s) => !queuedIds.has(s.id));
  console.log(`  ${queuedIds.size} already queued, ${toEnqueue.length} new`);

  if (toEnqueue.length > 0) {
    const { error: jobErr } = await supabase
      .from('sample_content_embedding_jobs')
      .insert(
        toEnqueue.map((s) => ({
          sample_id: s.id,
          status: 'pending',
          attempts: 0,
          enqueue_version: 1,
        })),
      );
    if (jobErr) throw new Error(`enqueue jobs: ${jobErr.message}`);
    console.log(`  enqueued ${toEnqueue.length} jobs`);
  }

  // 4. Poll for chunks to land. Worker polls every 5s on Fly; we poll every 10s.
  console.log('\n[4/5] waiting for embed-worker to process (5min cap)…');
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastReport = '';
  while (Date.now() < deadline) {
    const { data: jobStatus } = await supabase
      .from('sample_content_embedding_jobs')
      .select('status, last_error, sample_id, attempts')
      .in('sample_id', eligible.map((s) => s.id));

    const { count: chunkTotal } = await supabase
      .from('sample_content_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', creatorId);

    const { count: chunkEmbedded } = await supabase
      .from('sample_content_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', creatorId)
      .not('embedding', 'is', null);

    const statusCounts = (jobStatus ?? []).reduce((acc, j) => {
      acc[j.status] = (acc[j.status] || 0) + 1;
      return acc;
    }, {});
    const report = `jobs: ${JSON.stringify(statusCounts)} | chunks: ${chunkEmbedded}/${chunkTotal}`;
    if (report !== lastReport) {
      console.log(`  ${report}`);
      lastReport = report;
    }

    const errored = (jobStatus ?? []).filter((j) => j.status === 'errored');
    if (errored.length > 0) {
      console.log('  ERRORED jobs:');
      for (const e of errored) console.log(`    sample ${e.sample_id}: ${e.last_error}`);
      console.log('  fix errored jobs before flipping; aborting.');
      process.exit(1);
    }

    const allDone = (jobStatus ?? []).length > 0 && (jobStatus ?? []).every((j) => j.status === 'done');
    if (allDone && chunkEmbedded === chunkTotal && chunkTotal > 0) {
      console.log(`  ALL DONE — ${chunkTotal} chunks embedded.`);
      break;
    }
    await new Promise((r) => setTimeout(r, 10000));
  }

  // Final chunk check.
  const { count: finalEmbedded } = await supabase
    .from('sample_content_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)
    .not('embedding', 'is', null);
  if (!finalEmbedded || finalEmbedded === 0) {
    console.error('  no chunks embedded yet — check Fly logs for embed-worker.');
    process.exit(1);
  }

  // 5. Flip brain_mode + recompile persona.
  // Note: admin_set_creator_brain_mode requires auth.uid() (real JWT).
  // Service-role calls have no auth context, so we do the equivalent
  // operations directly. Audit log skipped — this is a dogfood-prep
  // script, not a production admin action.
  console.log('\n[5/5] flipping brain_mode to vector (direct UPDATE + compile)…');
  const { error: updErr } = await supabase
    .from('creators')
    .update({ brain_mode: 'vector' })
    .eq('id', creatorId);
  if (updErr) throw new Error(`update brain_mode: ${updErr.message}`);

  const { error: compileErr } = await supabase.rpc('_creator_brain_compile_unsafe', {
    p_creator_id: creatorId,
  });
  if (compileErr) throw new Error(`compile persona: ${compileErr.message}`);

  // Verify.
  const { data: after } = await supabase
    .from('creators')
    .select('brain_mode, system_prompt')
    .eq('id', creatorId)
    .single();
  console.log(`  brain_mode = ${after.brain_mode}`);
  console.log(`  persona length = ${after.system_prompt?.length ?? 0} chars`);
  const hasClarifier = after.system_prompt?.includes('ALWAYS ask one short clarifier');
  console.log(`  clarifier rule present: ${hasClarifier ? 'YES' : 'NO (M12 missing!)'}`);
  console.log(`\nDone. Ready to dogfood.`);
  console.log(`Creator id (save for later): ${creatorId}`);
}

main().catch((e) => {
  console.error('\nerror:', e?.message || e);
  process.exit(1);
});
