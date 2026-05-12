#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

console.log('[1] reap_stuck_embedding_jobs RPC…');
const reap = await supabase.rpc('reap_stuck_embedding_jobs');
console.log('  ', reap.error ? `ERROR: ${reap.error.message}` : `ok: ${JSON.stringify(reap.data)}`);

console.log('\n[2] current job rows…');
const { data: jobs, error: jErr } = await supabase
  .from('sample_content_embedding_jobs')
  .select('id, sample_id, status, attempts, claimed_by, claimed_at, last_error, enqueue_version, created_at');
console.log('  ', jErr ? `ERROR: ${jErr.message}` : `${jobs.length} rows`);
for (const j of jobs ?? []) console.log('   ', j);

console.log('\n[3] try claim as worker (atomic UPDATE)…');
const claim = await supabase
  .from('sample_content_embedding_jobs')
  .update({ status: 'processing', claimed_by: 'probe-test', claimed_at: new Date().toISOString() })
  .eq('status', 'pending')
  .lt('attempts', 5)
  .order('claimed_at', { ascending: true, nullsFirst: true })
  .limit(1)
  .select('id, sample_id, enqueue_version')
  .maybeSingle();
console.log('  ', claim.error ? `ERROR: ${claim.error.message}` : `claim result: ${JSON.stringify(claim.data)}`);

if (claim.data) {
  console.log('\n[4] revert claim back to pending so worker can pick it up…');
  await supabase
    .from('sample_content_embedding_jobs')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('id', claim.data.id);
  console.log('  reverted');
}
