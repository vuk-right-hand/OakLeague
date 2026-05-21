#!/usr/bin/env node
/**
 * One-shot admin RPC caller for retrieval_version flip — Day-14 dogfood gate.
 *
 * Calls admin_set_creator_retrieval_version(p_creator_id, 1|2) against PROD
 * as an admin user so the RPC's `_assert_caller_is_admin` check passes.
 * Same magic-link → verifyOtp → bearer-auth pattern as
 * one-shot-flip-creator-decoupled.mjs.
 *
 * Usage:
 *   node --env-file=.env.local scripts/one-shot-flip-creator-retrieval-version.mjs \
 *     --admin <email> --creator <uuid> --version <1|2>
 */

import { createClient } from '@supabase/supabase-js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=')[1] : null;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ADMIN_EMAIL  = arg('admin');
const CREATOR_ID   = arg('creator');
const VERSION      = Number(arg('version'));

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_ANON_KEY required in env');
  process.exit(2);
}
if (!ADMIN_EMAIL || !CREATOR_ID || ![1, 2].includes(VERSION)) {
  console.error('Required: --admin <email> --creator <uuid> --version <1|2>');
  process.exit(2);
}
if (!/^[0-9a-f-]{36}$/i.test(CREATOR_ID)) {
  console.error(`--creator value is not UUID-shaped: ${CREATOR_ID}`);
  process.exit(2);
}

console.log(`Day-14 flip — creator ${CREATOR_ID.slice(0, 8)} → retrieval_version=${VERSION}`);
console.log(`url=${SUPABASE_URL} admin=${ADMIN_EMAIL}\n`);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
console.log('1. Generating magiclink token (service-role)...');
const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email: ADMIN_EMAIL,
});
if (linkErr) { console.error('FAIL:', linkErr); process.exit(1); }
const hashedToken = linkData?.properties?.hashed_token;
if (!hashedToken) { console.error('FAIL: no hashed_token'); process.exit(1); }
console.log(`   ok (token_fp=...${hashedToken.slice(-6)})`);

const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
console.log('2. Exchanging magiclink → session (verifyOtp)...');
const { data: sessionData, error: verifyErr } = await anon.auth.verifyOtp({
  token_hash: hashedToken,
  type: 'magiclink',
});
if (verifyErr) { console.error('FAIL:', verifyErr); process.exit(1); }
const accessToken = sessionData?.session?.access_token;
const adminUid    = sessionData?.user?.id;
if (!accessToken || !adminUid) { console.error('FAIL: missing access_token / user.id'); process.exit(1); }
console.log(`   ok (user_id=${adminUid.slice(0, 8)})`);

const asAdmin = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false },
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
});
console.log(`3. Calling admin_set_creator_retrieval_version(${CREATOR_ID.slice(0, 8)}, ${VERSION})...`);
const { data: rpcData, error: rpcErr } = await asAdmin.rpc('admin_set_creator_retrieval_version', {
  p_creator_id: CREATOR_ID,
  p_version:    VERSION,
});
if (rpcErr) { console.error('FAIL:', rpcErr); process.exit(1); }
console.log(`   ok (rpc returned ${JSON.stringify(rpcData)})`);

console.log('4. Reading back creator state...');
const { data: rows, error: readErr } = await admin
  .from('creators')
  .select('id, handle, retrieval_version, brain_mode, decoupled, brain_compiled_at')
  .eq('id', CREATOR_ID);
if (readErr) { console.error('FAIL:', readErr); process.exit(1); }
const c = rows?.[0];
console.log(`   handle=${c.handle} retrieval_version=${c.retrieval_version} brain_mode=${c.brain_mode} decoupled=${c.decoupled}`);
console.log(`   brain_compiled_at=${c.brain_compiled_at}`);

console.log('5. Reading audit log row...');
const { data: auditRows } = await admin
  .from('admin_audit_log')
  .select('admin_user_id, action, before, after, created_at')
  .eq('action', 'creator_retrieval_version_set')
  .eq('target_id', CREATOR_ID)
  .order('created_at', { ascending: false })
  .limit(1);
const a = auditRows?.[0];
if (a) {
  console.log(`   admin=${a.admin_user_id?.slice(0, 8)} before=${JSON.stringify(a.before)} after=${JSON.stringify(a.after)}`);
}

console.log(`\n[ok] creator flipped to retrieval_version=${VERSION}`);
process.exit(0);
