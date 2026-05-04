-- R4-M3 — Cartesia voice-delete queue.
--
-- Vercel serverless functions cannot survive 60s post-response, so the
-- ?force=1 overwrite path cannot itself perform the deferred DELETE
-- /voices/{id} call. The Next.js admin route enqueues the prior voice id
-- here; the Fly proxy's worker tick (every 30s) drains rows whose
-- `due_at` has passed.
--
-- 60s defer (set by the route as `now() + 60s`) is the C3 race-window
-- safeguard: any session that opened during the swap finishes its first
-- turn well within 60s, so DELETE never lands while a context is active.
--
-- Append-only-ish: rows are INSERTed by the route, DELETEd by the worker
-- on success. No UPDATE path. Service-role only.

CREATE TABLE public.voice_delete_queue (
  voice_id      text        PRIMARY KEY CHECK (char_length(voice_id) BETWEEN 1 AND 128),
  enqueued_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  due_at        timestamptz NOT NULL,
  attempts      int         NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  last_error    text        CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_delete_queue_due_at_idx
  ON public.voice_delete_queue (due_at)
  WHERE attempts < 10;

CREATE TRIGGER voice_delete_queue_touch_updated_at
  BEFORE UPDATE ON public.voice_delete_queue
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.voice_delete_queue ENABLE ROW LEVEL SECURITY;
-- Zero policies — service-role only writes/reads.
