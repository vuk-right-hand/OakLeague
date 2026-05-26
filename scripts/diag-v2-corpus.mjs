// READ-ONLY v2-corpus diagnostic for one creator. No writes.
//   node --env-file=.env.local scripts/diag-v2-corpus.mjs [slug]
// Default slug: vuk_lehendas
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const slug = process.argv[2] || 'vuk_lehendas';
if (!url || !key) { console.error('FATAL: SUPABASE url/service key missing'); process.exit(1); }
console.log(`supabase=${url.replace(/^https?:\/\//, '').slice(0, 30)}…  slug=${slug}\n`);

const supa = createClient(url, key, { auth: { persistSession: false } });

const cr = await supa
  .from('creators')
  .select('id, handle, display_name, retrieval_version, current_corpus_version, brain_mode, brain_status, decoupled, published_at, system_prompt, voice_id')
  .ilike('handle', slug)
  .maybeSingle();
if (cr.error) { console.error('creator query error:', cr.error); process.exit(1); }
if (!cr.data) { console.error(`no creator with handle=${slug}`); process.exit(1); }
const c = cr.data;
const cid = c.id;
console.log('CREATOR');
console.log({
  id: cid, handle: c.handle, display_name: c.display_name,
  retrieval_version: c.retrieval_version,
  current_corpus_version: c.current_corpus_version,
  brain_mode: c.brain_mode, brain_status: c.brain_status,
  decoupled: c.decoupled, published_at: c.published_at,
  has_system_prompt: !!c.system_prompt, system_prompt_len: c.system_prompt?.length ?? 0,
  has_voice_id: !!c.voice_id,
});

// sample_content
const sc = await supa
  .from('sample_content')
  .select('id, title, source_type, topic_tags')
  .eq('creator_id', cid);
let sampleIds = [];
if (sc.error) { console.error('sample_content error:', sc.error); }
else {
  sampleIds = sc.data.map((s) => s.id);
  console.log(`\nSAMPLE_CONTENT (${sc.data.length})`);
  for (const s of sc.data) console.log({ id: s.id, title: s.title, source_type: s.source_type, topic_tags: s.topic_tags });
}

// chunks by chunker_version
const chunks = await supa
  .from('sample_content_chunks')
  .select('id, chunker_version, embedding, parent_unit_id')
  .eq('creator_id', cid);
if (chunks.error) { console.error('chunks error:', chunks.error); }
else {
  const byV = {};
  for (const ch of chunks.data) {
    const v = ch.chunker_version;
    byV[v] ??= { total: 0, embedding_null: 0, parent_null: 0 };
    byV[v].total++;
    if (ch.embedding == null) byV[v].embedding_null++;
    if (ch.parent_unit_id == null) byV[v].parent_null++;
  }
  console.log('\nCHUNKS by chunker_version:', byV);
}

// narrative units
const nu = await supa
  .from('sample_content_narrative_units')
  .select('id, sample_id, title, text')
  .eq('creator_id', cid);
if (nu.error) { console.error('narrative_units error:', nu.error); }
else {
  console.log(`\nNARRATIVE_UNITS: ${nu.data.length}`);
  for (const u of nu.data) console.log({ title: u.title, preview: (u.text ?? '').slice(0, 120).replace(/\s+/g, ' ') });
}

// reprocess jobs (keyed by sample_id)
const jobs = sampleIds.length === 0 ? { data: [], error: null } : await supa
  .from('corpus_reprocess_jobs')
  .select('id, sample_id, status, attempts, last_error, target_version, enqueue_version, created_at, finished_at')
  .in('sample_id', sampleIds)
  .order('created_at', { ascending: false });
if (jobs.error) { console.error('reprocess_jobs error:', jobs.error); }
else {
  const counts = {};
  for (const j of jobs.data) counts[j.status] = (counts[j.status] ?? 0) + 1;
  console.log(`\nCORPUS_REPROCESS_JOBS (${jobs.data.length})  counts=`, counts);
  for (const j of jobs.data.slice(0, 10)) console.log({ status: j.status, attempts: j.attempts, target_version: j.target_version, enqueue_version: j.enqueue_version, last_error: j.last_error, finished_at: j.finished_at });
}

// semantic cache
const cache = await supa
  .from('semantic_query_cache')
  .select('id, corpus_version', { count: 'exact', head: false })
  .eq('creator_id', cid);
if (cache.error) { console.error('semantic_query_cache error:', cache.error); }
else {
  const byV = {};
  for (const r of cache.data) byV[r.corpus_version] = (byV[r.corpus_version] ?? 0) + 1;
  console.log('\nSEMANTIC_QUERY_CACHE by corpus_version:', byV);
}

console.log('\ndone (read-only).');
