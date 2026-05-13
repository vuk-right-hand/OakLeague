#!/usr/bin/env node
/**
 * Day-6 RAG SOTA — admin CLI to enqueue corpus_reprocess_jobs for every
 * ready sample of a creator. Bypasses the on-sample_content trigger's
 * retrieval_version gate so v1 creators can be re-processed into v2
 * chunks BEFORE flipping their retrieval_version.
 *
 * Equivalent to the "Re-process v2" button on /admin/creators/[id]. Use the
 * CLI for batch operations or staging dogfood; use the UI for one-off
 * production re-processes.
 *
 * Usage:
 *   node scripts/corpus-reprocess.mjs --creator-id <uuid> [--force] [--admin-id|--admin-email <ref>]
 *   node scripts/corpus-reprocess.mjs --handle <handle>   [--force] [--admin-id|--admin-email <ref>]
 *   node scripts/corpus-reprocess.mjs --all-v1            [--force] [--admin-id|--admin-email <ref>]
 *   node scripts/corpus-reprocess.mjs --all-v2            [--force] [--admin-id|--admin-email <ref>]
 *
 *   --creator-id    enqueue a single creator by uuid
 *   --handle        enqueue a single creator by handle (handy for "vuk")
 *   --all-v1        enqueue every creator currently at retrieval_version=1
 *                   — the Phase-1 dogfood path (re-process v1 corpora into
 *                     v2 chunks BEFORE flipping retrieval_version)
 *   --all-v2        enqueue every creator currently at retrieval_version=2
 *                   — use after a code change requires every v2 creator
 *                     to re-process from scratch
 *   --force         re-enqueue every job regardless of status (still skips
 *                   rows actively claimed <540s ago)
 *   --admin-id      audit-row admin user_id (preferred; uuid).
 *   --admin-email   audit-row admin email (best-effort lookup; admin_roles.email
 *                   is nullable + non-unique post-migration 20260420000025).
 *                   If neither is passed, defaults to the only active admin;
 *                   if multiple, --admin-id or --admin-email is required.
 *
 * Required env:
 *   SUPABASE_URL                  (e.g. https://<project>.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY     (service-role secret)
 *
 * Exits 0 on success, 1 on user error (bad args), 2 on RPC error.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const out = {
    creatorId: null,
    handle: null,
    allV1: false,
    allV2: false,
    force: false,
    adminUserId: null,
    adminEmail: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--creator-id') out.creatorId = argv[++i];
    else if (a === '--handle') out.handle = argv[++i];
    else if (a === '--all-v1') out.allV1 = true;
    else if (a === '--all-v2') out.allV2 = true;
    else if (a === '--force') out.force = true;
    else if (a === '--admin-id') out.adminUserId = argv[++i];
    else if (a === '--admin-email') out.adminEmail = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        `Usage: node scripts/corpus-reprocess.mjs ` +
        `(--creator-id <uuid> | --handle <h> | --all-v1 | --all-v2) ` +
        `[--force] [--admin-id <uuid>|--admin-email <addr>]`,
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  const targets = [
    out.creatorId,
    out.handle,
    out.allV1 ? 'v1' : null,
    out.allV2 ? 'v2' : null,
  ].filter(Boolean);
  if (targets.length !== 1) {
    console.error('Exactly one of --creator-id, --handle, --all-v1, or --all-v2 is required');
    process.exit(1);
  }
  if (out.creatorId && !UUID_RE.test(out.creatorId)) {
    console.error(`--creator-id must be a UUID, got: ${out.creatorId}`);
    process.exit(1);
  }
  if (out.adminUserId && !UUID_RE.test(out.adminUserId)) {
    console.error(`--admin-id must be a UUID, got: ${out.adminUserId}`);
    process.exit(1);
  }
  return out;
}

async function resolveAdminUserId(sb, adminUserId, adminEmail) {
  // Audit-1 M3: prefer --admin-id (uuid, primary key) over --admin-email
  // (display column that can be NULL and is non-unique).
  if (adminUserId) {
    const { data, error } = await sb
      .from('admin_roles')
      .select('user_id, email, revoked_at')
      .eq('user_id', adminUserId)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) throw new Error(`admin_roles lookup failed: ${error.message}`);
    if (!data) throw new Error(`No active admin with user_id ${adminUserId}`);
    return data.user_id;
  }
  if (adminEmail) {
    const { data, error } = await sb
      .from('admin_roles')
      .select('user_id, email, revoked_at')
      .eq('email', adminEmail)
      .is('revoked_at', null)
      .order('user_id', { ascending: true });
    if (error) throw new Error(`admin_roles lookup failed: ${error.message}`);
    if (!data || data.length === 0) {
      throw new Error(`No active admin with email ${adminEmail}`);
    }
    if (data.length > 1) {
      throw new Error(
        `${data.length} active admins share email ${adminEmail} ` +
        `(post-migration-0025 email is non-unique). Pass --admin-id instead.`,
      );
    }
    return data[0].user_id;
  }
  const { data, error } = await sb
    .from('admin_roles')
    .select('user_id, email, revoked_at')
    .is('revoked_at', null)
    .order('user_id', { ascending: true });
  if (error) throw new Error(`admin_roles lookup failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error('No active admins in admin_roles');
  }
  if (data.length > 1) {
    throw new Error(
      `${data.length} active admins; pass --admin-id <uuid> to disambiguate. ` +
      `Available: ` + data.map((r) => `${r.user_id}${r.email ? ` (${r.email})` : ''}`).join(', '),
    );
  }
  console.log(`using admin: ${data[0].user_id}${data[0].email ? ` (${data[0].email})` : ''}`);
  return data[0].user_id;
}

async function resolveTargets(sb, args) {
  if (args.creatorId) return [{ id: args.creatorId, handle: null }];
  if (args.handle) {
    const { data, error } = await sb
      .from('creators')
      .select('id, handle')
      .eq('handle', args.handle)
      .limit(1);
    if (error) throw new Error(`creators lookup failed: ${error.message}`);
    if (!data || data.length === 0) throw new Error(`No creator with handle ${args.handle}`);
    return [{ id: data[0].id, handle: data[0].handle }];
  }
  // --all-v1 or --all-v2 — Audit-1 C1: hard-fail on zero matches so an
  // operator who thinks there's work to do doesn't get a silent "all good"
  // when the target set is empty.
  const targetVersion = args.allV1 ? 1 : 2;
  const { data, error } = await sb
    .from('creators')
    .select('id, handle, retrieval_version')
    .eq('retrieval_version', targetVersion)
    .order('handle', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`creators lookup failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(
      `No creators at retrieval_version=${targetVersion}. ` +
      `If you meant the other version, pass --all-v${targetVersion === 1 ? 2 : 1}.`,
    );
  }
  return data.map((r) => ({ id: r.id, handle: r.handle }));
}

async function enqueueOne(sb, adminUserId, creatorId, handle, force) {
  const { data, error } = await sb.rpc('_admin_enqueue_corpus_reprocess_unsafe', {
    p_admin_user_id: adminUserId,
    p_creator_id:    creatorId,
    p_force:         force,
  });
  if (error) {
    const code = error.code ?? '';
    const msg = error.message ?? '';
    return { creatorId, handle, ok: false, code, msg };
  }
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
  if (!row) return { creatorId, handle, ok: false, code: 'no_result', msg: 'rpc returned empty' };
  return {
    creatorId,
    handle,
    ok: true,
    enqueued:        row.enqueued_count,
    total:           row.total_ready_samples,
    skipped:         row.skipped_in_flight,
    alreadyQueued:   row.skipped_already_queued ?? 0,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const adminUserId = await resolveAdminUserId(sb, args.adminUserId, args.adminEmail);
  const targets = await resolveTargets(sb, args);
  if (targets.length === 0) {
    // resolveTargets throws on zero matches for --all-v1/--all-v2 (audit-1 C1),
    // so this branch is only reachable in defensive paths.
    process.exit(0);
  }

  console.log(`enqueuing v2 re-process for ${targets.length} creator${targets.length === 1 ? '' : 's'} (force=${args.force})`);

  let totalEnqueued = 0;
  let totalSkipped = 0;
  let anyError = false;
  for (const t of targets) {
    const res = await enqueueOne(sb, adminUserId, t.id, t.handle, args.force);
    const label = t.handle ? `@${t.handle} (${t.id.slice(0, 8)})` : t.id;
    if (!res.ok) {
      console.error(`  ✗ ${label}: ${res.code} ${res.msg}`);
      anyError = true;
      continue;
    }
    console.log(
      `  ✓ ${label}: enqueued ${res.enqueued}/${res.total}` +
      (res.alreadyQueued ? ` · ${res.alreadyQueued} already queued` : '') +
      (res.skipped ? ` · skipped ${res.skipped} in-flight` : ''),
    );
    totalEnqueued += res.enqueued;
    totalSkipped += res.skipped;
  }

  console.log(`\ntotal enqueued: ${totalEnqueued} · skipped in-flight: ${totalSkipped}`);
  if (anyError) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(2);
});
