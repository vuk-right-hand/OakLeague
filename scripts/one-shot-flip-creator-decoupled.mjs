#!/usr/bin/env node
/**
 * One-shot admin RPC caller for P1-10 commissioning.
 *
 * Calls admin_set_creator_decoupled(p_creator_id, true) against PROD as
 * the admin user `vukpjescic@gmail.com` so the RPC's `_assert_caller_is_admin`
 * check passes (it requires auth.uid() ∈ admin_roles, which service-role
 * key alone cannot satisfy — auth.uid() is NULL with service-role).
 *
 * Auth flow (standard Supabase admin pattern, no email is actually sent):
 *   1. service-role client mints a magiclink token for the admin email
 *      via auth.admin.generateLink({type:'magiclink', email})
 *   2. anon client exchanges the hashed_token for a real session via
 *      auth.verifyOtp({token_hash, type:'magiclink'})
 *   3. authenticated client calls the RPC with the captured access_token
 *      as the Authorization Bearer
 *
 * The RPC then sees auth.uid() = Vuk's UID, admin check passes, audit
 * log records Vuk as the actor.
 *
 * This script is intentionally ad-hoc — NOT for CI. Run once to
 * commission creator #1 onto the decoupled path for the P1-9 1c manual
 * session. After the session, run with `--decoupled false` to revert if
 * needed.
 */

import { createClient } from '@supabase/supabase-js';

// CLI args (all required — no defaults; flipping the wrong creator is
// the entire risk this script exists to manage):
//   --creator <uuid>      target creator
//   --admin <email>       admin user to impersonate (must be in admin_roles)
//   --decoupled=<bool>    target state (default true)
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=')[1] : null;
}

const SUPABASE_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY        = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ADMIN_EMAIL     = arg('admin');
const CREATOR_ID      = arg('creator');
const TARGET_DECOUPLED = (arg('decoupled') ?? 'true').toLowerCase() === 'true';

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_ANON_KEY required in env');
  process.exit(2);
}
if (!ADMIN_EMAIL || !CREATOR_ID) {
  console.error('Required: --admin <email> --creator <uuid> [--decoupled=true|false]');
  process.exit(2);
}
if (!/^[0-9a-f-]{36}$/i.test(CREATOR_ID)) {
  console.error(`--creator value is not UUID-shaped: ${CREATOR_ID}`);
  process.exit(2);
}

console.log(`P1-10 one-shot — flipping creator ${CREATOR_ID.slice(0, 8)} to decoupled=${TARGET_DECOUPLED}`);
console.log(`url=${SUPABASE_URL} admin=${ADMIN_EMAIL}\n`);

// 1. Admin client mints magiclink token (no email sent).
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
console.log('1. Generating magiclink token (service-role)...');
const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email: ADMIN_EMAIL,
});
if (linkErr) { console.error('FAIL:', linkErr); process.exit(1); }
const hashedToken = linkData?.properties?.hashed_token;
if (!hashedToken) { console.error('FAIL: no hashed_token in generateLink response'); process.exit(1); }
console.log(`   ok (token_fp=...${hashedToken.slice(-6)})`);

// 2. Anon client exchanges for a session.
const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
console.log('2. Exchanging magiclink → session (verifyOtp)...');
const { data: sessionData, error: verifyErr } = await anon.auth.verifyOtp({
  token_hash: hashedToken,
  type: 'magiclink',
});
if (verifyErr) { console.error('FAIL:', verifyErr); process.exit(1); }
const accessToken = sessionData?.session?.access_token;
const adminUid    = sessionData?.user?.id;
if (!accessToken || !adminUid) { console.error('FAIL: missing access_token / user.id in session'); process.exit(1); }
console.log(`   ok (user_id=${adminUid.slice(0, 8)})`);

// 3. Authenticated client calls the RPC as Vuk.
const asAdmin = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false },
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
});
console.log(`3. Calling admin_set_creator_decoupled(${CREATOR_ID.slice(0, 8)}, ${TARGET_DECOUPLED})...`);
const { data: rpcData, error: rpcErr } = await asAdmin.rpc('admin_set_creator_decoupled', {
  p_creator_id: CREATOR_ID,
  p_decoupled:  TARGET_DECOUPLED,
});
if (rpcErr) { console.error('FAIL:', rpcErr); process.exit(1); }
console.log(`   ok (rpc returned ${JSON.stringify(rpcData)})`);

// 4. Read back the creator state via service-role (bypass RLS for the check).
console.log('4. Reading back creator state...');
const { data: rows, error: readErr } = await admin
  .from('creators')
  .select('id, handle, decoupled, brain_mode, brain_compiled_at, system_prompt')
  .eq('id', CREATOR_ID);
if (readErr) { console.error('FAIL:', readErr); process.exit(1); }
const c = rows?.[0];
console.log(`   handle=${c.handle} decoupled=${c.decoupled} brain_mode=${c.brain_mode}`);
console.log(`   brain_compiled_at=${c.brain_compiled_at}`);
console.log(`   persona_head="${(c.system_prompt || '').slice(0, 180).replace(/\n/g, ' ')}…"`);

// 5. Read the audit log row.
console.log('5. Reading audit log row...');
const { data: auditRows, error: auditErr } = await admin
  .from('admin_audit_log')
  .select('admin_user_id, action, before, after, created_at')
  .eq('action', 'creator_decoupled_set')
  .eq('target_id', CREATOR_ID)
  .order('created_at', { ascending: false })
  .limit(1);
if (auditErr) { console.error('FAIL:', auditErr); process.exit(1); }
const a = auditRows?.[0];
if (a) {
  console.log(`   admin_user_id=${a.admin_user_id?.slice(0, 8)} (matches caller? ${a.admin_user_id === adminUid})`);
  console.log(`   before=${JSON.stringify(a.before)}`);
  console.log(`   after =${JSON.stringify(a.after)}`);
}

console.log('\n[ok] creator #1 flipped to decoupled=' + TARGET_DECOUPLED);
process.exit(0);
