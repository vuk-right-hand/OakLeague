#!/usr/bin/env node
// Post-deploy: delete Vuk's old 43 chunks (500/80 chunker), enqueue a fresh
// embedding job (300/100 chunker after proxy v38), recompile persona with
// migration 14's strengthened clarifier rule.
//
// Worker polls every 5s on Fly; the proxy was just deployed so machines are
// stopped — we wake one via healthz first.

import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const CREATOR_ID = '74e897d8-6e91-4f00-98ab-190a66c92d9a';

console.log('[1/5] wake proxy machine (so embed-worker boots)…');
await fetch('https://oakleague-voice-proxy.fly.dev/healthz').catch(() => {});
await new Promise((r) => setTimeout(r, 4000));

console.log('[2/5] count existing chunks…');
const { count: oldCount } = await supabase
  .from('sample_content_chunks')
  .select('id', { count: 'exact', head: true })
  .eq('creator_id', CREATOR_ID);
console.log(`  ${oldCount} existing chunks (500/80 chunker)`);

console.log('[3/5] delete chunks + reset jobs…');
{
  const { error } = await supabase.from('sample_content_chunks').delete().eq('creator_id', CREATOR_ID);
  if (error) throw new Error(`delete chunks: ${error.message}`);
}
{
  // Wipe job rows so the unique constraint doesn't block re-enqueue.
  const { data: samples } = await supabase.from('sample_content').select('id').eq('creator_id', CREATOR_ID);
  const sampleIds = (samples ?? []).map((s) => s.id);
  if (sampleIds.length > 0) {
    const { error } = await supabase.from('sample_content_embedding_jobs').delete().in('sample_id', sampleIds);
    if (error) throw new Error(`delete jobs: ${error.message}`);
  }
}

console.log('[4/5] enqueue fresh jobs…');
{
  const { data: samples } = await supabase
    .from('sample_content')
    .select('id, raw_text')
    .eq('creator_id', CREATOR_ID)
    .neq('fetch_status', 'errored');
  const eligible = (samples ?? []).filter((s) => s.raw_text);
  console.log(`  enqueuing ${eligible.length} sample(s)`);
  const { error } = await supabase
    .from('sample_content_embedding_jobs')
    .insert(eligible.map((s) => ({ sample_id: s.id, status: 'pending', attempts: 0, enqueue_version: 1 })));
  if (error) throw new Error(`enqueue: ${error.message}`);
}

console.log('[5/5] wait for worker (cap 5min)…');
const deadline = Date.now() + 5 * 60 * 1000;
let lastReport = '';
while (Date.now() < deadline) {
  const { data: jobs } = await supabase
    .from('sample_content_embedding_jobs')
    .select('status, last_error, sample_id')
    .in('sample_id', (await supabase.from('sample_content').select('id').eq('creator_id', CREATOR_ID)).data.map((s) => s.id));
  const { count: total } = await supabase.from('sample_content_chunks').select('id', { count: 'exact', head: true }).eq('creator_id', CREATOR_ID);
  const { count: embedded } = await supabase.from('sample_content_chunks').select('id', { count: 'exact', head: true }).eq('creator_id', CREATOR_ID).not('embedding', 'is', null);
  const stats = (jobs ?? []).reduce((a, j) => { a[j.status] = (a[j.status] || 0) + 1; return a; }, {});
  const report = `${JSON.stringify(stats)} chunks=${embedded}/${total}`;
  if (report !== lastReport) { console.log(`  ${report}`); lastReport = report; }
  const errored = (jobs ?? []).filter((j) => j.status === 'errored');
  if (errored.length > 0) { console.error('  ERRORED:', errored); process.exit(1); }
  if ((jobs ?? []).every((j) => j.status === 'done') && total > 0 && total === embedded) break;
  await new Promise((r) => setTimeout(r, 8000));
}

const { count: finalCount } = await supabase.from('sample_content_chunks').select('id', { count: 'exact', head: true }).eq('creator_id', CREATOR_ID).not('embedding', 'is', null);
console.log(`\n[done] new chunks: ${finalCount} (vs ${oldCount} before)`);

console.log('\n[6/6] recompile persona with M14 clarifier rule…');
const { error: compErr } = await supabase.rpc('_creator_brain_compile_unsafe', { p_creator_id: CREATOR_ID });
if (compErr) throw new Error(`compile: ${compErr.message}`);
const { data: c } = await supabase.from('creators').select('system_prompt').eq('id', CREATOR_ID).single();
console.log(`  persona length: ${c.system_prompt.length} chars`);
console.log(`  contains "First-turn rule": ${c.system_prompt.includes('First-turn rule')}`);
console.log('\nReady to re-dogfood.');
