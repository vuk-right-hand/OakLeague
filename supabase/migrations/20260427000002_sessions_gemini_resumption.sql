-- 0046 — sessions.gemini_resumption_handle
--
-- Days 8–12 plan REV 5, migration 2 of 11.
-- Holds the opaque handle returned by Gemini Live's SessionResumptionUpdate
-- events. Phase 0 verified `@google/genai@1.50.1` exposes the types
-- (`SessionResumptionConfig` / `LiveServerSessionResumptionUpdate`), so the
-- native-resumption path can ride on top of the transcript-replay fallback
-- behind env flag `VOICE_GEMINI_NATIVE_RESUMPTION=1` (N2-S8).
--
-- Column is nullable (not every session resumes; handle may not have been
-- received yet at crash time) and opaque text (length + structure are
-- upstream-controlled; we do not parse it).
--
-- Audit M2: floor relaxed from 16 to 1. Google's handle is opaque; nothing
-- in the SDK or docs guarantees any minimum length. Upper bound of 4096
-- guards against unbounded payloads at UPDATE time.

ALTER TABLE public.sessions
  ADD COLUMN gemini_resumption_handle text
    CHECK (
      gemini_resumption_handle IS NULL
      OR char_length(gemini_resumption_handle) BETWEEN 1 AND 4096
    );
