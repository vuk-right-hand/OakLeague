# Face Upload — Admin UI Wiring (Feature #2.5)

**Goal:** Wire the missing creator-onboarding step. Admin uploads a
creator's face video → system trains a face replica with Simli →
`creators.simli_face_id` is set atomically. UI cell mounts next to
`<VoiceCloneUpload>` on the creator detail page.

**Scope discipline (per CLAUDE.md "no premature abstraction"):**
- **Inline Simli, no provider-agnostic bridge.** Voice-clone inlines
  Cartesia URL/headers in the route. We mirror that exactly. Tavus is
  scrapped; Simli is the only candidate. A `FaceMintBridge` interface
  for one provider with no second candidate is speculation budget. If
  a real second vendor lands, we extract the bridge then — same as
  voice-clone could be refactored if Cartesia were ever swapped.
- **Single-environment writes.** v1 is production-only writes; preview
  + dev populate `simli_face_id` via SQL. No `_preview`/`_dev` columns
  unless preview-branch face training becomes a real workflow (it
  isn't — face training is once-per-creator-ever).
- **No source-video storage.** Vendor-only. Mirrors voice-clone.
- **No cogs_log row at train time** (R2-M6 finding) — Simli's face-
  training pricing model is unverified. Phase 0 settles whether it's
  per-minute, per-second, or fixed per-face. We add the cogs row
  AFTER Phase 0 confirms the pricing axis. Until then, the existing
  `mint-simli` $0 audit row at session-open is the upstream signal.

**Out of scope:** voice cloning (shipped), session lifecycle, the
`creators.simli_face_id` column itself (already exists),
`admin_force_retrain_creator` RPC (already shipped — clears the column;
this plan adds "what gets uploaded after"),
`simli_face_delete_queue` (already shipped + worker wired).

**Revision history:**
- v1: HOLD on first audit; 4 critical, 7 medium, 9 small.
- v2: HOLD on second audit; auditor recommended dropping the
  bridge ceremony entirely.
- v3: re-architected with auditor's recommendation. Smaller, honest,
  fits-the-codebase. Renamed FACE_UI_PLAN.md per Vuk.
- **v4 (current — built 2026-05-05):** Phase 0 verification done
  (`docs/_planning/PHASE_0_FACE_API.md`). Findings folded:
    * **Image-only** for Simli (Trinity-1 takes JPEG/PNG, not video).
      Dual-lane UI shipped: Photo tab live + Video tab greyed for
      Tavus/HeyGen swap.
    * **Async confirmed**: POST returns 200 + `{face_id, message,
      warnings[]}` with state pending; status route polls
      `generation_status` and finalizes on ready.
    * **5 MB hard cap** (4.5 MB pre-flight); error envelope `{detail}`.
    * Q3=A: production-only writes; all envs share prod Simli account.
    * Q4=B: dropped lock-unify migration; face uses its own
      `face_clone_overwrite:<id>` namespace.
    * Q5=A: $0 cogs row at training start with `pricing_unverified=true`,
      provider-agnostic.
    * Side-bug: `simli-face-delete-worker.js` URL fix to
      `/faces/trinity/`, plus 400 "Failed to Delete FaceId" handled as
      retry-later (face still pending generation).
    * Kebab-delete UX added to face tile.
    * Bypass env renamed `CREATOR_CLONE_RATE_LIMIT_BYPASS` (one cycle
      alias with `VOICE_CLONE_RATE_LIMIT_BYPASS`).

---

## 0. State of the world (verified)

### Already shipped (do not duplicate)
- `creators.simli_face_id text` (single column).
- `mintSimliSessionToken` (`src/lib/avatar/mint-simli.ts`) — only consumer
  of `simli_face_id`. Uses `https://api.simli.ai/compose/token` with
  `x-simli-api-key` header. Phase 0 below references this for header
  conventions.
- `simli_face_delete_queue` table + claim/complete/record_failure trio
  + `admin_force_retrain_creator` RPC (migration 20260507000003). The
  retrain RPC uses
  `pg_advisory_xact_lock(hashtext('creator_retrain:' || creator_id))`.
- `simli-face-delete-worker.js` — wired in `voice-proxy/index.js` startup.
- `/admin/creators/[id]/page.tsx` mounts `<VoiceCloneUpload>` — same
  page where `<FaceUpload>` lands.
- `/admin/creators/[id]/health/page.tsx` + `force-retrain-button.tsx`
  exist (verified).
- Voice-clone surface: `/api/admin/voice-clone/route.ts`,
  `voice-clone-upload.tsx`, `voice_clone_finalize_locked` RPC
  (advisory lock namespace `voice_clone_overwrite:<id>`),
  `voice_delete_queue`, 24h dual rate limits (3 successes + 20
  attempts), provider-error scrubbing pattern.

### What's missing
1. Phase 0 verification of Simli's face-train wire format.
2. Admin UI cell to upload a creator face video.
3. Server route validating + calling Simli + atomically writing
   `simli_face_id` + enqueueing prior face for delete.
4. `face_clone_uploads` audit table.
5. `face_clone_finalize_locked` RPC.

---

## 1. Phase 0: Simli face-train API verification (HARD GATE)

Implementation does NOT begin until `docs/_planning/PHASE_0_FACE_API.md`
is committed answering:

1. **Endpoint URL.** Candidates: `POST https://api.simli.ai/faces`,
   `POST https://api.simli.ai/face/generate`,
   `POST https://api.simli.ai/createFace`. Resolved by
   `curl -X POST <URL> -H "x-simli-api-key: $SIMLI_API_KEY"
   -F "file=@scripts/fixtures/face-test-vuk-5s.mp4"` against
   the production Simli account (Vuk has the key).
2. **Request shape.** Multipart vs JSON; field names; required headers
   beyond `x-simli-api-key`.
3. **Response shape.** Synchronous JSON `{faceId}` vs async
   `{jobId, status}` + polling vs webhook callback.
4. **Error shapes.** What does 422 look like for "no face detected"?
   What's the rate-limit shape?
5. **Pricing axis.** Per-second of input video? Per-minute? Fixed per
   trained face? Determines whether step 12 (cogs_log) even exists.
6. **Trinity-1 routing.** Is the face-vs-default tier distinction at
   train time, replica time, or session-open time? (`mint-simli.ts`
   already routes Trinity-1 server-side — confirm same key.)

**Phase 0 outputs:**
- Verified curl command + redacted response in
  `docs/_planning/PHASE_0_FACE_API.md`.
- A working `scripts/face-phase0-verify.mjs` that re-runs the curl
  against `process.env.SIMLI_API_KEY` and asserts the response shape.
- The fixture committed at `scripts/fixtures/face-test-vuk-5s.mp4`
  with `.gitattributes` LFS entry.

**If Simli is async + webhook**, §5 step 10 expands:
- Bridge (inlined in route — see §2) returns `{ pending: true, jobId }`
  on 202.
- New endpoint `POST /api/admin/face-upload/webhook` receives the
  vendor callback, looks up the upload row by `jobId`, writes the
  `face_id`, calls finalize RPC. Webhook auth: HMAC over the request
  body using a shared secret, mirroring how Mux webhooks are wired.
- UI shows "Training face… (still in progress; refresh in a minute)"
  for >30s waits. Polls `/api/admin/face-upload/status?uploadId=...`
  every 5s until `face_id` is set or `attempts > 5`.

If Simli is synchronous, the polling/webhook scaffolding is skipped.
Plan §5 adapts; see "synchronous-path notes" inline.

---

## 2. Architecture: inline Simli, no bridge interface

**Reverses v2's `FaceMintBridge` ceremony.** Simli is the only candidate.
Voice-clone inlines Cartesia URL/headers; we mirror that. Files:

- `src/app/api/admin/face-upload/route.ts` — references Simli URL +
  `x-simli-api-key` header inline. Same convention as voice-clone with
  Cartesia.
- No `face-mint-bridge.ts`. No factory.
- Future Tavus-style swap: refactor to a bridge then. Same path
  voice-clone would take if Cartesia were swapped. Symmetric debt.

The runtime path (`AvatarBridge` for session-open / sendAudio) **stays
provider-agnostic** — that's where provider swaps actually happen
(verified by current Simli/Tavus split in `simli-bridge.ts`/
`tavus-bridge.ts`). Face-upload is creator-onboarding, not runtime.

---

## 3. Production-only in v1 (R2-C3 resolution)

Auditor C3: production-only blocks preview-branch session-open because
`/api/sessions/open:114` rejects `creator_not_ready` when
`simli_face_id IS NULL`.

**Resolution: explicitly accept "all envs share one Simli account."**
- Production face_id is what every env uses. Preview/dev sessions hit
  the prod Simli `face_id` and burn prod minutes.
- COGS attribution: `cogs_log.environment` already distinguishes
  spike_a / spike_b / dev / production at the session-open layer.
  Preview burns are tagged `production` because they go to the prod
  Simli endpoint with the prod key.
- This is acceptable for v1 because preview/dev session traffic is
  near-zero (admin-only). Documented as a tradeoff, not hidden.
- **Post-Phase-0 follow-up (NOT v1):** if preview/dev sessions become
  cost-significant, add `simli_face_id_preview` / `_dev` columns and
  an env-aware finalize RPC. Schema additive; no v1 churn.

The production-only WRITE gate at §5 step 3 is preserved (admin can't
trigger face training from preview), but READS hit the same column
across all envs.

---

## 4. Video validation (video-only in v1)

| Field | Limit |
|---|---|
| MIME | `video/mp4` (H.264) OR `video/quicktime` |
| Size | ≤ 50 MB |
| Duration | 5–120 s |
| Resolution | 256×256 min, 4096×4096 max |
| Aspect | 9:16, 16:9, or 1:1 |
| Extension matches MIME | strict |

Server-side magic-byte sniff in new `src/lib/avatar/mp4-probe.ts`:
- `ftyp` box presence → mime confirmation.
- `mvhd` box → duration.
- `tkhd` box → width/height.
- ~120 LOC, zero deps. Mirrors `wav-probe.ts` shape.

Image upload deferred to v2 (auditor R1-C4 — single-frame avatar is
a degraded-quality path; not worth complicating v1).

---

## 5. Server route: `/api/admin/face-upload`

Direct inline mirror of `/api/admin/voice-clone/route.ts` step-by-step.

1. **Admin gate** — `assertAdminFromSession()`.
2. **Same-origin** — same helper.
3. **Production-only env gate** — return 503
   `face_upload_only_in_production` when `VERCEL_ENV !== 'production'`.
   Mirror voice-clone R4-M6 fix.
4. **Simli API key present?** — return 500 `simli_misconfig` when unset.
5. **Content-Length pre-check** — reject `> MAX_BYTES + 64KB`.
6. **Multipart parse** — `creatorId`, `name` (≤80), `file`.
7. **Probe video** (§4) — magic bytes + duration + dims; reject early
   with `bad_mime` / `face_too_short` / `face_too_long` /
   `bad_video_dims` / `bad_aspect`.
8. **SHA256 + audit row INSERT** — `face_clone_uploads` row with
   `vendor='simli'`, `face_id=NULL`, `width`, `height`,
   `duration_seconds`, `bytes`, `mime`.
9. **Rate-limit check** — 3 successes / 20 attempts per 24h. **Two env
   names read in union** (R2-M1 alias-cycle resolution):
   `CREATOR_CLONE_RATE_LIMIT_BYPASS` (new) ∪
   `VOICE_CLONE_RATE_LIMIT_BYPASS` (old). Voice-clone route is updated
   in the same PR to read both as well; one-cycle alias before the old
   name is removed.
10. **Pre-flight existence + active-session count + `?force=1` gate**
    — same shape as voice-clone (`already_face_trained` /
    `creator_has_active_session`).
11. **Vendor train (inline)** — `fetch(SIMLI_FACE_TRAIN_URL, ...)` with
    `x-simli-api-key`. 30s `AbortController`. Provider error body
    NEVER logged (Simli echoes `name` field on 4xx — voice-clone S-C4
    pattern). 4xx → `face_train_failed`; 5xx → `face_train_unreachable`;
    202 → `face_train_async_pending` IF Phase 0 found async path
    (see §1 webhook hook).
12. **Finalize RPC** — `face_clone_finalize_locked(p_admin_user_id,
    p_upload_id, p_creator_id, p_face_id, p_force)`. RPC takes the
    **shared `creator_mutate:<id>` advisory-lock namespace** —
    explicit C1 fix:

    > Voice-clone's existing `voice_clone_overwrite:<id>` namespace
    > is migrated to `creator_mutate:<id>` in the same PR.
    > `admin_force_retrain_creator`'s `creator_retrain:<id>` namespace
    > is also migrated to `creator_mutate:<id>`.
    > Result: voice-clone, face-upload, and force-retrain all serialize
    > against each other. Admin can't fire concurrent face-upload +
    > voice-clone + retrain on the same creator.

13. **Orphan-cleanup on finalize failure** (R2-M3) — if RPC raises but
    Simli train succeeded (face_id known), enqueue the orphan into
    `simli_face_delete_queue` with `due_at = now()`. Mirrors voice-
    clone's voice_delete_queue orphan write. Best-effort.
14. **Defer-delete prior face** (overwrite path) — INSERT
    `simli_face_delete_queue` with `due_at = now() + 60s`. Worker
    drains.
15. **Return** `{ ok, faceId, durationSeconds, overwrote }`.

### Race-window acceptance (R1-M5 carried)

`/api/sessions/open` does NOT take the `creator_mutate:<id>` lock.
Race window: admin starts upload → Simli train (8–15s) → user opens
session against current `simli_face_id` → finalize RPC's active-
session check raises 409 → admin sees error → orphan cleanup fires.
Acceptable; session-open is on the user critical path.

---

## 6. UI cell — `<FaceUpload>`

`src/app/admin/creators/[id]/face-upload.tsx`. Mirror
`voice-clone-upload.tsx` line-for-line with these diffs:

- File input `accept="video/mp4,video/quicktime,.mp4,.mov"`.
- Two-stage label: "Uploading…" → "Training face (this can take 15s)…"
  at 1.5s. Mirrors voice-clone's "Training voice (10s)" pattern.
- Pre-submit preview: `<video controls muted playsInline>` (R1-S iOS
  fix — `playsInline` prevents fullscreen takeover).
- Async-pending UX (only present if Phase 0 returned async): if route
  returns `face_train_async_pending`, show "Training in progress; we'll
  poll" + start a 5s poll loop against
  `/api/admin/face-upload/status?uploadId=...`.
- Error map: `bad_mime`, `face_too_short`, `face_too_long`,
  `bad_video_dims`, `bad_aspect`, `face_no_subject`,
  `face_train_failed`, `face_train_unreachable`,
  `face_train_async_pending`, `creator_has_active_session`,
  `already_face_trained`, `rate_limit`, `rate_limit_attempts`,
  `face_upload_only_in_production`, `simli_misconfig`.
- Overwrite checkbox copy parallels voice-clone.

Mount: `src/app/admin/creators/[id]/page.tsx` directly below the
existing `<VoiceCloneUpload>` cell.

---

## 7. Force-retrain integration

`force-retrain-button.tsx` (already exists) clears `simli_face_id`
without prompting for the next upload. After retrain succeeds, scroll
to the `<FaceUpload>` cell with a flash message "Face cleared — upload
a new clip to re-train." +5 LOC. Tracked-as-shipped because it
materially affects retrain UX.

---

## 8. Schema migrations

### Migration 1: `20260508000001_creator_mutate_lock_unify.sql`
Migrate the two existing advisory-lock namespaces to a unified
`creator_mutate:<id>` so face / voice / retrain all serialize.

```sql
-- Replaces the body of voice_clone_finalize_locked AND
-- admin_force_retrain_creator. Both functions become CREATE OR REPLACE
-- with new lock namespace. All other behavior unchanged.

CREATE OR REPLACE FUNCTION public.voice_clone_finalize_locked(...)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- WAS: hashtext('voice_clone_overwrite:' || p_creator_id::text)
  -- NOW: unified namespace.
  PERFORM pg_advisory_xact_lock(hashtext('creator_mutate:' || p_creator_id::text));
  -- ... rest of body unchanged ...
END;$$;

CREATE OR REPLACE FUNCTION public.admin_force_retrain_creator(...)
RETURNS TABLE (prior_face_id text, cleared boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- WAS: hashtext('creator_retrain:' || p_creator_id::text)
  -- NOW: unified namespace.
  PERFORM pg_advisory_xact_lock(hashtext('creator_mutate:' || p_creator_id::text));
  -- ... rest of body unchanged ...
END;$$;
```

### Migration 2: `20260508000002_face_clone_uploads.sql`
```sql
CREATE TYPE face_vendor AS ENUM ('simli');

CREATE TABLE public.face_clone_uploads (
  id            bigserial PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  creator_id    uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  vendor        face_vendor NOT NULL,
  sha256        text NOT NULL CHECK (char_length(sha256) = 64),
  duration_seconds numeric NOT NULL CHECK (duration_seconds BETWEEN 5 AND 120),
  mime          text NOT NULL,
  bytes         bigint NOT NULL CHECK (bytes > 0 AND bytes <= 50 * 1024 * 1024),
  width         int NOT NULL CHECK (width  BETWEEN 256 AND 4096),
  height        int NOT NULL CHECK (height BETWEEN 256 AND 4096),
  face_id       text,
  -- Async-train support (only used if Phase 0 finds async path).
  vendor_job_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.face_clone_uploads ENABLE ROW LEVEL SECURITY;
-- service-role only.

CREATE TRIGGER face_clone_uploads_touch_updated_at
  BEFORE UPDATE ON public.face_clone_uploads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX face_clone_uploads_admin_created_idx
  ON public.face_clone_uploads (admin_user_id, created_at DESC);

CREATE INDEX face_clone_uploads_creator_idx
  ON public.face_clone_uploads (creator_id, created_at DESC);

-- Async-pending lookup index (job_id → upload row).
CREATE INDEX face_clone_uploads_vendor_job_idx
  ON public.face_clone_uploads (vendor_job_id)
  WHERE vendor_job_id IS NOT NULL AND face_id IS NULL;
```

### Migration 3: `20260508000003_face_clone_finalize_locked.sql`
Mirrors `voice_clone_finalize_locked` with R2-C2 finding folded:
validates `(p_upload_id, p_creator_id, p_admin_user_id)` match before
write; rejects already-finalized rows.

```sql
CREATE OR REPLACE FUNCTION public.face_clone_finalize_locked(
  p_admin_user_id uuid,
  p_upload_id     bigint,
  p_creator_id    uuid,
  p_face_id       text,
  p_force         boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_active_count int;
  v_upload       record;
BEGIN
  -- Re-assert admin role (defense-in-depth).
  IF NOT EXISTS (SELECT 1 FROM admin_roles WHERE user_id = p_admin_user_id) THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;

  -- C1: shared lock namespace.
  PERFORM pg_advisory_xact_lock(hashtext('creator_mutate:' || p_creator_id::text));

  -- C2 fix: validate upload row identity + not-already-finalized.
  SELECT * INTO v_upload FROM face_clone_uploads
   WHERE id = p_upload_id FOR UPDATE;
  IF v_upload IS NULL THEN
    RAISE EXCEPTION 'upload_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_upload.admin_user_id <> p_admin_user_id THEN
    RAISE EXCEPTION 'upload_admin_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_upload.creator_id <> p_creator_id THEN
    RAISE EXCEPTION 'upload_creator_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_upload.face_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload_already_finalized' USING ERRCODE = '23505';
  END IF;

  -- Active-session check; bypass requires p_force.
  SELECT count(*) INTO v_active_count
    FROM sessions WHERE creator_id = p_creator_id AND ended_at IS NULL;
  IF v_active_count > 0 AND NOT p_force THEN
    RAISE EXCEPTION 'creator_has_active_session: % open', v_active_count
      USING ERRCODE = 'P0001';
  END IF;

  -- v1: only Simli writes simli_face_id.
  UPDATE creators SET simli_face_id = p_face_id, updated_at = now()
   WHERE id = p_creator_id;

  UPDATE face_clone_uploads
     SET face_id = p_face_id, updated_at = now()
   WHERE id = p_upload_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_finalize_locked(uuid, bigint, uuid, text, boolean) FROM public;
```

---

## 9. Failure modes + UX copy

| Code | Status | Title | Body |
|---|---|---|---|
| `face_upload_only_in_production` | 503 | "Production-only" | "Face upload is production-only. Populate `simli_face_id` via SQL on staging." |
| `simli_misconfig` | 500 | "Server misconfigured" | "SIMLI_API_KEY unset on this deployment." |
| `bad_mime` | 415 | "Unsupported format" | "Use MP4 (H.264) or MOV." |
| `bad_aspect` | 400 | "Aspect ratio out of range" | "Need 9:16, 16:9, or 1:1." |
| `bad_video_dims` | 400 | "Resolution out of range" | "Need 256×256 minimum, 4K maximum." |
| `face_too_short` | 400 | "Video too short" | "Need at least 5 seconds." |
| `face_too_long` | 400 | "Video too long" | "Trim to ≤ 120 seconds." |
| `face_too_large` | 413 | "File too large" | "Max 50 MB. Re-encode lower bitrate." |
| `face_no_subject` | 422 | "Face not detected" | "Use a clip where the creator's face is clearly visible and centered." |
| `face_train_failed` | 502 | "Vendor rejected the file" | "Try a different clip. Persists? File a bug." |
| `face_train_unreachable` | 502 | "Vendor unreachable" | "Vendor side is down. Retry in a minute." |
| `face_train_async_pending` | 504 | "Training still in progress" | "Refresh in a minute." |
| `creator_has_active_session` | 409 | "Live sessions in progress" | "End active sessions before replacing the face." |
| `already_face_trained` | 409 | "Face already exists" | "Check 'Overwrite' and resubmit." |
| `upload_already_finalized` | 409 | "Upload already used" | "Submit a fresh clip." |
| `rate_limit` | 429 | "Daily limit reached" | "Max 3 successful face trainings per 24h." |
| `rate_limit_attempts` | 429 | "Too many failed attempts" | "Wait 24h or check Simli status." |

---

## 10. Files touched

| File | Change |
|---|---|
| `docs/_planning/PHASE_0_FACE_API.md` | NEW — Phase 0 verification artifact (HARD GATE) |
| `scripts/fixtures/face-test-vuk-5s.mp4` | NEW — Phase 0 + tests fixture (LFS) |
| `scripts/face-phase0-verify.mjs` | NEW — re-runnable Phase 0 verifier |
| `supabase/migrations/20260508000001_creator_mutate_lock_unify.sql` | NEW — migrate voice-clone + retrain RPCs to `creator_mutate:<id>` lock |
| `supabase/migrations/20260508000002_face_clone_uploads.sql` | NEW — `face_vendor` enum + audit table |
| `supabase/migrations/20260508000003_face_clone_finalize_locked.sql` | NEW — finalize RPC w/ unified lock + upload-row identity validation |
| `src/lib/avatar/mp4-probe.ts` | NEW — magic-byte + duration + dims |
| `src/app/api/admin/face-upload/route.ts` | NEW — inlines Simli URL/headers; mirrors voice-clone shape |
| `src/app/api/admin/face-upload/webhook/route.ts` | NEW (only if Phase 0 finds async path) |
| `src/app/api/admin/face-upload/status/route.ts` | NEW (only if Phase 0 finds async path) |
| `src/app/admin/creators/[id]/face-upload.tsx` | NEW — UI cell; mirrors `voice-clone-upload.tsx` |
| `src/app/admin/creators/[id]/page.tsx` | mount `<FaceUpload>` next to `<VoiceCloneUpload>` |
| `src/app/admin/creators/[id]/health/force-retrain-button.tsx` | post-retrain success → scroll to face-upload cell + flash message |
| `src/app/api/admin/voice-clone/route.ts` | read `CREATOR_CLONE_RATE_LIMIT_BYPASS` ∪ `VOICE_CLONE_RATE_LIMIT_BYPASS` |
| `CLAUDE.md` | document `CREATOR_CLONE_RATE_LIMIT_BYPASS` rename + alias cycle |
| `.env.example` | add `CREATOR_CLONE_RATE_LIMIT_BYPASS` (alias to old) |

**No changes** to: voice-proxy, simli-bridge, mint-simli, AvatarBridge,
session lifecycle, /api/sessions/*. Face-upload is creator-onboarding
only. The lock-unify migration touches `voice_clone_finalize_locked`
+ `admin_force_retrain_creator` bodies via CREATE OR REPLACE — no
schema change beyond function bodies.

---

## 11. Tests

- Unit: `mp4-probe.ts` against fixture (valid 5s MP4) and corrupted/
  truncated copies.
- Unit: `face_clone_finalize_locked` (pgTAP or harness) — cover
  upload-row identity validation, lock acquisition, active-session
  guard, idempotent re-call (already_finalized).
- Unit: lock-unify migration — assert `voice_clone_finalize_locked` and
  `admin_force_retrain_creator` both serialize on the same key.
- Integration (real-API gated, `RUN_REAL_FACE_API_TESTS=1`): upload
  fixture → assert face_id (sync path) OR vendor_job_id then poll
  (async path) → assert visible in `/admin/creators/[id]`.
- Manual: end-to-end Vuk upload → SQL verify `simli_face_id` → `/s/[id]`
  session → avatar lipsyncs.

---

## 12. Sequencing

This is a one-PR feature gated on Phase 0.

1. **Phase 0** — produce verification artifact (§1).
2. **Migrations** — lock-unify FIRST, then face_clone_uploads,
   then finalize RPC. Apply on staging; verify lock-unify doesn't
   break the existing `voice_clone_finalize_locked` callers.
3. **mp4-probe** + fixture commit.
4. **Route** + UI cell.
5. **Wire force-retrain post-success scroll**.
6. **Tests**.
7. **Auditor pass before commit**.
8. **Manual Vuk upload + session test**.

Estimate: **1.5 days** if Phase 0 returns synchronous, **2.5 days** if
async-webhook (adds receiver + status endpoint + polling UX).

---

## 13. Audit revisions log

### Round 1 (audit #1) — folded in v2
R1-C1, R1-C2, R1-C3, R1-C4, R1-M1 through R1-M7, R1-S smalls. Kept v3.

### Round 2 (audit #2 — fit-with-codebase) — folded in v3 (this file)
- **R2-C1 (lock namespace was actually wrong):** unified to
  `creator_mutate:<id>` via lock-unify migration. Voice-clone +
  force-retrain + face-upload all serialize.
- **R2-C2 (RPC weaker than template):** finalize RPC now validates
  upload row identity (admin/creator/not-already-finalized) under
  `FOR UPDATE`. Mirrors voice-clone exactly.
- **R2-C3 (production-only blocks preview session-open):** explicit
  acceptance — all envs share one Simli account; preview burns hit
  prod. Documented as a tradeoff. Schema-additive follow-up path
  documented for when preview traffic becomes cost-significant.
- **R2-C4 (Phase 0 not done):** promoted to HARD GATE blocking all
  implementation. Verification artifact + re-runnable script
  required.
- **R2-M1 (env rename incomplete):** voice-clone route added to
  files-touched; both routes read union of old + new env names.
- **R2-M2 (filename inconsistency):** dropped via architectural
  pivot — no `face-mint-bridge.ts` etc. Inlined in route mirrors
  `mint-simli.ts` convention since it's the same provider.
- **R2-M3 (orphan-cleanup pattern missing):** explicit step 13 in §5.
- **R2-M4 (provider-agnostic was theater):** dropped the bridge
  ceremony. Inlined Simli. Schema layer unchanged (still single
  vendor today).
- **R2-M5 (production-only runbook):** preview/dev populate
  `simli_face_id` via SQL — acknowledged in §3 + §9 error copy.
- **R2-M6 (cogs_log fabricated):** removed from v3. Phase 0 settles
  pricing axis FIRST, then we add the cogs row in a follow-up PR.
- **R2-S smalls:** LFS entry for fixture; consistent error-code
  prefixes; explicit duration in UI training label; verified
  `force-retrain-button.tsx` exists; Simli docs note added in §1.
- **Architecture-fit pivot:** dropped premature `FaceMintBridge`
  abstraction per CLAUDE.md "no premature abstraction" rule.
  Symmetric debt with voice-clone.
- **YC-clock framing:** removed entirely. Application submitted
  2026-05-06; this plan ships when it's right.
