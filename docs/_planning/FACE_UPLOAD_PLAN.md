# Face Upload — Provider-Agnostic Admin Wiring (Feature #2.5)

> **⚠️ SUPERSEDED — kept for historical reference.**
>
> This is the v1/v2 design (provider-agnostic bridge ceremony, video
> upload, etc.). Phase 0 verification of Simli's Trinity-1 API
> revealed Trinity is image-only (not video), and the auditor pushed
> us to drop the bridge ceremony entirely (CLAUDE.md "no premature
> abstraction"). The shipped design lives in **`FACE_UI_PLAN.md` v4**
> and the Phase 0 findings are in **`PHASE_0_FACE_API.md`**.
>
> Read this file only when researching: (a) why the bridge was
> rejected, (b) the original video-upload constraints in case we
> revive them when wiring Tavus/HeyGen, (c) the v1/v2 audit cycle
> for context.

**Goal:** Wire the missing creator-onboarding step that the Simli wire-up
plan assumed was already done — admin uploads a creator's face video,
the system trains a face replica with the avatar provider (Simli today),
and `creators.simli_face_id` is set atomically. Mirror the voice-clone
pattern (`/api/admin/voice-clone` + `voice_clone_uploads` +
`voice_clone_finalize_locked`) but behind a **provider-agnostic** boundary
so a future avatar-provider swap stays a one-bridge change.

**Out of scope:** voice cloning (shipped), session lifecycle, the
`creators.simli_face_id` column itself (already exists), GDPR delete
(shipped via `simli_face_delete_queue`), `admin_force_retrain_creator`
(shipped — clears the column; this plan adds the "what gets uploaded
after").

**Revision history:** v1 audit returned HOLD with C1–C4 + M1–M7 + 9
smalls. v2 (this file) folds all of them.

---

## 0. State of the world (verified)

### Already shipped (do not duplicate)
- `creators.simli_face_id text` (single column; **no `_preview`/`_dev`
  variants** — v1 is production-only; see §1).
- `mintSimliSessionToken` (`src/lib/avatar/mint-simli.ts`) — only consumer
  of `simli_face_id`; consumed via `AvatarBridge.open({ replicaId })`.
- `simli_face_delete_queue` + claim/complete/record_failure trio
  (migration 20260507000003) — ready for the overwrite-defer path.
- `simli-face-delete-worker.js` — wired in `voice-proxy/index.js`.
- `admin_force_retrain_creator` RPC — uses
  `pg_advisory_xact_lock(hashtext('creator_retrain:' || creator_id))`
  + raises `creator_has_active_session` (P0001).
- `/admin/creators/[id]/page.tsx` mounts `<VoiceCloneUpload>`. The new
  cell mounts in the same place.
- `/admin/creators/[id]/health/page.tsx` already exists; "Re-train"
  button currently CLEARS the face_id only.
- Voice-clone: server-side magic-byte sniff, SHA256 audit row pre-insert
  with `vendor_id NULL`, atomic finalize RPC (advisory lock +
  active-session check), 60s deferred delete queue, 24h dual rate limits
  (3 successes + 20 attempts), friendly error map, provider-error body
  scrubbing, production-only env gate (C2 fix from Simli wireup).

### What's missing
1. Admin UI to upload a creator face video.
2. Server route that validates → calls vendor → atomically writes
   `simli_face_id` → enqueues prior face for delete.
3. Provider-agnostic `FaceMintBridge` interface + Simli implementation.
4. `face_clone_uploads` audit table.
5. `face_clone_finalize_locked` RPC.
6. **Phase 0 Simli wire-format verification** (R1-C3 — see §12).

---

## 1. Production-only in v1 (R1-C1 resolution)

Voice-clone has three columns (`voice_id`, `voice_id_preview`,
`voice_id_dev`) keyed by `VERCEL_ENV` because clones happen frequently
on preview branches. Face training is rare (one per creator, ever) and
the asset is non-fungible (a face video is not branchable testing
material). v1 ships **production-only**:

- Schema keeps `creators.simli_face_id` as a single column (already
  shipped).
- Route returns `503 face_upload_only_in_production` when
  `VERCEL_ENV !== 'production'`. Same-shape gate as voice-clone's R4-M6
  fix (`src/app/api/admin/voice-clone/route.ts:96-104`).
- Preview/dev environments populate `simli_face_id` manually via SQL.

**Post-YC follow-up:** if preview-branch face training becomes a
needed flow, add `simli_face_id_preview` / `simli_face_id_dev` columns
+ env-aware finalize RPC. Not now.

---

## 2. Provider-agnostic boundary (R1-M3 resolution)

CLAUDE.md: "no provider SDK types leak past the bridge." Voice-clone
violated this (Cartesia URL/headers inlined in route). We will not
repeat.

```
src/lib/avatar/face-mint-bridge.ts   ← interface ONLY (no Simli mention)
src/lib/avatar/face-mint-simli.ts    ← Simli implementation
src/lib/avatar/face-mint.ts          ← factory: env → impl
```

Bridge interface:
```ts
// face-mint-bridge.ts
export interface FaceMintBridge {
  trainFace(input: TrainFaceInput): Promise<TrainFaceResult>;
}

export type TrainFaceInput = {
  videoBuf: Buffer;
  mime: 'video/mp4' | 'video/quicktime';   // R1-C4: video-only in v1
  filename: string;
};

export type TrainFaceResult = {
  faceId: string;
  trainedAt: string | null;       // ISO; advisory; vendor-supplied
  vendor: FaceVendor;             // ENUM type from migration; for cogs_log
};

export const FACE_MINT_ERROR_CODES = [
  'face_api_key_missing',
  'bad_mime',
  'face_too_short',
  'face_too_long',
  'face_too_large',
  'face_no_subject',           // 422 — face not detected
  'face_quota_exceeded',
  'face_train_failed',
  'face_train_unreachable',
  'face_train_no_id',
  'face_train_async_pending',  // R1-C3 hedge: if Simli is async, surface explicitly
] as const;
export type FaceMintErrorCode = (typeof FACE_MINT_ERROR_CODES)[number];

export class FaceMintError extends Error { /* code + httpStatus + cause */ }
```

The route imports **only** `FaceMintBridge` + the factory. Future Tavus
swap = add `face-mint-tavus.ts`, change one factory line. The route
file never names a vendor.

`TrainFaceInput.tier` from v1: **dropped** (R1-S5 — unused by Simli's
face-train API; if v2 needs it, add then).

### URL conventions
- Route: `/api/admin/face-upload` (NOT `/simli-face-upload`).
- Audit table: `face_clone_uploads` (vendor is a column).
- UI cell: `<FaceUpload>`.
- `vendor` column uses Postgres ENUM `face_vendor` (R1-M4 fix — easier
  to extend via `ALTER TYPE ADD VALUE` than `DROP CONSTRAINT`).

---

## 3. Source storage: vendor-only (R1-M2 resolution)

**Drop option (a) from v1.** Voice-clone does not store the source
audio; we mirror that. Reasons:
- Avoids GDPR-erasure scope creep (no Storage bucket → no extra
  erasure-worker rows to write now).
- 50 creators × 50MB video = 2.5GB; non-trivial cost surface for a
  rare-use workflow.
- Re-train flow (force-retrain + new upload) is two admin clicks; an
  admin pasting the file path again is the cost.

**Post-YC follow-up:** if force-retrain automation becomes painful
enough, add the bucket + extend `creator_erasure_queue` worker. Tracked
as a TODO comment on `admin_force_retrain_creator`.

---

## 4. Video validation contract (R1-C4 resolution: video-only in v1)

| Field | Limit | Rationale |
|---|---|---|
| MIME | `video/mp4` (H.264) OR `video/quicktime` | Covers iPhone-recorded MOV + standard MP4 |
| Size | ≤ 50 MB | Trinity-1 wants ~30s; 50MB at H.264 medium-quality is generous |
| Duration | 5–120 s | Trinity-1 quality plateaus ~30s; cap matches §7 schema CHECK |
| Resolution | min 256×256, max 4096×4096 | Below 256: lipsync mush; above 4K: vendor uploads time out |
| Aspect | 9:16 OR 16:9 OR 1:1 | Out-of-band aspect = ugly Simli crop |
| File extension matches MIME | strict | `.mp4.exe` defense |

Server-side magic-byte sniff:
- New `src/lib/avatar/mp4-probe.ts` — `ftyp` box presence + duration
  via `mvhd` box parse + `tkhd` for dimensions. ~120 LOC, zero deps.
  Mirror the `wav-probe.ts` shape.
- Reject `image/*` and `video/webm` etc. explicitly (no surprise
  formats). Image-only path **dropped from v1** (R1-C4); admin uploads
  a 5s video clip instead. Single-frame avatar can be a v2 path.

Error code `bad_aspect` added (R1-S smalls fix).

---

## 5. Server route: `/api/admin/face-upload`

Direct mirror of `/api/admin/voice-clone`. Step-by-step:

1. **Admin gate** — `assertAdminFromSession()`.
2. **Same-origin** — same helper.
3. **Production-only env gate** (§1) — return 503
   `face_upload_only_in_production` when `VERCEL_ENV !== 'production'`.
4. **Content-Length pre-check** — reject `> MAX_BYTES + 64KB` pre-formData.
5. **Multipart parse** — `creatorId`, `name` (face label, ≤80), `file`.
6. **Probe video** (§4) — magic bytes + duration + dims; reject early.
7. **SHA256 + audit row INSERT** — `face_clone_uploads` row with
   `vendor='simli'`, `face_id=NULL`, `width`, `height`,
   `duration_seconds`, `bytes`, `mime`.
8. **Rate-limit check** — 3 successes / 20 attempts per 24h on
   `face_clone_uploads`. Reuse the renamed bypass env (R1-M1):
   `CREATOR_CLONE_RATE_LIMIT_BYPASS` (with one-cycle alias for
   `VOICE_CLONE_RATE_LIMIT_BYPASS`; both routes read both env names
   and union them).
9. **Pre-flight existence + active-session count + `?force=1` gate**
   — same shape as voice-clone.
10. **Vendor train** — `bridge.trainFace({ videoBuf, mime, filename })`.
    30s `AbortController` timeout. 4xx → `face_train_failed`; 5xx →
    `face_train_unreachable`. **Body never echoed in logs** (Simli is
    known to echo `name` field on 4xx; voice-clone S-C4 pattern).
    Async-result hedge (R1-C3): if Simli returns 202 `{job_id}`, bridge
    polls for ≤25s; surfaces `face_train_async_pending` if not ready.
    Phase 0 verification (§12) settles which path is real.
11. **Finalize RPC** — `face_clone_finalize_locked(p_admin_user_id,
    p_upload_id, p_creator_id, p_face_id, p_vendor, p_force)`. RPC
    takes the **same advisory-lock namespace** as
    `admin_force_retrain_creator`:
    `pg_advisory_xact_lock(hashtext('creator_retrain:' || p_creator_id))`
    (R1-C2 resolution — face-upload + force-retrain serialize
    against each other).
12. **COGS audit row** (R1-M7) — INSERT into `cogs_log`:
    `service='simli'`, `operation='face_train'`,
    `units = duration_seconds`, `cost_usd =
    SIMLI_FACE_TRAIN_USD_PER_SEC * units`, `metadata.quoted_at =
    SIMLI_QUOTED_AT`. Both env vars validated at proxy-handlers
    boot in the same `getCartesiaPricing()`-style helper to add. Fail
    closed at boot if missing.
13. **Defer-delete prior face** — INSERT `simli_face_delete_queue` with
    `due_at = now() + 60s`. Worker (already wired) drains.
14. **Return** `{ ok, faceId, durationSeconds, vendor: 'simli',
    overwrote }`.

### Race-condition acceptance (R1-M5)

`/api/sessions/open` does **not** take the
`creator_retrain:<id>` advisory lock. Race window: admin starts upload
→ vendor train (8–15s) → user opens session against current
`simli_face_id` → finalize RPC's active-session check raises 409 →
return 502 to admin → vendor face_id is orphaned at Simli (cleanup via
existing `simli_face_delete_queue` enqueue-on-finalize-failure pattern,
mirror voice-clone S-C2).

Accepted because session-open is on the user critical path; adding a
30s lock acquisition there breaks tap-latency. Document: "if rapid
upload + session race becomes common, add session-open lock acquisition
with 50ms timeout."

---

## 6. UI cell — `<FaceUpload>`

Mirror `<VoiceCloneUpload>` line-for-line with:
- File input `accept="video/mp4,video/quicktime,.mp4,.mov"`.
- "Training face…" two-stage label (Simli train ~8–15s vs Cartesia
  5–10s).
- Pre-submit preview: `<video controls muted playsInline>` (R1-S
  iOS fix — `playsInline` prevents fullscreen takeover).
- Error map adds: `face_too_short`, `face_too_long`, `face_no_subject`,
  `face_train_unreachable`, `bad_aspect`, `face_train_async_pending`.
- Overwrite checkbox copy parallels voice-clone.
- Mounts in `src/app/admin/creators/[id]/page.tsx` directly below
  `<VoiceCloneUpload>`.

---

## 7. Schema

### Migration `20260508000001_face_vendor_enum_and_uploads.sql`
```sql
CREATE TYPE face_vendor AS ENUM ('simli');

CREATE TABLE public.face_clone_uploads (
  id            bigserial PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  creator_id    uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  vendor        face_vendor NOT NULL,
  sha256        text NOT NULL CHECK (char_length(sha256) = 64),
  duration_seconds numeric NOT NULL CHECK (duration_seconds BETWEEN 5 AND 120),
  -- ↑ R1-M6 fix: route limit (5–120s) is the source of truth; CHECK matches.
  mime          text NOT NULL,
  bytes         bigint NOT NULL CHECK (bytes > 0 AND bytes <= 50 * 1024 * 1024),
  width         int NOT NULL CHECK (width  BETWEEN 256 AND 4096),
  height        int NOT NULL CHECK (height BETWEEN 256 AND 4096),
  face_id       text,                  -- vendor's face id; NULL until finalize
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.face_clone_uploads ENABLE ROW LEVEL SECURITY;
-- service-role only.

CREATE INDEX face_clone_uploads_admin_created_idx
  ON public.face_clone_uploads (admin_user_id, created_at DESC);

CREATE INDEX face_clone_uploads_creator_idx
  ON public.face_clone_uploads (creator_id, created_at DESC);
```

### Migration `20260508000002_face_clone_finalize_locked.sql`
```sql
CREATE OR REPLACE FUNCTION public.face_clone_finalize_locked(
  p_admin_user_id uuid,
  p_upload_id     bigint,
  p_creator_id    uuid,
  p_face_id       text,
  p_vendor        face_vendor,
  p_force         boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_active_count int;
BEGIN
  -- Re-assert admin (defense-in-depth; route already gates).
  IF NOT EXISTS (SELECT 1 FROM admin_roles WHERE user_id = p_admin_user_id) THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;

  -- R1-C2: SAME namespace as admin_force_retrain_creator so the two
  -- never race against each other.
  PERFORM pg_advisory_xact_lock(hashtext('creator_retrain:' || p_creator_id::text));

  -- Active-session check; bypass requires p_force.
  SELECT count(*) INTO v_active_count
    FROM sessions WHERE creator_id = p_creator_id AND ended_at IS NULL;
  IF v_active_count > 0 AND NOT p_force THEN
    RAISE EXCEPTION 'creator_has_active_session: % open', v_active_count
      USING ERRCODE = 'P0001';
  END IF;

  -- v1 vendor dispatch: only Simli writes simli_face_id. Future
  -- providers add columns + branches here.
  IF p_vendor = 'simli' THEN
    UPDATE creators SET simli_face_id = p_face_id, updated_at = now()
     WHERE id = p_creator_id;
  ELSE
    RAISE EXCEPTION 'unknown vendor: %', p_vendor USING ERRCODE = '22023';
  END IF;

  UPDATE face_clone_uploads
     SET face_id = p_face_id
   WHERE id = p_upload_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_finalize_locked(uuid, bigint, uuid, text, face_vendor, boolean) FROM public;
```

---

## 8. Failure modes + UX copy map

| Code | Status | Title | Body |
|---|---|---|---|
| `face_upload_only_in_production` | 503 | "Production-only" | "Face upload is production-only in v1. Populate via SQL on staging." |
| `bad_mime` | 415 | "Unsupported format" | "Use MP4 (H.264) or MOV." |
| `bad_aspect` | 400 | "Aspect ratio out of range" | "Need 9:16, 16:9, or 1:1." |
| `face_too_short` | 400 | "Video too short" | "Need at least 5 seconds." |
| `face_too_long` | 400 | "Video too long" | "Trim to ≤ 120 seconds." |
| `face_too_large` | 413 | "File too large" | "Max 50 MB. Re-encode at lower bitrate." |
| `bad_video_dims` | 400 | "Resolution out of range" | "Need 256×256 minimum, 4K maximum." |
| `face_no_subject` | 422 | "Face not detected" | "Use a clip where the creator's face is clearly visible and centered." |
| `face_train_failed` | 502 | "Vendor rejected the file" | "Try a different clip. Persists? File a bug." |
| `face_train_unreachable` | 502 | "Vendor unreachable" | "Vendor side is down. Retry in a minute." |
| `face_train_async_pending` | 504 | "Training still in progress" | "Vendor is still training. Refresh in a minute." |
| `creator_has_active_session` | 409 | "Live sessions in progress" | "End the active sessions before replacing the face." |
| `already_face_trained` | 409 | "Face already exists" | "Check 'Overwrite' and resubmit." |
| `rate_limit` | 429 | "Daily limit reached" | "Max 3 successful face trainings per 24h." |
| `rate_limit_attempts` | 429 | "Too many failed attempts" | "Wait 24h or check Simli status." |

---

## 9. Files touched

| File | Change |
|---|---|
| `supabase/migrations/20260508000001_face_vendor_enum_and_uploads.sql` | NEW — `face_vendor` enum + `face_clone_uploads` table |
| `supabase/migrations/20260508000002_face_clone_finalize_locked.sql` | NEW — finalize RPC w/ shared `creator_retrain:` lock namespace |
| `src/lib/avatar/face-mint-bridge.ts` | NEW — provider-agnostic interface |
| `src/lib/avatar/face-mint-simli.ts` | NEW — Simli factory; only file referencing `SIMLI_API_KEY` for face-train |
| `src/lib/avatar/face-mint.ts` | NEW — env-driven factory selector |
| `src/lib/avatar/mp4-probe.ts` | NEW — magic-byte + duration + dims |
| `src/lib/avatar/face-cost.ts` | NEW — `SIMLI_FACE_TRAIN_USD_PER_SEC` + `SIMLI_QUOTED_AT` boot validators |
| `src/app/api/admin/face-upload/route.ts` | NEW — mirrors voice-clone route |
| `src/app/admin/creators/[id]/face-upload.tsx` | NEW — mirrors voice-clone-upload cell |
| `src/app/admin/creators/[id]/page.tsx` | mount `<FaceUpload>` next to `<VoiceCloneUpload>` |
| `src/app/admin/creators/[id]/health/force-retrain-button.tsx` | post-retrain success → "now upload new face" prompt linking to face-upload cell |
| `src/app/api/admin/voice-clone/route.ts` | read `CREATOR_CLONE_RATE_LIMIT_BYPASS` (alias) — R1-M1 |
| `CLAUDE.md` | document `CREATOR_CLONE_RATE_LIMIT_BYPASS` rename + alias cycle — R1-M1 |
| `.env.example` | add new env names (face-train pricing + bypass alias) |
| `docs/_planning/PHASE_0_FACE_API.md` | NEW — Phase 0 verification artifact (§12) |

**No changes** to: voice-proxy, simli-bridge, mint-simli, AvatarBridge,
session lifecycle, /api/sessions/*. Face-upload is creator-onboarding
only.

---

## 10. Tests

- Unit: `mp4-probe.ts` against fixture MP4 (3s @ 720p) and a corrupt fixture.
- Unit: `face-mint-simli.ts` against a mocked Simli HTTP layer (200 ok,
  202 async-pending, 422 no-face, 500 unreachable).
- Unit: `face_clone_finalize_locked` (pgtap or harness) — verify the
  lock namespace matches `admin_force_retrain_creator`.
- Integration (real-API gated): `RUN_REAL_FACE_API_TESTS=1` uploads
  fixture clip → asserts face_id returned + visible in
  `/admin/creators/[id]`. Fixture path checked into the repo at
  `scripts/fixtures/face-test-vuk-5s.mp4` (R1-S — reproducible, not
  Vuk-specific runtime).
- Manual: end-to-end Vuk upload → SQL verify `simli_face_id` written
  → `/s/[id]` session → avatar lipsyncs.

---

## 11. Open questions for Vuk

1. **Image-upload path:** v1 ships video-only (R1-C4). OK to defer
   single-frame avatar to v2?
2. **Storage of source video:** v1 vendor-only (R1-M2). Defer storing
   to a bucket until force-retrain automation is built. OK?
3. **Rate-limit env rename:** `VOICE_CLONE_RATE_LIMIT_BYPASS` →
   `CREATOR_CLONE_RATE_LIMIT_BYPASS` with a one-cycle alias. Both
   routes read the union of both env names. Acceptable?
4. **Async-train hedge:** if Phase 0 (§12) finds Simli returns 202 +
   webhook (not synchronous JSON), we add a webhook receiver — adds
   ~half a day. OK to defer that work to after Phase 0 returns a verdict?
5. **Force-retrain UI integration:** after force-retrain succeeds, the
   button auto-scrolls to the `<FaceUpload>` cell with a "now upload"
   prompt. +5 LOC. OK?

---

## 12. Phase 0: Simli wire-format verification (HARD GATE — R1-C3)

Before any of §1–§10 is implemented, produce
`docs/_planning/PHASE_0_FACE_API.md` answering:

1. **Endpoint URL** for face-train. Inferred candidates:
   `POST https://api.simli.ai/faces`,
   `POST https://api.simli.ai/face/generate`,
   `POST https://api.simli.ai/createFace`. Confirm with `curl -X POST
   <URL> -H "x-simli-api-key: $SIMLI_API_KEY" -F "file=@fixture.mp4"`
   against test API key.
2. **Request shape:** multipart vs JSON, field names.
3. **Response shape:** synchronous JSON `{faceId}` vs async
   `{jobId, status}` vs webhook callback.
4. **Error codes:** what does 422 look like for "face not detected"?
   What's the rate-limit error?
5. **Trinity-1 routing:** is the face vs avatar tier-distinction at
   train time or session-open time?

If Simli is async (202 + webhook), §2 / §5 step 10 / §10 unit tests
expand to include a webhook receiver at
`/api/admin/face-upload/webhook`. **Spec frozen** post-Phase-0; only
then is the half-day estimate honest.

If verification can't be done (Simli support unresponsive), pivot to
**option B**: ask Vuk to upload via Simli's portal manually, populate
`simli_face_id` via SQL, ship Feature #2 cutover without face-upload
admin UI. Re-attempt face-upload as v1.1.

---

## 13. Sequencing

This is a one-PR feature. Estimate revised: **~1 day** (not half;
Phase 0 + async-hedge + bigger validation surface). Lands AFTER Feature
#2 cutover is committed, tested locally, and pushed.

PR sequence: Phase 0 doc → migrations → bridge interface + Simli
factory → mp4-probe + face-cost → route → UI → mount → tests → manual
Vuk verification.

---

## 14. Audit revisions log

### Round 1 (audit #1)
- **R1-C1 (env-scoping):** v1 is production-only; no `_preview`/`_dev`
  columns. Documented in §1.
- **R1-C2 (advisory-lock collision):** finalize RPC uses **same**
  `creator_retrain:<id>` namespace as `admin_force_retrain_creator`.
  Documented in §5 step 11 + §7 RPC body.
- **R1-C3 (Simli wire format):** Phase 0 promoted to a HARD GATE in
  §12 with a checked-in artifact required.
- **R1-C4 (image scope):** dropped from v1; video-only.
- **R1-M1 (env rename):** `CREATOR_CLONE_RATE_LIMIT_BYPASS` with
  one-cycle alias; both routes union both env names. CLAUDE.md +
  voice-clone route added to files-touched.
- **R1-M2 (storage):** option (a) dropped. Vendor-only mirrors
  voice-clone.
- **R1-M3 (file naming):** `face-mint-bridge.ts` (interface) +
  `face-mint-simli.ts` (impl) + `face-mint.ts` (factory).
- **R1-M4 (vendor type):** Postgres ENUM `face_vendor`, not CHECK.
- **R1-M5 (race acceptance):** session-open does NOT take the lock.
  Race window documented; orphan-cleanup via existing pattern.
- **R1-M6 (duration mismatch):** schema CHECK aligned to 5–120s.
- **R1-M7 (cogs_log):** §5 step 12 adds face-train cogs row with
  pinned `SIMLI_FACE_TRAIN_USD_PER_SEC` + `SIMLI_QUOTED_AT`, fail-closed
  at boot.
- **R1-S (smalls):** dropped `tier` from `TrainFaceInput`; added
  `bad_aspect` error code; `playsInline` on preview video; fixture
  path checked in; `referral-token.ts` removed from files-touched;
  package.json verified for `image-size` (we don't need it now —
  video-only).
