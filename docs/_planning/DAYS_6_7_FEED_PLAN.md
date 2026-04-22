---
title: Days 6-7 — Mux + Vertical Feed + Welcome Hook
dates: 2026-04-25 → 2026-04-26
deliverable: "Stranger can scroll on a physical phone."
status: post-audit-4; ready-for-approval
audits_completed: 4
rate_limit_feed_api: 120/min/IP

decisions_locked_on: 2026-04-21
---

# Days 6-7 — Feed Plan (v3, post-audit-3)

**Scope (from `docs/OAKLEAGUE_WALKTHROUGH.md` §8 Day 6-7):** Mux account + upload tooling, `videos` + `hooks` populated with founder content, vertical 9:16 feed with gesture handling, welcome hook on first open. **Deliverable:** stranger can scroll on a physical phone.

**Planning provenance:** 3 auditor rounds. Round 1 surfaced RLS column leakage, webhook client confusion, idempotency race, Sentry leakage, upload URL expiry. Round 2 surfaced UUID GRANT semantics (→ view with `security_invoker`), XFF spoofing, stale-asset replay. Round 3 surfaced passthrough type contradiction, REVOKE breaking admin RSC + realtime, mint-URL route auth, XFF off-Vercel, aspect-ratio normalization, publish-guard on INSERT, welcome-hook swap atomicity, SW bypass, captions, pg_cron, peer deps. All Critical resolved in this document.

---

## 1. Decisions (locked 2026-04-21)

| Id | Decision | Locked value | Notes |
|---|---|---|---|
| F1 | Playback policy v1 | **public** | Signed URLs deferred to v2 with tier gating. v1 plan does not mint or accept signing-key env vars (stubs commented in §6). |
| F2 | Root `/` becomes feed | **yes** | Current waitlist splash relocates to `/waitlist` before feed ships. Root = feed from Day 7 onward. |
| F3 | Founder content | **3 videos × 5 hooks = 15 hooks, real** | Vuk has existing YouTube catalog to re-cut + will record deltas. Seed-content fallback removed from critical path; `is_seed_content` column stays in schema as an insurance pressure valve but feed query ships with `p_include_seed = false` hardcoded in v1. |
| F4 | Mux `mp4_support` | **`'none'`** | HLS-only. Per Vuk: matches YouTube's approach; we do not want to render a 40-min source when viewer watches 10s. No per-asset MP4 fee. |
| F5 | Desktop keyboard nav | **yes** | Arrow-up / arrow-down between vertical panels; arrow-left / arrow-right between lessons inside a video row. Spec in §8. |

---

## 2. Schema changes

### 2.1 Migration `20260425000001_mux_upload_tracking.sql`

```sql
-- Passthrough: bare UUID. Mux echoes it on every webhook. RPC dispatches
-- by looking up hooks first, then welcome_hooks.

-- Boolean admin helper for RLS USING expressions. Uses existing admin_roles
-- (user_id PK, revoked_at column) from migration 0025.
CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_roles
    WHERE user_id = p_uid AND revoked_at IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated, service_role;

ALTER TABLE hooks
  ADD COLUMN mux_upload_id text,
  ADD COLUMN mux_asset_id text UNIQUE,
  ADD COLUMN mux_playback_id text,  -- NULL until asset.ready
  ADD COLUMN mux_status text NOT NULL DEFAULT 'pending'
    CHECK (mux_status IN ('pending','uploading','processing','ready','failed')),
  ADD COLUMN mux_aspect_ratio text,  -- normalized '9:16' etc
  ADD COLUMN mux_duration_ms integer,
  ADD COLUMN mux_passthrough uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN processing_error text,
  ADD COLUMN is_seed_content boolean NOT NULL DEFAULT false;

ALTER TABLE welcome_hooks
  ADD COLUMN mux_upload_id text,
  ADD COLUMN mux_asset_id text UNIQUE,
  ADD COLUMN mux_playback_id text,
  ADD COLUMN mux_status text NOT NULL DEFAULT 'pending'
    CHECK (mux_status IN ('pending','uploading','processing','ready','failed')),
  ADD COLUMN mux_aspect_ratio text,
  ADD COLUMN mux_duration_ms integer,
  ADD COLUMN mux_passthrough uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN processing_error text;

CREATE INDEX idx_hooks_seed ON hooks(is_seed_content) WHERE is_seed_content = true;

-- Backfill: any pre-existing hook row that already has a playback id
-- was uploaded before this migration. Mark it ready so it survives the
-- hooks_public filter.
UPDATE hooks    SET mux_status = 'ready' WHERE mux_playback_id IS NOT NULL;
UPDATE welcome_hooks SET mux_status = 'ready' WHERE mux_playback_id IS NOT NULL;

-- Admin RLS policy — RSC admin reads via `authenticated` role.
-- Uses existing assert_admin(uid) helper.
CREATE POLICY hooks_admin_all ON hooks
  FOR ALL TO authenticated
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY welcome_hooks_admin_all ON welcome_hooks
  FOR ALL TO authenticated
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- Public-facing views strip sensitive Mux internals AND seed content.
-- Seed is excluded at the view layer, not just the RPC, so raw anon
-- SELECTs cannot see placeholder rows (audit R3-M6).
CREATE VIEW hooks_public WITH (security_invoker = true) AS
  SELECT id, video_id, lesson_number, title, caption, transcript,
         mux_playback_id, mux_duration_ms, topic_tags, created_at
  FROM hooks
  WHERE mux_status = 'ready' AND is_seed_content = false;

CREATE VIEW welcome_hooks_public WITH (security_invoker = true) AS
  SELECT w.id, w.video_id, w.hook_id, w.active, w.mux_playback_id,
         h.caption, h.transcript, h.mux_duration_ms
  FROM welcome_hooks w
  JOIN hooks h ON h.id = w.hook_id
  WHERE w.active = true
    AND w.mux_status = 'ready'
    AND h.is_seed_content = false;

GRANT SELECT ON hooks_public, welcome_hooks_public TO anon, authenticated;

-- Publish guard: fire on INSERT and UPDATE.
CREATE OR REPLACE FUNCTION guard_published_requires_ready_hooks()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published_at IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM hooks
      WHERE video_id = NEW.id AND mux_status = 'ready'
    ) THEN
      RAISE EXCEPTION 'Cannot publish video %: no ready hooks', NEW.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER videos_publish_guard
  BEFORE INSERT OR UPDATE OF published_at ON videos
  FOR EACH ROW EXECUTE FUNCTION guard_published_requires_ready_hooks();

-- Atomic swap for the one active welcome hook.
CREATE OR REPLACE FUNCTION set_active_welcome_hook(p_welcome_hook_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE welcome_hooks SET active = false WHERE active = true;
  UPDATE welcome_hooks SET active = true WHERE id = p_welcome_hook_id;
END;
$$;
REVOKE ALL ON FUNCTION set_active_welcome_hook(uuid) FROM public;
GRANT EXECUTE ON FUNCTION set_active_welcome_hook(uuid) TO authenticated;
```

### 2.2 Migration `20260425000002_mux_webhook_events.sql`

Idempotency ledger + dispatcher RPC. Aspect-ratio normalization lives in the RPC.

```sql
CREATE TABLE mux_webhook_events (
  id text PRIMARY KEY,               -- Mux event id
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  payload jsonb NOT NULL
);
ALTER TABLE mux_webhook_events ENABLE ROW LEVEL SECURITY;
-- Zero policies: service-role-only.

CREATE OR REPLACE FUNCTION normalize_aspect_ratio(raw text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE w numeric; h numeric; ratio numeric;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  IF raw ~ '^\d+:\d+$' THEN
    w := split_part(raw, ':', 1)::numeric;
    h := split_part(raw, ':', 2)::numeric;
    IF h = 0 THEN RETURN raw; END IF;
    ratio := w / h;
    IF ratio BETWEEN 0.55 AND 0.58 THEN RETURN '9:16'; END IF;
    IF ratio BETWEEN 1.77 AND 1.78 THEN RETURN '16:9'; END IF;
  END IF;
  RETURN raw;
END;
$$;

CREATE OR REPLACE FUNCTION apply_mux_event(
  p_event_id text, p_type text, p_payload jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_passthrough uuid;
  v_asset_id text;
  v_playback_id text;
  v_aspect text;
  v_duration_ms integer;
  v_error text;
  v_target text;  -- 'hook' | 'welcome_hook'
BEGIN
  INSERT INTO mux_webhook_events (id, type, payload)
  VALUES (p_event_id, p_type, p_payload)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN RETURN; END IF;  -- duplicate; no-op

  -- Mux nests passthrough differently per event family:
  --   video.asset.*  → data.passthrough
  --   video.upload.* → data.new_asset_settings.passthrough  (historically),
  --                    with data.passthrough sometimes also populated.
  -- Read asset path first, fall back to upload path.
  v_passthrough := NULLIF(COALESCE(
    p_payload #>> '{data,passthrough}',
    p_payload #>> '{data,new_asset_settings,passthrough}'
  ), '')::uuid;
  IF v_passthrough IS NULL THEN
    UPDATE mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
    RETURN;
  END IF;

  -- Dispatch: hook first, then welcome_hook.
  SELECT 'hook' INTO v_target FROM hooks WHERE mux_passthrough = v_passthrough;
  IF v_target IS NULL THEN
    SELECT 'welcome_hook' INTO v_target FROM welcome_hooks WHERE mux_passthrough = v_passthrough;
  END IF;
  IF v_target IS NULL THEN
    UPDATE mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
    RETURN;
  END IF;

  v_asset_id    := p_payload #>> '{data,id}';
  v_playback_id := p_payload #>> '{data,playback_ids,0,id}';
  v_aspect      := normalize_aspect_ratio(p_payload #>> '{data,aspect_ratio}');
  v_duration_ms := CASE
    WHEN p_payload #>> '{data,duration}' IS NOT NULL
    THEN ((p_payload #>> '{data,duration}')::numeric * 1000)::integer
    ELSE NULL END;
  v_error       := p_payload #>> '{data,errors,messages,0}';

  IF v_target = 'hook' THEN
    UPDATE hooks SET
      mux_status = CASE p_type
        WHEN 'video.asset.ready'   THEN 'ready'
        WHEN 'video.asset.errored' THEN 'failed'
        WHEN 'video.asset.created' THEN 'processing'
        WHEN 'video.upload.cancelled' THEN 'failed'
        ELSE mux_status END,
      mux_asset_id     = COALESCE(v_asset_id, mux_asset_id),
      mux_playback_id  = COALESCE(v_playback_id, mux_playback_id),
      mux_aspect_ratio = COALESCE(v_aspect, mux_aspect_ratio),
      mux_duration_ms  = COALESCE(v_duration_ms, mux_duration_ms),
      processing_error = v_error
    WHERE mux_passthrough = v_passthrough
      -- Stale-asset guard: allow update when we haven't seen an asset id yet,
      -- when the stored id matches this event, OR when the event itself
      -- carries no asset id (e.g. video.upload.cancelled before creation).
      AND (
        mux_asset_id IS NULL
        OR v_asset_id IS NULL
        OR mux_asset_id = v_asset_id
      );
  ELSE
    UPDATE welcome_hooks SET
      mux_status = CASE p_type
        WHEN 'video.asset.ready'   THEN 'ready'
        WHEN 'video.asset.errored' THEN 'failed'
        WHEN 'video.asset.created' THEN 'processing'
        WHEN 'video.upload.cancelled' THEN 'failed'
        ELSE mux_status END,
      mux_asset_id     = COALESCE(v_asset_id, mux_asset_id),
      mux_playback_id  = COALESCE(v_playback_id, mux_playback_id),
      mux_aspect_ratio = COALESCE(v_aspect, mux_aspect_ratio),
      mux_duration_ms  = COALESCE(v_duration_ms, mux_duration_ms),
      processing_error = v_error
    WHERE mux_passthrough = v_passthrough
      -- Stale-asset guard: allow update when we haven't seen an asset id yet,
      -- when the stored id matches this event, OR when the event itself
      -- carries no asset id (e.g. video.upload.cancelled before creation).
      AND (
        mux_asset_id IS NULL
        OR v_asset_id IS NULL
        OR mux_asset_id = v_asset_id
      );
  END IF;

  UPDATE mux_webhook_events SET processed_at = now() WHERE id = p_event_id;
END;
$$;
REVOKE ALL ON FUNCTION apply_mux_event(text, text, jsonb) FROM public;
-- Service-role only. No GRANTs.
```

### 2.3 Migration `20260425000003_ratelimit_cleanup_pgcron.sql`

```sql
-- Supabase requires pg_cron to live in the `extensions` schema, and the
-- extension must be enabled via the dashboard (Database → Extensions) or
-- a prior migration. This migration only registers the job.
--
-- PREREQ (one-time, via Supabase dashboard):
--   1. Database → Extensions → enable `pg_cron`.
--   2. Confirm `extensions.cron.job` is queryable.
--
-- Column is `window_start` (verified against migration 0032), NOT created_at.

SELECT extensions.cron.schedule(
  'rate_limit_log_purge',
  '17 3 * * *',
  $$ DELETE FROM public.rate_limit_log
     WHERE window_start < now() - interval '24 hours' $$
);
```

If pg_cron isn't available at migrate time, fall back to a Vercel Cron
hitting `/api/admin/ratelimit-purge` (admin-gated, service-role client).
Plan ships with pg_cron as the primary path.

---

## 3. Feed query RPC

Keyset-paginated. Reads `hooks_public` (seed already filtered at view
level — see §2.1) joined to `videos` and `creators`. The joined tables'
anon-read policies are **already in place**:

- `videos` — policy `videos public read when published` (migration 0014) exposes rows where `published_at IS NOT NULL`.
- `creators` — policy `creators public read when published` (migration 0011).

Because `hooks_public` is `security_invoker=true`, RLS on `videos` and
`creators` fires in the caller's context. v1 feed is public, so anon
sees published videos + their creators — no additional policies needed.

RPC is `STABLE` (not `SECURITY DEFINER`) so it inherits caller RLS. v1
signature ships with seed inclusion hardcoded off:

```sql
CREATE OR REPLACE FUNCTION feed_page(
  p_cursor_created_at timestamptz,
  p_cursor_id uuid,
  p_limit int DEFAULT 10
) RETURNS TABLE (...) LANGUAGE sql STABLE AS $$
  SELECT ... FROM hooks_public h  -- seed already filtered
  JOIN videos v   ON v.id = h.video_id   -- anon sees only published
  JOIN creators c ON c.id = v.creator_id -- anon sees only published
  WHERE (p_cursor_created_at IS NULL OR (h.created_at, h.id) < (p_cursor_created_at, p_cursor_id))
  ORDER BY h.created_at DESC, h.id DESC
  LIMIT LEAST(p_limit, 50);
$$;
GRANT EXECUTE ON FUNCTION feed_page(timestamptz, uuid, int) TO anon, authenticated;
```

Admin content console reads the base `hooks` table directly (via the
admin RLS policy added in §2.1) so it sees all hooks regardless of
seed/status — no seed-inclusion flag needed at the RPC.

---

## 4. Dependencies

```
npm i @mux/mux-node@^12 @mux/mux-uploader-react@^1 @mux/mux-player-react@^3
```

`@mux/mux-player-react` bundles its own hls.js — do **not** install hls.js
separately (avoids a duplicate copy in the bundle). Before install,
verify `@mux/mux-player-react@^3` peerDeps accept `react@^19`. If not,
either bump target to the prerelease that supports 19 or carry
`--legacy-peer-deps` in a `.npmrc` note for CI.

---

## 5. Files

### Server
- `src/lib/mux/client.ts` — `muxServer()` singleton from `@mux/mux-node`.
- `src/lib/mux/upload.ts` — `createDirectUpload({ passthrough, corsOrigin })` (timeout=3600, `mp4_support: 'none'`).
- `src/lib/mux/webhook.ts` — `verifyAndParse(req)` uses `mux.webhooks.unwrap()`; 256KB body cap via `Buffer.byteLength`.
- `src/lib/mux/costs.ts` — `logMuxCogs(...)` wrapper for `cogs_log` writes.
- `src/lib/ip.ts` — `getClientIp(req)` prefers `x-real-ip`, falls back to `x-forwarded-for[0]` trimmed to 45 chars. Documented as Vercel-edge-required.

### Routes
- `src/app/api/webhooks/mux/route.ts` — Node runtime, `supabaseAdmin()` service-role, verify → RPC `apply_mux_event` → 200.
- `src/app/api/admin/mux-upload/route.ts` — POST, **calls `assertAdminFromSession()` inside handler**; mints direct upload URL on click (not on page mount).
- `src/app/api/feed/route.ts` — cursor-pagination, rate-limited **120/min/IP** via `rate_limit_hit(scope='feed_api', key=<ip>, window='1 minute', limit=120)`. Rationale (R4-M4): budget is unaffected (Mux egress is decoupled from this API), 120 eliminates shared-IP breakage at WeWork / dorm / family-router scale and prevents any fast-scroll UX glitch during the YC demo. Tightening later is a one-line RPC arg change.

### Admin console
- `src/app/admin/content/videos/page.tsx` — list
- `src/app/admin/content/videos/new/page.tsx` — create shell
- `src/app/admin/content/videos/[id]/page.tsx` — hooks grid, per-hook upload (`MuxUploader` + async `endpoint` resolver), realtime subscribe to `hooks` (admin RLS policy makes this work)
- `src/app/admin/content/videos/[id]/publish/page.tsx` — publish + seed-flag toggle
- `src/app/admin/content/welcome/page.tsx` — pick active welcome hook via `set_active_welcome_hook(id)` RPC

### Feed UI (root)
- `src/app/page.tsx` — SSR first page of feed, hydrate to client.
- `src/app/(feed)/feed-container.tsx` — `'use client'`; IntersectionObserver (threshold 0.9) + scroll-snap + `scrollend` (desktop fallback: pointerType-keyed debounce) + arrow-key nav.
- `src/app/(feed)/video-row.tsx` — horizontal lesson strip per video.
- `src/app/(feed)/hook-panel.tsx` — single hook; `MuxPlayer` mounted only when active window, `src=null` when leaving window, unmounted entirely when >3 away.
- `src/app/(feed)/caption-overlay.tsx` — captions from `hooks_public.caption`; respects `prefers-reduced-motion`.
- `src/app/(feed)/welcome-overlay.tsx` — per-hook-id `localStorage` key `oak_welcome_seen:${welcome.id}`.
- `src/app/(feed)/use-active-panel.ts` — dual observer (vertical + horizontal both ≥0.9).
- `src/app/(feed)/use-unmute-preference.ts` — `sessionStorage` flag; first unmute sticks.

### Splash relocation + kill switch
- `src/app/waitlist/page.tsx` — moved from current root. Splash stays live at this URL permanently (linked from footer etc).
- `src/app/page.tsx` — root checks `NEXT_PUBLIC_FEED_ENABLED`. If `'1'`, renders feed SSR. If `'0'` or unset, redirects to `/waitlist`. **This is the demo-day kill switch** — flip the env var in Vercel to instantly revert root to splash without a deploy. No code change, no migration rollback.

### Service worker
- `public/sw.js` — explicit bypass: requests to `stream.mux.com`, `image.mux.com`, `inferred.litix.io`, `cdn.mux.com` are passthrough, never cached.

---

## 6. Env additions

```
MUX_TOKEN_ID=
MUX_TOKEN_SECRET=
MUX_WEBHOOK_SECRET=
NEXT_PUBLIC_MUX_ENV_KEY=

# Feed kill switch. '1' = root renders feed. '0'/unset = root → /waitlist.
# Flip in Vercel project env vars to revert without redeploy. (R3-M8)
NEXT_PUBLIC_FEED_ENABLED=1

# Reserved for v2 signed playback:
# MUX_SIGNING_KEY_ID=
# MUX_SIGNING_KEY_PRIVATE=
```

---

## 7. Observability

- **Sentry** — `sentry.server.config.ts` `beforeSend` redacts request body + `mux-signature` header for `/api/webhooks/mux`. Already applied for voice; extend the same redactor.
- **PostHog events:** `hook_view_start` (once-per-PostHog-session-per-hook — PostHog's 30-min idle session, **not** `sessionStorage` tab scope — so reopening the tab after a coffee break re-counts as a new view; chose this to match industry norms), `hook_view_complete` (≥75% watched), `hook_ask_clicked`, `welcome_dismissed`, `feed_scroll_depth_10`.
- **Mux Data** — `viewer_user_id = auth.uid()` when signed in, `anon_${deviceId}` otherwise (stable per localStorage). **Source of truth for watch quality metrics: Mux Data.** PostHog is source of truth for product funnel.
- **COGS** — one `cogs_log` row per `video.asset.ready` event, service `'mux'`, `qty = duration_ms / 1000`, unit `'seconds_encoded'`.

---

## 8. UX acceptance (phone + laptop)

- [ ] iPhone 11 Safari — scroll snap locks on panel, sound-off autoplay, tap unmutes, captions visible by default
- [ ] Pixel 7 Chrome — same + horizontal swipe between lessons within a video
- [ ] Desktop Chrome — arrow-up/down navigates panels, captions visible, trackpad scroll settles correctly
- [ ] `h-[100vh] h-[100svh]` fallback for iOS < 15.4
- [ ] `scroll-snap-stop: normal` (not `always`) for TikTok feel
- [ ] `prefers-reduced-motion` — welcome overlay fades without slide; autoplay paused, tap-to-play
- [ ] Welcome overlay shows once per hook-id, dismissible, never blocks
- [ ] Failed hook resettable via `resetFailedHook` admin action
- [ ] **Re-upload successful hook** — admin action `replaceHookTake` that (a) calls Mux `assets.delete(old_asset_id)` to stop storage billing, (b) sets `mux_status='pending'`, clears asset/playback IDs, regenerates `mux_passthrough` UUID, (c) allows fresh MuxUploader mount

---

## 9. Day split

**Day 6 (Apr 25)** — TDD order:
1. Migrations 01–03 + tests (RLS, trigger, RPC dispatch, aspect-ratio normalize, backfill sanity-check, seed filter on view)
2. Regenerate Supabase types — `npx supabase gen types typescript ...` so admin + feed code type-checks on new Mux columns
3. `src/lib/mux/*` + webhook route + signature test
4. Admin `/admin/content/videos/new` + upload e2e (real Mux sandbox, test-asset callback)
5. Founder records / uploads real content in parallel

**Day 7 (Apr 26)** — TDD order:
1. **Splash relocation first:** move current `/` to `/waitlist`; add `NEXT_PUBLIC_FEED_ENABLED` gate on new root page (redirect to `/waitlist` if unset)
2. `feed_page` RPC + `/api/feed` + rate-limit test
3. Feed UI: container → row → panel → overlay (incl. arrow-key nav per F5)
4. Welcome-hook selection in admin + `set_active_welcome_hook` RPC test
5. Real-device smoke (iPhone 11, Pixel 7, desktop Chrome with keyboard)
6. Pre-deploy red-team checklist (`docs/VIBECODERSHQ_HANDOFF.md` §17)

**Degrade path:** if admin UI slips, seed 3 hooks + 1 welcome via SQL (`is_seed_content=true` — the schema column is preserved as an insurance valve even though feed query ships with seed excluded per F3).

---

## 10. Non-goals (explicit)

- Ask button functionality — stubbed to PostHog event + toast. Real voice session opens Day 8 onward.
- Tier-gated playback. v1 is public.
- Captions generation. We write them by hand per hook during Days 2-5 recording.
- CSP hardening — documented as future work in `src/middleware/csp.ts` stub with Mux hosts pre-listed.
- MP4 downloads — `mp4_support: 'none'`.

---

## 11. Audit trail

- **Round 1** (pre-plan-v1 → plan-v2): C1 RLS column leak, C2 webhook-client mismatch, C3 idempotency race, C4 Sentry body leak, C5 upload-URL expiry. All fixed.
- **Round 2** (plan-v2 → plan-v3a): C1 column-GRANT semantics (→ view + `security_invoker`), C2 XFF spoof + unbounded log, C3 stale-asset replay. All fixed.
- **Round 3** (plan-v3a → plan-v3): C1 passthrough type contradiction (→ bare UUID), C2 REVOKE breaks RSC+realtime (→ admin RLS policy on base tables + view for public), C3 mint-URL POST needs in-handler guard, C4 XFF off-Vercel (→ prefer x-real-ip, document requirement). M1 aspect normalization in RPC. M2 publish-guard on INSERT + UPDATE. M3 active welcome swap via SECURITY DEFINER RPC. M4 SW bypass. M6 captions in panel. M7 pg_cron. M8 verify peer deps. S1–S9 folded into §8.
- **Round 4** (plan-v3 → plan-v4 this doc): M1 passthrough path differs for upload-family events (→ COALESCE asset + upload paths). M2 pg_cron on Supabase lives in `extensions` schema, requires dashboard enable (→ documented prereq). M3 column is `window_start`, not `created_at` (→ fixed). M4 feed rate limit = **120/min/IP** (product call: budget neutral, picks the generous end to eliminate shared-IP breakage and demo-day glitches; tighten later is a one-line arg change). M5 pre-existing hook rows disappeared under `mux_status` default (→ backfill `ready` for rows with existing `mux_playback_id`). M6 `hooks_public` view leaked seed to anon (→ filter `is_seed_content=false` at view level, not just RPC). M7 `videos` / `creators` anon policies already in place — documented and made explicit. M8 added `NEXT_PUBLIC_FEED_ENABLED` demo-day kill switch. S1 flipped Day 7 ordering (splash relocation first). S2 stale-asset guard handles NULL asset id on both sides. S3 `replaceHookTake` now deletes old Mux asset. S4 dropped duplicate `hls.js` dep. S5 `hook_view_start` scope = PostHog session, documented. S6 type regen step added to Day 6. S7 added `is_admin(uid)` helper at top of migration 01.

Stopping at 4 rounds — all remaining concerns are code-review-sized. The bar for another round is a new Critical, and none exist.

---

## 12. Approval gate

Decisions F1–F5 locked 2026-04-21 (see §1). Plan sent to final audit before build begins.

```
[1] Approve & auto-execute (Days 6-7, no per-step confirm)
[2] Approve & confirm each step (prompt between §2/§3/§5/§8)
[3] Keep planning (what's missing?)
[4] Changes: ___
```
