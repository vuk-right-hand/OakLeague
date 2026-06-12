# Creator Studio — WS4 (voice) / WS5 (face) / WS6 (videos) self-serve

**Status:** pre-build plan, drafted 2026-06-12. Owner: Vuk. Branch `feat/creator-studio` (worktree off main 142beed).
**Product decision (Vuk, 2026-06-12):** creators upload hooks + long-form and they go live **without per-video approval**. Vetting is at the creator level (invite-only + admin creator-publish gate). Admin keeps takedown/unpublish. Light guardrails: per-creator quotas + Mux `ready` gates (money + brokenness, not trust).

## 0. The trap (memory: creator-journey audit)
**Do NOT wrap admin routes.** Admin routes carry admin-shaped guards (`assertAdminFromSession`, `admin_user_id NOT NULL` audit columns, admin-asserting finalize RPCs, per-admin rate limits). Every creator path below is a NEW route/action: `assertCreatorFromSession()` → creatorId **from session only** (never from body) → ownership joins → mutate. Shared mechanics (probes, Cartesia/Simli/Mux calls) are lifted into `src/lib/` helpers both sides import.

## 1. What exists (verified by reading code)
- **Voice:** admin `/api/admin/voice-clone` — WAV-only (probeWav), 3–120s, ≤10MB, consent gate (`creator_consents.voice_clone` — **already recorded at /apply** for every creator), `voice_clone_finalize_locked` RPC (asserts admin, advisory lock, active-session guard), `voice_delete_queue` (composite PK tts_provider+voice_id), prod-only env gate, per-admin 3 success/20 attempts per 24h. `voice_clone_uploads.admin_user_id NOT NULL`.
- **Face:** admin `/api/admin/face-upload` (+`/status` poll) — jpeg/png ≤4.5MB, dims 256–4096, aspect 9:16|16:9|1:1, Simli Trinity async → `face_clone_uploads.state` → status route calls `face_clone_finalize_locked` (asserts admin) → sets `creators.simli_face_id`. Same consent (likeness, recorded at /apply), prod-only gate (`FACE_UPLOAD_ALLOW_LOCAL=1` bypass), same rate limits. `face_clone_uploads.admin_user_id NOT NULL`.
- **Video:** `videos` (title/desc/`long_form_mux_*`, publish = `published_at` + `long_form_published_at`) + `hooks` (1–5 `lesson_number` per video, own `mux_*` cols, `topic_tags[]`). `/api/admin/mux-upload` mints direct-upload URLs keyed on row `mux_passthrough` (states pending|failed only; 20 mints/min). Webhook dispatches by passthrough (actor-agnostic — reusable as-is). Publish gates: long-form `ready` + aspect `16:9` + 300–3300s; hooks ready implicitly via feed gate. Admin actions: create/publish/replace/reset.
- **UI to mirror:** `video-detail-client.tsx` (MuxUploader usage), `voice-clone-upload.tsx`, DeepBrainPanel pattern for status-poll cards.

## 2. Build units (order: migration → WS6 → WS5 → WS4; TDD per unit)

### Unit A — migration `2026xxxx_creator_studio.sql` + pgTAP
1. `voice_clone_uploads` + `face_clone_uploads`: `admin_user_id` → **nullable**, add `uploaded_by_user_id uuid REFERENCES auth.users` + CHECK (exactly one of admin_user_id/uploaded_by_user_id is NOT NULL — actor provenance always present). Update BOTH tables' existing pgTAP for the relaxed constraint. Grep all INSERTs (routes) — admin routes keep writing admin_user_id; no caller breaks.
2. **`voice_clone_finalize_creator(p_upload_id, p_voice_id)`** + **`face_clone_finalize_creator(p_upload_id)`**: SECDEF, derive creator from `auth.uid()` (NO creator_id param — IDOR-proof, deep-brain pattern), assert upload row belongs to own creator, then SAME body semantics as `_locked` variants (advisory lock, active-session guard on overwrite, atomic two-table update). **Extract shared `_voice_clone_finalize_core(...)` / `_face_clone_finalize_core(...)` called by both admin + creator wrappers** (deep-brain C2 lesson: parity must be structural). Update admin-RPC pgTAP in same change; full suite must stay green. REVOKE/GRANT footers (grant-leak incident rule).
3. **Voice source persistence (fish buffer-room, memory `project_fish_audio_tts_swap`):** storage bucket `voice-source` (service-role only, no public access) — raw WAV persisted at `{creator_id}/{upload_id}.wav` so future fish clones never need a re-record. Column `voice_clone_uploads.source_object_path text`.
4. **Voice scripts:** `voice_clone_scripts` table (id, creator_id, script jsonb [4 sentences + emotion labels], created_at, used_at) — service-role only. Script is server-generated; upload must reference a script row ≤30min old belonging to the creator (anti-replay; the random script is the liveness check).
5. Per-creator video quota helper: `creator_video_quota_check(creator)` or plain count in action — keep in TS (no RPC needed): max **20 videos** + 5 hooks/video (existing lesson_number CHECK).

### Unit B — WS6 creator videos (no approval)
- Server actions `src/app/creator/studio/actions.ts`: `creatorCreateVideo` (quota ≤20), `creatorCreateHook`, `creatorPublishVideo` (flips `published_at`; **also auto-publishes long-form** when ready with admin-identical gates 16:9 + 300–3300s — same code path via shared helper extracted from admin actions), `creatorReplaceHook`/`creatorResetFailed`/`creatorResetLongForm` (Mux delete + passthrough regen — lift admin bodies into `src/lib/mux/manage.ts`, both import). EVERY action: `assertCreatorFromSession` → ownership check (video.creator_id = own) → whitelist fields.
- Route `POST /creator/api/mux-upload`: mirror admin mint route, targets `hook|video_long_form` only (NO welcome_hook), ownership join (hook→video→creator_id own), `rate_limit_hit('creator_mux_upload', userId, '1 minute', 20)`.
- UI `/creator/studio` page + client: list own videos (status chips), new-video form, per-video detail (hook slots 1–5 + long-form, MuxUploader, publish toggle). Reuse `video-detail-client.tsx` structure with creator copy.
- Webhook: untouched (passthrough-keyed, actor-agnostic).
- Feed safety: unpublished CREATOR never leaks (feed RPCs filter `creators.published_at` — verified in merge audit).

### Unit C — WS5 creator face
- Route `POST /creator/api/face-upload` + `GET /creator/api/face-upload/status`: mirror admin (probeImage, Simli call, pending→poll→`face_clone_finalize_creator`), consent = likeness EXISTS for own user, rate limits keyed on creator user (3 success/20 attempts per 24h via the uploads-table count pattern, `uploaded_by_user_id`), prod-only gate + `FACE_UPLOAD_ALLOW_LOCAL` parity. Replace semantics: allowed (force) while creator unpublished; once published, replacement stays admin-only (avatar identity is live product surface) → 409 `face_locked_while_live`.
- UI: Face card on `/creator/studio` (photo pick + client downscale preview + status poll, mirrors admin panel).

### Unit D — WS4 creator voice record
- **Script endpoint** `POST /creator/api/voice-script`: generates 4-sentence script (4 core emotions: neutral/excited/serious/warm) from server-side phrase banks, inserts `voice_clone_scripts`, returns {scriptId, sentences[]}. "Generate new" = call again (rate_limit 10/min).
- **Recorder UI** (Voice card): getUserMedia → WebAudio PCM capture → **client-built 16-bit mono WAV** (60s cap ≈ 5.3MB < 10MB; WAV because server probe + Cartesia path are WAV-pinned; MediaRecorder webm is NOT in the mime allowlist). Script teleprompter (sentence-by-sentence w/ emotion cue), level meter, playback review, re-record, submit. **Recording-only — no file upload** (locked decision: random script = the "real human" check; an uploaded file can't follow a script minted 30s ago).
- **Clone route** `POST /creator/api/voice-clone`: assertCreator → consent (voice_clone) → scriptId valid+own+fresh → probeWav 20–120s → persist WAV to `voice-source` bucket → insert upload row (`uploaded_by_user_id`, `source_object_path`, script ref) → Cartesia clone → `voice_clone_finalize_creator` → defer-delete prior voice (existing queue). Re-record allowed while unpublished; once published → 409 `voice_locked_while_live` (admin path for changes). Prod-only gate parity (`VOICE_CLONE_ALLOW_LOCAL=1` for local e2e).
- Fish note: cloning stays Cartesia (current pipeline). Fish clones later read the persisted source WAV — zero re-records (that's the buffer room).

### Unit E — dashboard integration + gates
- `/creator` page: Studio section linking Voice / Face / Videos cards with readiness chips (mirrors publish preconditions: voice_not_cloned, face_not_uploaded, no_corpus...) so a creator sees exactly what blocks "go live".
- Full `npm run build` + full pgTAP + auditor re-pass (SOP) + commit on branch. No push without Vuk.

## 3. Risks pre-seeded for the auditor
- R1 ownership/IDOR: every route derives creator from session; upload-row finalize asserts ownership inside SECDEF.
- R2 finalize parity: shared core extraction = same blast-radius discipline as deep-brain (update admin pgTAP same change).
- R3 actor-provenance: CHECK exactly-one-of admin/uploaded_by; rate limits keyed per actor kind.
- R4 COGS: video quota 20; mint rate-limit; Mux delete on replace (existing); voice/face 3-per-24h.
- R5 locked-while-live: published creators can't hot-swap voice/face (active-session guard already in finalize; add published_at gate).
- R6 WAV size/duration: 60s cap client + server probe; 10MB Content-Length pre-check.
- R7 script replay: 30min TTL + single-use (`used_at` stamped in finalize txn).
- R8 storage bucket: service-role only; no public read; path = creator-scoped.

---
## 4. AUDIT ROUND-1 RESOLUTIONS (2026-06-12) — requirements, not suggestions
- **C1 trigger NULL-trap:** voice_clone_uploads append-only trigger compares `NEW.admin_user_id = OLD.admin_user_id` → NULL=NULL → RAISE blocks EVERY creator finalize. Migration rewrites identity comparisons to `IS NOT DISTINCT FROM` + whitelists new cols (uploaded_by_user_id, source_object_path, script_id) + updates append-only pgTAP. Face trigger pattern is safe (verified) but gets the same treatment for symmetry.
- **C2 no shared core:** admin finalize RPCs assert `admin_roles` + service-role JWT — NOT shareable. Build fresh sibling `voice_clone_finalize_creator` / `face_clone_finalize_creator`: derive creator via `auth.uid()` (called via JWT-bound supabaseServer — service-role would NULL auth.uid()), assert upload row belongs to own creator, replicate lock + active-session + two-table update semantics. Admin RPCs untouched (byte-for-byte). Parity = review checklist, not shared PL/pgSQL.
- **C3 content exposure (no per-video approval):** Vuk's decision stands (creator-level vetting; no hold window, no per-video gate). Mitigations shipped instead: (a) `content_reports` table + public `POST /api/report` (hook/video/comment target, rate-limited, anon-ok) + admin queue page; (b) panic button = EXISTING admin creator-unpublish (20260523000006 cascade hides hooks/welcome; verified). Documented as accepted risk.
- **C4 publish gates:** extract `src/lib/videos/publish-gates.ts` (ready + 16:9 + 300–3300s + first-publish-wins) from admin publishLongForm; BOTH admin action and creator action call it (admin refactored same change, drift impossible).
- **C5 prod-only gate:** creator voice route replicates the HARD prod-only refusal (same as admin; no invented VOICE_CLONE_ALLOW_LOCAL — doesn't exist). Face route gets FACE_UPLOAD_ALLOW_LOCAL parity (exists).
- **M1 WAV:** recorder forces MONO + 16kHz (client downsample), 16-bit; server asserts channels===1, sampleRate ≤48k, duration 20–120s; 10MB pre-check stays.
- **M2 honesty:** script = replay-resistance + UX-guidance, NOT a liveness/human check (a malicious creator can have anyone read it). Real control = invite-only vetting. STT spot-check = logged follow-up, not built.
- **M3:** grep every SELECT on both upload tables; admin panels must tolerate NULL admin_user_id (creator rows). Creator rate-limit counts key on uploaded_by_user_id.
- **M4 takedown lock:** `videos.admin_removed_at` (nullable, admin-only set); creator publish/unpublish actions refuse when set; feed RPCs unchanged (creator-level gate covers feed; this stops video-level toggle-evasion).
- **M5 race:** finalize_creator re-reads `creators.published_at` UNDER the advisory lock: first-fill (no prior voice/face) always completes even if published mid-flight; overwrite blocked while published (409 *_locked_while_live).
- **M6:** creatorCreateHook asserts video.creator_id → creators.user_id === session.userId BEFORE insert (service-role bypasses RLS — TS assert is the guard).
- **M7 COGS:** quota = 20 videos AND total long-form minutes ≤600/creator (checked at mint time vs sum of existing long_form_mux_duration_ms); Mux cogs_log already written by webhook.
- Smalls: consent checked against creators.user_id (not session user); voice-source bucket = public=false, ZERO storage.objects policies, opaque path ids; script used_at stamped inside finalize txn; 20s floor documented.
