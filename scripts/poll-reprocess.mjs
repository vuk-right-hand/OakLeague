// Polls corpus_reprocess_jobs status for Vuk's creator until terminal state.
// Read-only. Used for the Day-14 dogfood gate.
//
// Run: node --env-file=.env.local scripts/poll-reprocess.mjs

import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const creatorId = '74e897d8-6e91-4f00-98ab-190a66c92d9a';
const sampleId = '6bd94fa1-6783-49bf-9f1f-af8405c1284c'; // Vuk's single transcript
const POLL_MS = 5000;
const MAX_POLLS = 180; // 15 min ceiling (chunking + contextual-gen + embed pipeline)

async function snapshot() {
  const { data: jobs } = await supa
    .from('corpus_reprocess_jobs')
    .select('id, sample_id, status, claimed_at, finished_at, last_error, attempts, progress_json, created_at')
    .eq('sample_id', sampleId)
    .order('created_at', { ascending: false })
    .limit(5);

  const { count: v2 } = await supa
    .from('sample_content_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)
    .eq('chunker_version', 2);

  const { count: nUnits } = await supa
    .from('sample_content_narrative_units')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId);

  return { jobs: jobs || [], v2: v2 ?? 0, nUnits: nUnits ?? 0 };
}

let last = '';
for (let i = 0; i < MAX_POLLS; i++) {
  const { jobs, v2, nUnits } = await snapshot();
  const sig = jobs.map((j) => `${j.id.slice(0, 8)}=${j.status}`).join(',');
  const line = `[${new Date().toISOString().slice(11, 19)}] jobs={${sig}} v2_chunks=${v2} narrative_units=${nUnits}`;
  if (line !== last) {
    console.log(line);
    last = line;
  }
  // The worker's success terminal status is 'done' (corpus_reprocess_mark_done);
  // 'completed' was never a real status — polling for it timed out on success.
  const terminal = jobs.every((j) =>
    ['done', 'completed', 'failed', 'cancelled'].includes(j.status),
  );
  const anyFailed = jobs.some((j) => j.status === 'failed');
  if (terminal) {
    console.log('\nAll jobs in terminal state. Final snapshot:');
    for (const j of jobs) {
      console.log({
        id: j.id.slice(0, 8),
        status: j.status,
        attempts: j.attempts,
        claimed_at: j.claimed_at,
        finished_at: j.finished_at,
        last_error: j.last_error ? j.last_error.slice(0, 300) : null,
      });
    }
    console.log(`\nFinal: v2_chunks=${v2}, narrative_units=${nUnits}`);
    process.exit(anyFailed ? 2 : 0);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
console.error('Timeout — job did not reach terminal state in 5 min');
process.exit(3);
