// Pure, framework-free formatter for the proactive minutes meter pill (Growth &
// Minutes Economy Phase 3). Split from minutes-meter.tsx (the client component) so
// it unit-tests in the node vitest env without a DOM — same pure-logic-split
// pattern as ask-error-copy.ts / session-reducer.ts.
//
// "X min left {today|this week|this month}" + a reset-countdown sublabel. When the
// user holds durable WALLET minutes (earned/purchased, which do NOT reset), the
// label switches to "(incl. earned)" and the reset sublabel is SUPPRESSED — telling
// a wallet user their minutes "reset in 2d" is false (only the free allowance does).
//
// The reset countdown is computed in the BROWSER's local time (like ask-error-pill):
// the server cap key is profiles.timezone, so a roaming user can see the countdown
// drift an hour or two from the real boundary. Accepted limitation for a polish pill.

export type MeterCapPeriod = 'daily' | 'weekly' | 'monthly';

export interface MeterCopyInput {
  remainingSeconds: number;     // effective_remaining (free allowance + wallet)
  capPeriod: MeterCapPeriod | null;
  walletRemaining: number;      // durable wallet seconds (0 for pure free users)
  now?: Date;                   // injectable for tests; defaults to new Date()
}

export interface MeterCopy {
  label: string;                // e.g. "12 min left this week"
  sublabel: string | null;      // e.g. "resets in 3d" — null when not applicable
}

const PERIOD_WORD: Record<MeterCapPeriod, string> = {
  daily: 'today',
  weekly: 'this week',
  monthly: 'this month',
};

export function formatMinutesMeter(input: MeterCopyInput): MeterCopy {
  const remaining = Math.max(0, Math.floor(Number(input.remainingSeconds) || 0));
  const wallet = Math.max(0, Math.floor(Number(input.walletRemaining) || 0));
  const now = input.now ?? new Date();

  // Headline minutes string. FLOOR so we never over-promise (13 when they have
  // 12.9); a sub-minute non-zero balance shows "<1 min" rather than a demoralizing
  // "0 min" that contradicts the user still being able to talk.
  let minStr: string;
  if (remaining <= 0) minStr = '0 min';
  else if (remaining < 60) minStr = '<1 min';
  else minStr = `${Math.floor(remaining / 60)} min`;

  const periodWord = input.capPeriod ? PERIOD_WORD[input.capPeriod] : null;

  // Wallet minutes aren't period-bound and don't reset, so when present we drop the
  // period qualifier and flag the total as including earned minutes.
  const label = wallet > 0
    ? `${minStr} left (incl. earned)`
    : periodWord ? `${minStr} left ${periodWord}` : `${minStr} left`;

  // Reset sublabel applies only to the free allowance — suppressed when the user has
  // wallet minutes (the earned portion never resets; the copy would mislead).
  let sublabel: string | null = null;
  if (wallet === 0 && input.capPeriod) {
    const ms = msUntilReset(input.capPeriod, now);
    if (ms != null && ms > 0) sublabel = `resets in ${formatCountdown(ms)}`;
  }

  return { label, sublabel };
}

// ms until the next LOCAL reset boundary for the given cap period. Local-time math
// (matches the server's per-tz day / ISO-week / month buckets closely enough — see
// the header note on roaming drift).
function msUntilReset(period: MeterCapPeriod, now: Date): number | null {
  try {
    const next = new Date(now);
    if (period === 'daily') {
      next.setHours(24, 0, 0, 0);                  // next local midnight
    } else if (period === 'weekly') {
      // ISO week starts Monday (Postgres date_trunc('week') = Monday). Days until the
      // NEXT Monday 00:00 — never 0 (a Monday reset already happened this morning).
      const dow = now.getDay();                    // 0=Sun..6=Sat
      const daysUntilMon = ((8 - dow) % 7) || 7;   // 1..7
      next.setHours(0, 0, 0, 0);
      next.setDate(now.getDate() + daysUntilMon);
    } else {
      next.setMonth(now.getMonth() + 1, 1);        // 1st of next month, local midnight
      next.setHours(0, 0, 0, 0);
    }
    return next.getTime() - now.getTime();
  } catch {
    return null;
  }
}

// "{N}d" only when a FULL day actually remains, else "{H}h {M}m" (or "{M}m"
// sub-hour). Audit M6 — the threshold is on RAW ms, not the ceil-rounded minutes: a
// daily reset 23h59m30s away must NOT round up to "1d" (it resets tonight, <24h).
function formatCountdown(ms: number): string {
  if (ms >= 86_400_000) {
    return `${Math.max(1, Math.round(ms / 86_400_000))}d`;
  }
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}
