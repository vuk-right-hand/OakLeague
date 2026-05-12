#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// PostgREST listens for NOTIFY 'pgrst' to reload schema. Supabase exposes it
// via the pg notification mechanism — easiest way is to call a SECURITY DEFINER
// function. Failing that, schema typically self-refreshes within ~60s.

// Try via raw SQL through a known service-role-only path. The simplest hack
// is: create a temp function, exec NOTIFY, drop. But we can't do that via
// supabase-js (no exec_sql endpoint by default).
//
// Workaround: alter a known table's comment — PostgREST notices DDL and
// reloads. We touch a function comment.
const r = await supabase.rpc('reap_stuck_embedding_jobs');
console.log('reap_stuck_embedding_jobs return:', r.error?.message || r.data);

// Wait 10s for postgrest to settle if a refresh is in flight.
console.log('waiting 10s for postgrest schema refresh…');
await new Promise((r) => setTimeout(r, 10000));

// Retry the claim that was failing.
const claim = await supabase
  .from('sample_content_embedding_jobs')
  .update({ status: 'processing', claimed_by: 'probe-test-2', claimed_at: new Date().toISOString() })
  .eq('status', 'pending')
  .lt('attempts', 5)
  .order('claimed_at', { ascending: true, nullsFirst: true })
  .limit(1)
  .select('id, sample_id, enqueue_version')
  .maybeSingle();
console.log('claim result:', claim.error?.message || JSON.stringify(claim.data));

if (claim.data) {
  console.log('reverting claim back to pending');
  await supabase.from('sample_content_embedding_jobs')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('id', claim.data.id);
}
