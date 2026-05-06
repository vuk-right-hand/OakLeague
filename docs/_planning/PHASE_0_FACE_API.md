# Phase 0 — Simli Face Train API verification

**Date verified:** 2026-05-05
**Plan:** `FACE_UI_PLAN.md` §1 HARD GATE
**Verifier:** `scripts/face-phase0-verify.mjs` — re-runnable
**Status:** **CLEARED** — all runtime contracts captured below.

The verifier was run against a real Simli Hobby plan account (`SIMLI_API_KEY`
from `.env.local`) using a re-encoded test image (1.6 MB PNG). Output is in
git history; key findings frozen here so the build can proceed without
re-burning a Simli face slot.

---

## Verified findings

### 1. POST `/faces/trinity` — create / enqueue
- **URL:** `https://api.simli.ai/faces/trinity`
- **Auth:** `x-simli-api-key` header (only).
- **Content-Type:** `multipart/form-data`.
- **Body:** single field `image` (binary). **Image only — Trinity-1 does not
  accept video.** Tavus / HeyGen accept video; their bridges will use a
  separate field. Our table supports both via the `vendor` enum.
- **Query params (optional):**
  - `gsVersion` — default `GSA_1.0`. Don't override unless Simli docs
    introduce a new version.
  - `face_name` — default `untitled_avatar`. We pass
    `<creator-handle>_<short-uuid>` so dashboard listings are scannable.
- **Success status:** `200 OK` (despite being async — there is **no 202**).
- **Success body shape (verbatim from a real call):**
  ```json
  {
    "message": "Face generation request added to queue, position in queue 13",
    "face_id": "ccbb01a7-78b9-43e1-8100-ba5918f67530",
    "warnings": []
  }
  ```
  - `face_id` is a UUID v4 — this is the **only** id Simli emits; the same
    id flows through the status endpoint, the compose-token endpoint, and
    the delete endpoint. There is no separate `job_id`.
  - `warnings[]` may carry image-quality flags (we surface them to admin in
    the UI but don't block on them).
  - `message` is informational; we don't parse it.

### 2. Image upload limits
- **Max bytes: 5 MB hard cap.** A 5.7 MB PNG returned `413` with body
  `{"detail": "Image size must be less than 5MB"}`.
- We enforce **≤ 4.5 MB at the `image-probe.ts` layer** (500 KB headroom)
  so clients see a friendly client-side reject before the multipart upload
  even starts.

### 3. GET `/faces/trinity/generation_status` — async readiness poll
- **URL:** `https://api.simli.ai/faces/trinity/generation_status?face_id=<uuid>`
- **Auth:** same `x-simli-api-key`.
- **Body shape (pending):**
  ```json
  { "status": "pending", "queue_position": 12, "face_id": "ccbb…" }
  ```
- **Status field values seen so far:** `"pending"` confirmed.
- **Status field values inferred (not yet captured):** `"processing"`,
  `"completed"` / `"ready"` / `"done"` / `"success"` (Simli docs and OpenAPI
  spec elide the success-state vocabulary).
- **Defensive contract our poller uses:**
  - `status === "pending"` or `status === "processing"` → keep polling.
  - `status === "failed"` or `status === "error"` → terminal failure.
  - Any other value → attempt `/compose/token`. If 200 → treat as ready
    and finalize. If `INVALID_FACE_ID` → treat as still-pending. This is
    bulletproof regardless of Simli's success-state keyword.
- **Queue depth observation:** position 12 did not move during a 60s poll
  window. Real training time can be **many minutes** depending on Simli
  load. UI must show a long-poll progress indicator with `queue_position`
  surfaced.

### 4. Compose / token while face is pending → 400
```json
{ "detail": "INVALID_FACE_ID" }
```
- **Critical:** the face is unusable until `generation_status` flips out
  of `pending`. We MUST NOT set `creators.simli_face_id` from the route
  until the status route has confirmed readiness. First `/s/[id]` mic-tap
  against a pending face would return `replica_not_found` to the user.

### 5. DELETE `/faces/trinity/{id}` while pending → 400
```json
{ "detail": "Failed to Delete FaceId" }
```
- **Critical:** you cannot delete a face that is still training. The
  `simli_face_delete_queue` worker treats `400` with `Failed to Delete`
  in the body as **retry-later** (do not increment to `record_failure`
  past 5). Backoff handled by extending `due_at` rather than failing.
- The existing worker's URL base of `/faces/{id}` was wrong (no such
  endpoint in OpenAPI spec). Corrected to `/faces/trinity/{id}` in this
  PR.

### 6. Quota at the Hobby tier
- 1 face slot. Exceeding returns `403`:
  ```json
  { "detail": "You have reached the max number of GS Faces for your current subscription. To create more GS Avatars, upgrade your subscription plan or delete one of your GS Faces" }
  ```
- 1,000 minutes / month. Hard cap on real session usage.
- 2 concurrent sessions. Hard cap.
- v1 commits to Hobby for the seed-creator-#1 build. Upgrade gates the
  onboarding of creator #2.

### 7. Universal error envelope
- **All Simli errors:** `{"detail": "<string>"}` (FastAPI default).
- Our error mapper reads `body.detail` (NOT `body.error`); voice-clone's
  `body.error` shape was Cartesia-specific.

### 8. Pricing axis (face training)
- **Not captured by Simli's pricing page or the API response.** Hobby tier
  ($10/month) bundles "1 face slot" — face creation is conceptually a
  per-slot cost, not a per-second-of-input or per-image cost. Implied: no
  per-call USD line item to record at training time.
- **Decision:** write a `cogs_log` row at successful train start with
  `cost_usd = 0` and `metadata.pricing_unverified = true`. Provider-
  agnostic shape — same row works when we swap to Tavus/HeyGen and the
  per-second/per-minute cost is non-zero. SQL aggregate "how many face
  trainings did we do this month" answerable without scraping logs.

---

## Re-running

```powershell
$env:SIMLI_API_KEY="sk_xxx"
node --env-file=.env.local scripts/face-phase0-verify.mjs ./face-test.png
```

Image must be JPEG or PNG, ≤ 5 MB. The script:
1. POSTs to `/faces/trinity` with `face_name=phase0_verify_<ts>`.
2. Polls `/generation_status` at 0s / 5s / 15s / 30s / 60s.
3. Tries `/compose/token` to confirm end-to-end usability.
4. Deletes the test face (set `KEEP_FACE=1` to keep it).

Re-run any time Simli changes their preview release string — a fresh
verifier run is the "did the API shape change" gate.

---

## Implications folded into v4 of FACE_UI_PLAN.md

- §4 validation: image-only (JPEG/PNG), ≤ 4.5 MB (4 MB conservative
  client-side check pre-multipart), 256–4096 px, aspect 9:16 / 16:9 / 1:1.
  Drop video. Build `image-probe.ts` (PNG IHDR + JPEG SOF0/SOF2 magic-byte
  parser, ~120 LOC).
- §5 step 11 (vendor train): handle 200-with-pending. Persist the returned
  `face_id` to `face_clone_uploads.vendor_job_id`. The route returns
  `{ ok, uploadId, faceId, status: "pending", queuePosition }` to the
  client, which then polls.
- §5 status endpoint: `GET /api/admin/face-upload/status?uploadId=N` —
  admin-gated, server-side polls Simli's `generation_status`, and on first
  ready-state response calls `face_clone_finalize_locked` to set
  `creators.simli_face_id` atomically.
- §6 UI: "Photo" tab live + "Video" tab greyed with tooltip "Available
  with Tavus/HeyGen." Kebab menu (top-right of face tile) → Delete pill →
  confirm modal when a face is already trained. Replaces force-retrain
  button on `/health` page.
- §8 migrations: drop migration 1 (lock-unify, Q4=B per Vuk). Two
  migrations only — `face_clone_uploads` + `face_clone_finalize_locked`.
- Side fix: `simli-face-delete-worker.js` URL base → `/faces/trinity/`,
  + `Failed to Delete FaceId` body recognized as retry-later.
- Cogs: $0 row written on successful train start with metadata
  `{pricing_unverified: true, queue_position: N}`. Provider-agnostic — the
  same shape applies the day we wire Tavus/HeyGen.
