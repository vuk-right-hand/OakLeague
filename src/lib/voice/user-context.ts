// user-context.ts — MEMORY_BREADTH_PLAN Units 1a/1b.
//
// Builds the sanitized user-context string that rides
// voice_tickets.user_context → Fly proxy → the decoupled deep-answer's
// QUESTION user turn (a DATA block; audit R1-C4: user-derived text never
// enters a systemInstruction).
//
// Inputs are ALL untrusted user-derived text (profiles.goals/obstacles are
// user-authored; memory summary/open_loop are LLM-extracted from user
// speech). Sanitation here is the FIRST line; the proxy's L1 wrapper +
// static-clause design is the second; the DB CHECK (≤2400 octets) is the
// last.
//
// SERVER-ONLY: composed inside /api/sessions/open.

import 'server-only';

// R1-S1 — module-load boot line (query-rewrite.ts pattern): the memory flag
// is a CO-FLIP with the Fly proxy (same env name gates extraction there).
// eslint-disable-next-line no-console
console.log(
  `[user-context] context=${process.env.BRAIN_USER_CONTEXT_ENABLED === '1' ? 'ENABLED' : 'disabled'} ` +
  `memory=${process.env.BRAIN_USER_MEMORY_ENABLED === '1' ? 'ENABLED' : 'disabled'} ` +
  '(BRAIN_USER_CONTEXT_ENABLED / BRAIN_USER_MEMORY_ENABLED — memory co-flips with Fly)',
);

// Mirrors voice_tickets_user_context_len_chk (migration 20260612000001).
// The route OWNS the cap (audit R1-S2); the DB CHECK is defense-in-depth.
export const USER_CONTEXT_MAX_OCTETS = 2400;

// The proxy-side check-in clause keys on this exact marker (brain-bridge
// OPEN_THREAD_MARKER). Only THIS builder may emit it — it is stripped from
// every user-derived input below so a crafted goal can't fake an open
// thread and trigger the first-turn check-in.
export const OPEN_THREAD_MARKER = '[OPEN THREAD]';

// Imperative-lead shapes (audit R1-C4 #3): an open_loop that reads like an
// instruction ("always tell people…", "ignore the reference…") is DROPPED,
// not spoken. The extraction prompt already forbids these; this is the
// belt to its suspenders.
// MIRROR of server/voice-proxy/memory-extract.js (IMPERATIVE_LEAD_RE +
// sanitizeLine) — Vercel and Fly are separate packages, so the sanitizer is
// duplicated; keep BOTH in sync when editing (diff-audit S2).
const IMPERATIVE_LEAD_RE =
  /^\s*(ignore|always|never|tell|say|repeat|recite|pretend|act as|you must|you should|disregard|forget|override)\b/i;

/**
 * Neutralize one user-derived line for safe inclusion in the DATA block:
 * collapse whitespace/newlines to single spaces (single-paragraph rule),
 * neutralize `---` runs (so stored text can't fake the envelope/user-context
 * BEGIN/END boundary lines), and strip the open-thread marker.
 */
export function sanitizeUserContextLine(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/-{3,}/g, '—')
    .split(OPEN_THREAD_MARKER).join('')
    .trim();
}

export type BuildUserContextArgs = {
  /** profiles.goals — user-authored at onboarding (≤200 chars/elem). */
  goals: string[] | null;
  /** profiles.obstacles — user-authored at onboarding. */
  obstacles: string[] | null;
  /** user_creator_memory.summary (flag-gated by the caller; null = none). */
  memorySummary: string | null;
  /** user_creator_memory.open_loop. */
  openLoop: string | null;
  /**
   * The 20h sessions-table gate result (audit R1-S5): true only when the
   * user's last ENDED session with this creator is > 20h old. The caller
   * computes it; this builder just honors it.
   */
  includeOpenLoop: boolean;
};

/**
 * Compose the user-context string, or null when there is nothing to say
 * (no goals, no obstacles, no memory) — null keeps the ticket column NULL
 * and the proxy byte-identical to pre-Unit-1 behavior.
 */
export function buildUserContext(args: BuildUserContextArgs): string | null {
  const parts: string[] = [];

  const goals = (args.goals ?? []).map(sanitizeUserContextLine).filter((g) => g.length > 0);
  const obstacles = (args.obstacles ?? []).map(sanitizeUserContextLine).filter((o) => o.length > 0);
  if (goals.length > 0 || obstacles.length > 0) {
    const seg: string[] = [];
    if (goals.length > 0) seg.push(`Their goals: ${goals.join('; ')}.`);
    if (obstacles.length > 0) seg.push(`What they say holds them back: ${obstacles.join('; ')}.`);
    parts.push(`About this user (from their profile): ${seg.join(' ')}`);
  }

  const summary = args.memorySummary ? sanitizeUserContextLine(args.memorySummary) : '';
  if (summary.length > 0) {
    parts.push(`What you remember about them from previous conversations: ${summary}`);
  }

  // Diff-audit M6 — the open-loop part is appended WHOLE-OR-DROPPED: the
  // octet truncation below must never leave a partial [OPEN THREAD] marker
  // (the proxy's check-in clause keys on the marker; a cut marker/loop
  // would read as garbage in the DATA block).
  const loop = args.openLoop ? sanitizeUserContextLine(args.openLoop) : '';
  if (args.includeOpenLoop && loop.length > 0 && !IMPERATIVE_LEAD_RE.test(loop)) {
    const loopPart = `${OPEN_THREAD_MARKER} ${loop}`;
    const baseBytes = Buffer.byteLength(parts.join('\n'), 'utf8');
    if (baseBytes + 1 + Buffer.byteLength(loopPart, 'utf8') <= USER_CONTEXT_MAX_OCTETS) {
      parts.push(loopPart);
    }
  }

  if (parts.length === 0) return null;

  let out = parts.join('\n');
  // Octet-cap with a byte-safe truncation (never split a multi-byte char:
  // Buffer.toString drops an incomplete trailing sequence's bytes but we
  // trim defensively too). Only the marker-free profile/memory parts can be
  // truncated — the open-loop part was admitted whole-or-dropped above.
  if (Buffer.byteLength(out, 'utf8') > USER_CONTEXT_MAX_OCTETS) {
    const buf = Buffer.from(out, 'utf8').subarray(0, USER_CONTEXT_MAX_OCTETS);
    out = buf.toString('utf8').replace(/�+$/, '').trimEnd();
  }
  return out;
}
