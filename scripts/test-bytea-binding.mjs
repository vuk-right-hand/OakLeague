import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const SUPABASE_URL = 'http://localhost:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const hash = createHash('sha256').update('test', 'utf8').digest();
console.log('Buffer len:', hash.length, 'JSON shape:', JSON.stringify(hash).slice(0, 80));

const vec = new Array(768).fill(0);
vec[0] = 1;
const vecText = '[' + vec.join(',') + ']';

// Use a real creator_id by looking it up.
const { data: creators } = await client.from('creators').select('id, current_corpus_version').limit(1);
const creatorId = creators?.[0]?.id;
const cv = creators?.[0]?.current_corpus_version || 1;
if (!creatorId) { console.error('No creator found in DB'); process.exit(1); }
console.log('using creator:', creatorId, 'cv:', cv);

// Need real parent unit too
const { data: units } = await client.from('sample_content_narrative_units').select('id').eq('creator_id', creatorId).limit(1);
const parentId = units?.[0]?.id || '00000000-0000-0000-0000-000000000000';
console.log('parent_unit_id:', parentId);

// Test 1: Buffer
const { data, error } = await client.rpc('semantic_query_cache_upsert', {
  p_creator_id: creatorId,
  p_corpus_version: cv,
  p_query_vec: vecText,
  p_query_text_hash: hash,
  p_parent_unit_ids: [parentId],
  p_scores: [0.9],
  p_ttl_seconds: 3600,
});
console.log('Buffer arg result:', { data, error });

// Test 2: hex string with double-backslash
const hexHash = String.fromCharCode(0x5c) + 'x' + hash.toString('hex');
const { data: d2, error: e2 } = await client.rpc('semantic_query_cache_upsert', {
  p_creator_id: creatorId,
  p_corpus_version: cv,
  p_query_vec: vecText,
  p_query_text_hash: hexHash,
  p_parent_unit_ids: [parentId],
  p_scores: [0.95],
  p_ttl_seconds: 3600,
});
console.log('hex string arg result:', { data: d2, error: e2 });

// Test 3: base64 string
const b64 = hash.toString('base64');
const { data: d3, error: e3 } = await client.rpc('semantic_query_cache_upsert', {
  p_creator_id: creatorId,
  p_corpus_version: cv,
  p_query_vec: vecText,
  p_query_text_hash: b64,
  p_parent_unit_ids: [parentId],
  p_scores: [0.8],
  p_ttl_seconds: 3600,
});
console.log('base64 arg result:', { data: d3, error: e3 });

// Cleanup any rows we created
await client.from('semantic_query_cache').delete().eq('creator_id', creatorId);
