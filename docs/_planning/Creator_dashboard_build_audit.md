Implementation audit complete. 5 Criticals, 8 Mediums, 11 Smalls.

Criticals
C1. Migration 0039 silently added a hooks table branch beyond plan scope.

supabase/migrations/20260420000039_creator_topics_delete_orphan_guard.sql:19-26 blocks DELETE if hooks.topic_tags references the slug. Plan line 14 only specified sample_content.
Once hooks ship, creators will hit undeleteable topics with no dashboard remediation path. Either remove the hooks branch or add "remove hook" UI.
C2. SSRF validator doesn't check u.port — port scanning enabled.

src/lib/creator/validate-url.ts:49-122 never inspects port. Test at validate-url.test.ts:112 explicitly accepts https://example.com:22/.
Fetcher will emit probes to SSH/Redis/Postgres ports on any host. Fix: whitelist u.port === '' || u.port === '443'.
C3. deleteSampleContent aliases RLS-session-stale to not_found.

src/app/creator/brain/actions.ts:290-299: caller resolved via supabaseAdmin() (bypasses RLS), delete uses supabaseServer() (RLS-scoped). If cookie expired mid-page, RLS filters out the row → data: [] → user sees "Not found" when the row exists and they own it.
Plan's C4-R2 fix (.select('id')) addresses wrong-owner only, not stale-session. Fix: admin-client SELECT ownership check first, or DELETE via admin with explicit creator_id WHERE.
C4. deleteTopic has the same stale-session aliasing.

src/app/creator/brain/actions.ts:164-207: all four queries (slug fetch, refs check, delete) on supabaseServer(). Stale session → topic.slug fetch returns null → { error: 'not_found' } despite ownership.
C5. Migration 0039 lacks SECURITY DEFINER + pinned search_path despite plan requirement.

supabase/migrations/20260420000039_...sql:8-28: header comment says "no SECURITY DEFINER" but plan line 16 required it. The function reads public.sample_content, public.hooks, public.videos with no SET search_path = public, pg_temp. Matches precedent (0012) but contradicts the plan — reconcile.
Mediums
M1. BrainStatusBadge doesn't reset exponential backoff on success.

src/components/creator/BrainStatusBadge.tsx:29-40: one transient 5xx permanently degrades polling to 60s for the session. Fix: delayRef.current = POLL_INITIAL_MS in the success branch.
M2. Plan said SWR, code uses raw setTimeout.

BrainStatusBadge.tsx:1-50 has no SWR import. Functionally acceptable (cleanup via cancelled flag is correct), but plan explicitly required SWR with refreshInterval + revalidateOnFocus: false. Update plan or swap to SWR.
M3. addSampleContent accepts empty-string topic tags.

src/app/creator/brain/actions.ts:78: z.array(z.string()).min(1) accepts [''], [' ']. DB trigger rejects with invalid_topic_tags but the label ("not registered for your account") misleads. Add .min(2).max(40).regex(SLUG_RE) per element.
M4. addTopic error-match '5 topics' is brittle substring matching.

actions.ts:143-146 matches prose from RAISE EXCEPTION. Works today; prefer matching a stable error code.
M5. brain-ui.tsx accordion uses raw <details>, not shadcn/ui.

src/app/creator/brain/brain-ui.tsx:142-157. Plan line 168 explicitly required shadcn/ui Accordion. Native <details> lacks aria-expanded, arrow-key navigation, and focus ring. Test checklist line 281 cannot pass as written.
M6. slugify regex is broken — strips spaces instead of preserving them.

src/app/creator/brain/brain-ui.tsx:27: /[^a-z0-9_-\s]/g — the dash position creates an ambiguous range. Actual runtime behavior: "Go To Market" → "gotomarket", not "go_to_market" as the next line expects. Fix: /[^a-z0-9_\s-]/g (move dash to end).
M7. No error.tsx or loading.tsx for /creator or /creator/brain.

A Supabase blip throws creator_fetch_failed from get-creator.ts:23, propagates past layout catch (not AuthGuardError), shows Next's generic error page. DB fetches block with no skeleton.
M8. Hard-stop at 10 min leaves badge showing stale "training" state.

BrainStatusBadge.tsx:25-28: stops polling but last-known status persists. User sees "Training your brain… — refresh to check" indefinitely.
Smalls
S1. get-creator.ts:13-20 runs two admin queries per request — assertCreatorFromSession() already resolves creator-by-user, then getCreatorForCaller re-queries.
S2. coerceToIpv4 is partially dead code — Node's WHATWG URL pre-canonicalizes 2130706433 and 127.1 before reaching the validator. Tests pass via upstream canonicalization, not the helper. Add direct-call tests or document as defense-in-depth.
S3. layout.tsx:11-17 — if AuthGuardError has status=500, falls through to throw e. Acceptable but unstated.
S4. addTopicSchema reverses plan's transform order (trim before toLowerCase). Equivalent since whitespace is case-invariant.
S5. /api/creator/brain-status/route.ts:5 missing export const runtime = 'nodejs' pin.
S6. topic_tags not deduped in addSampleContent:254-261. ['a', 'a'] inserted verbatim.
S7. BrainStatusBadge:42 initial 10s delay even when initialStatus === 'training' at SSR. Consider immediate kickoff.
S8. SampleFetchBadge:30-32: training case falls through to "Pending" — if fetcher ever emits it, user can't distinguish from real pending.
S9. get-creator.ts:22-24 throws plain Error('creator_fetch_failed'). Hard-deleted creator row with live session → 500, not graceful redirect.
S10. addSampleContent:227-229 — SOURCE_TYPES.includes check is dead code after the zod enum validation at line 54-60.
S11. Error mapping relies on RAISE EXCEPTION prose matching. Migrate to SQLSTATE custom codes when convenient.
Priority order to fix before shipping: C2 (port SSRF), C3/C4 (stale-session aliasing), C1 (hooks scope creep), M6 (slugify broken), M5 (accordion a11y), then C5 and mediums. C2 and M6 are real runtime bugs; C3/C4 mask real errors in prod.