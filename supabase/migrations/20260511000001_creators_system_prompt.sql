-- 20260511000001 — creators.system_prompt + brain_compiled_at
--
-- Brain wire-up Phase 1 (R3 audit). Persona column for the Gemini Live
-- systemInstruction. Soft target ≤700 ASCII chars (~180 tokens) to stay
-- under the documented 200-token resumption regression threshold for
-- gemini-3.1-flash-live-preview. Multi-byte personas (CJK, Cyrillic) hit
-- the threshold earlier — v1 acceptable; documented in plan §R2.
--
-- Audit dispositions reflected here:
--   * R3 small: octet_length, not length() — byte-bounded so a Cyrillic
--     persona at 2000 codepoints (~4KB) doesn't sail past the threshold.
--   * R3 M1: brain_status is intentionally NOT touched by compile RPC —
--     this column is a separate readiness flag gated on voice + face.
--     brain_compiled_at is the freshness oracle.

ALTER TABLE public.creators
  ADD COLUMN system_prompt text,
  ADD COLUMN brain_compiled_at timestamptz,
  ADD CONSTRAINT creators_system_prompt_len_chk
    CHECK (system_prompt IS NULL OR (octet_length(system_prompt) BETWEEN 1 AND 2000));

COMMENT ON COLUMN public.creators.system_prompt IS
  'Pre-compiled creator persona for Gemini Live systemInstruction. Target ≤700 ASCII chars (~180 tokens) to stay under the 200-token resumption regression threshold for gemini-3.1-flash-live-preview. Compiled by _creator_brain_compile_unsafe().';
COMMENT ON COLUMN public.creators.brain_compiled_at IS
  'Last persona compile timestamp. Decoupled from brain_status: a compiled persona doesn''t mean the creator is publish-ready (voice clone + face still required). brain_status remains the readiness gate; brain_compiled_at is the freshness oracle.';
