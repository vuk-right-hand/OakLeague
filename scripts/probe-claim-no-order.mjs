#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Claim WITHOUT order — see if order is the problem.
console.log('[1] claim without order…');
const c1 = await supabase
  .from('sample_content_embedding_jobs')
  .update({ status: 'processing', claimed_by: 'probe', claimed_at: new Date().toISOString() })
  .eq('status', 'pending')
  .lt('attempts', 5)
  .limit(1)
  .select('id, sample_id, enqueue_version')
  .maybeSingle();
console.log('  ', c1.error ? `ERROR: ${c1.error.message}` : `ok: ${JSON.stringify(c1.data)}`);

if (c1.data) {
  console.log('[2] revert…');
  await supabase.from('sample_content_embedding_jobs')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('id', c1.data.id);
}

// Claim WITH ORDER on enqueue_version (known-good column) to isolate.
console.log('\n[3] claim with order on enqueue_version…');
const c2 = await supabase
  .from('sample_content_embedding_jobs')
  .update({ status: 'processing', claimed_by: 'probe-b', claimed_at: new Date().toISOString() })
  .eq('status', 'pending')
  .lt('attempts', 5)
  .order('enqueue_version', { ascending: true })
  .limit(1)
  .select('id')
  .maybeSingle();
console.log('  ', c2.error ? `ERROR: ${c2.error.message}` : `ok: ${JSON.stringify(c2.data)}`);

if (c2.data) {
  await supabase.from('sample_content_embedding_jobs')
    .update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('id', c2.data.id);
}
