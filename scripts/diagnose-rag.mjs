// One-shot read-only diagnostic. NO writes. Reads creator state, corpus,
// recent sessions for creator 74e897d8 (vuk_lehendas) to answer:
//   1. Is the creator v1 or v2?
//   2. Was the doc actually ingested as chunks?
//   3. Did the most recent session run retrieval, skip, or what?
//   4. Are there chunks that mention "twin"?
//
// Run: node --env-file=.env.local scripts/diagnose-rag.mjs

import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('FATAL: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
  process.exit(1);
}

const supa = createClient(url, serviceKey, { auth: { persistSession: false } });

const creatorId = '74e897d8-6e91-4f00-98ab-190a66c92d9a'; // vuk_lehendas (from session summary)

function hr(label) {
  console.log('\n' + '─'.repeat(70));
  console.log(label);
  console.log('─'.repeat(70));
}

async function main() {
  hr('1. CREATOR ROW');
  const { data: creators, error: cErr } = await supa
    .from('creators')
    .select(
      'id, display_name, handle, retrieval_version, brain_mode, decoupled, tts_provider, voice_id, system_prompt',
    )
    .eq('id', creatorId);
  if (cErr) {
    console.error('creators query error:', cErr);
    return;
  }
  for (const c of creators) {
    console.log({
      id: c.id,
      handle: c.handle,
      display_name: c.display_name,
      retrieval_version: c.retrieval_version,
      brain_mode: c.brain_mode,
      decoupled: c.decoupled,
      tts_provider: c.tts_provider,
      voice_id: c.voice_id ? c.voice_id.slice(0, 12) + '...' : null,
      system_prompt_len: c.system_prompt ? c.system_prompt.length : 0,
      system_prompt_head: c.system_prompt ? c.system_prompt.slice(0, 200) : null,
    });
  }
  if (!creators.length) {
    console.error('No creator matched id; aborting');
    return;
  }

  hr('2. SAMPLE_CONTENT (raw ingested docs)');
  const { data: samples, error: sErr } = await supa
    .from('sample_content')
    .select('id, source_type, topic_tags, created_at')
    .eq('creator_id', creatorId)
    .order('created_at', { ascending: false });
  if (sErr) {
    console.error('sample_content query error:', sErr);
  } else {
    console.log(`Total sample_content rows: ${samples.length}`);
    for (const s of samples) {
      console.log({
        id: s.id.slice(0, 8),
        source_type: s.source_type,
        topic_tags: s.topic_tags,
        created_at: s.created_at,
      });
    }
  }

  hr('3. CORPUS_CHUNKS (embedded chunks, by chunker_version)');
  const { data: chunkStats, error: chErr } = await supa.rpc('exec_sql_readonly', {}).single();
  // The above might not exist; try a direct count instead via two queries.
  if (chErr || !chunkStats) {
    // Fallback: count via filter
    for (const ver of [1, 2]) {
      const { count, error } = await supa
        .from('sample_content_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('creator_id', creatorId)
        .eq('chunker_version', ver);
      console.log(`  chunker_version=${ver}: ${count ?? '?'} chunks (err=${error?.message || 'none'})`);
    }
  }

  hr('4. CHUNKS CONTAINING "twin" (substring match)');
  const { data: twinChunks, error: tErr } = await supa
    .from('sample_content_chunks')
    .select('id, chunker_version, parent_unit_id, text, sample_id')
    .eq('creator_id', creatorId)
    .ilike('text', '%twin%')
    .limit(10);
  if (tErr) {
    console.error('twin query error:', tErr);
  } else {
    console.log(`Twin-mentioning chunks: ${twinChunks.length}`);
    for (const c of twinChunks) {
      console.log({
        id: c.id.slice(0, 8),
        chunker_version: c.chunker_version,
        has_parent: c.parent_unit_id != null,
        sample_id: c.sample_id ? c.sample_id.slice(0, 8) : null,
        preview: c.text.slice(0, 200).replace(/\s+/g, ' '),
      });
    }
  }

  hr('5. CHUNKS CONTAINING "lumberjack" or "monk" or "hunter"');
  const { data: lumberChunks, error: lErr } = await supa
    .from('sample_content_chunks')
    .select('id, chunker_version, parent_unit_id, text')
    .eq('creator_id', creatorId)
    .or('text.ilike.%lumberjack%,text.ilike.%monk%,text.ilike.%hunter%')
    .limit(10);
  if (lErr) {
    console.error('lumber query error:', lErr);
  } else {
    console.log(`Lumberjack/monk/hunter chunks: ${lumberChunks.length}`);
    for (const c of lumberChunks) {
      console.log({
        id: c.id.slice(0, 8),
        chunker_version: c.chunker_version,
        has_parent: c.parent_unit_id != null,
        preview: c.text.slice(0, 200).replace(/\s+/g, ' '),
      });
    }
  }

  hr('6. RECENT SESSIONS (last 5)');
  const { data: sess, error: ssErr } = await supa
    .from('sessions')
    .select(
      'id, created_at, ended_at, retrieval_version_at_session, corpus_version_at_session, tier_at_session',
    )
    .eq('creator_id', creatorId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (ssErr) {
    console.error('sessions query error:', ssErr);
  } else {
    for (const s of sess) {
      console.log({
        id: s.id.slice(0, 8),
        created: s.created_at,
        ended: s.ended_at,
        retrieval_version_at_session: s.retrieval_version_at_session,
        corpus_version_at_session: s.corpus_version_at_session,
        tier: s.tier_at_session,
      });
    }
  }

  hr('7. RECENT COGS_LOG embedding rows (last 10 across all sessions)');
  const { data: cogs, error: cogsErr } = await supa
    .from('cogs_log')
    .select('created_at, session_id, service, operation, units, cost_usd, metadata')
    .eq('operation', 'embedding')
    .order('created_at', { ascending: false })
    .limit(10);
  if (cogsErr) {
    console.error('cogs_log query error:', cogsErr);
  } else {
    for (const r of cogs) {
      console.log({
        when: r.created_at,
        session: r.session_id ? r.session_id.slice(0, 8) : null,
        units: r.units,
        cost: r.cost_usd,
        passages_returned: r.metadata?.passages_returned,
        embed_ms: r.metadata?.embed_ms,
        search_ms: r.metadata?.search_ms,
        min_similarity: r.metadata?.min_similarity,
      });
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
