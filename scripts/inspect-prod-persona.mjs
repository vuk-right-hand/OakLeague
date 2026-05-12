#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const { data } = await supabase.from('creators').select('id, brain_mode, system_prompt, brain_compiled_at').eq('handle', 'vuk_lehendas').single();
console.log('brain_mode:', data.brain_mode);
console.log('compiled_at:', data.brain_compiled_at);
console.log('length:', data.system_prompt.length, 'chars');
console.log('\n--- system_prompt ---');
console.log(data.system_prompt);
console.log('--- end ---\n');
console.log('contains "ALWAYS ask one short clarifier":', data.system_prompt.includes('ALWAYS ask one short clarifier'));
console.log('contains "{{user_name}}":', data.system_prompt.includes('{{user_name}}'));

// Also probe a known-good retrieval to verify chunks return.
const { data: probe1 } = await supabase
  .from('sample_content_chunks')
  .select('id, LEFT(text, 100)::text AS preview')
  .eq('creator_id', data.id)
  .limit(5);
console.log('\nfirst 5 chunks (preview):');
// .select() with computed isn't supported via PostgREST that way — use raw text slice client-side.
const { data: chunks } = await supabase
  .from('sample_content_chunks')
  .select('id, chunk_index, text')
  .eq('creator_id', data.id)
  .order('chunk_index')
  .limit(3);
for (const c of chunks ?? []) console.log(`  #${c.chunk_index}: ${c.text.slice(0, 200)}…`);
