# v1.2 polish backlog

Items deferred from the brain-wireup ship (2026-05-11). All are non-blocking
for YC, pgvector, or production usage. Batch as a single ~1-week arc *after*
the pgvector RAG arc lands.

## HeyGen self-service gaps

- **Creator video upload UI**
  Schema is ready (`face_clone_uploads.media_kind ENUM('image','video')` exists, video mime types accepted in CHECK). Blockers: the table-level CHECK at `20260508000001_face_clone_uploads.sql:66` explicitly blocks video; `src/app/api/admin/face-upload/route.ts:202,351` hard-codes `media_kind: 'image'`; no video tab in the upload UI. Estimated effort: ~3 hours.

- **Per-creator vendor toggle**
  Today: `resolveAvatarProvider(tier)` reads env vars `AVATAR_PROVIDER_FREE|_PREMIUM|_BOARDROOM`. Cannot have some premium creators on Simli and others on HeyGen simultaneously. Fix: add `creators.preferred_face_vendor face_vendor` (column already exists in enum), have `resolveAvatarProvider` read from creator row first and fall back to env. Estimated effort: ~2 hours + admin UI affordance to flip the column.

## Feed UX regressions

- **Same video → multiple hooks with different titles**
  User-reported pattern (2026-05-04 to 2026-05-11): the same long-form appearing 3× in feed with different hook titles. Could be data (legitimate multi-hook-per-video, working as designed) or a feed-dedup miss. Investigation needed: query `hooks` table grouped by `video_id` to confirm whether multiple hooks-per-video is the intended product behavior. If yes, this isn't a bug — close. If no, fix dedup in `feed_ranked_page` RPC.

- **Vertical scroll / 3-hooks-per-video group not rendering**
  Used to render `video-row.tsx` with multiple hook panels stacked per video; now only 1 panel shows. Either feed RPC stopped returning grouped data, or `feed-container.tsx` regressed. Investigate.

- **New long-form upload not surfacing in feed**
  User uploaded a long-form on 2026-05-11; doesn't appear in feed scroll. Likely related to dedup behavior above. Check whether the upload created `hooks` rows linked to the new video — feed surfaces hooks, not videos directly.

## When to revisit

Open a `feat/v1-2-polish` branch after `feat/brain-vector-rag` lands and merges.
Walk this list top-to-bottom. None require migrations beyond what's already in
the codebase. Audit pass before code per CLAUDE.md planning loop.
