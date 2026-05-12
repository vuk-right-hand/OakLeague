#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Session id from Fly logs: 6f23b6d6-62fd-4de8-84f5-25d94f095570
const sessionId = '6f23b6d6-62fd-4de8-84f5-25d94f095570';

console.log(`retrievals for session ${sessionId}\n`);
const { data, error } = await supabase
  .from('cogs_log')
  .select('created_at, operation, units, cost_usd, metadata')
  .eq('session_id', sessionId)
  .eq('operation', 'embedding')
  .order('created_at');

if (error) {
  console.error('err:', error.message);
  process.exit(1);
}
for (const r of data ?? []) {
  console.log(`${r.created_at} | tokens=${r.units} | $${r.cost_usd}`);
  console.log(`  passages=${r.metadata?.passages_returned}, embed_ms=${r.metadata?.embed_ms}, search_ms=${r.metadata?.search_ms}`);
  console.log(`  k=${r.metadata?.k}, min_sim=${r.metadata?.min_similarity}, creator=${r.metadata?.creator_id?.slice(0,8)}`);
}

// Also look at session-level for the model's actual transcripts.
const { data: sess } = await supabase
  .from('sessions')
  .select('id, user_id, creator_id, tier_at_session, status, opened_at, closed_at')
  .eq('id', sessionId)
  .single();
console.log('\nsession row:', sess);
