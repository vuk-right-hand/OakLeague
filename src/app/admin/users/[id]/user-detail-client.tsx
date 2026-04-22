'use client';

import { useState, useTransition } from 'react';

type Tier = 'free' | 'premium' | 'boardroom';
type ActiveSession = { id: string; started_at: string; tier: string; model: string };
type Caps = { daily: number; weekly: number | null; monthly: number | null };

type Props = {
  userId: string;
  currentTier: Tier;
  activeSessions: ActiveSession[];
  currentCaps: Caps;
};

const ERROR_COPY: Record<string, string> = {
  has_active_session: 'This user has an active session. Force-close it first, then retry.',
  downgrade_blocked_until_tomorrow: 'Downgrade blocked: user has logged seconds today. Retry after midnight in their timezone.',
  unauthenticated: 'Your admin session expired. Reload the page and sign in again.',
  forbidden: 'You don’t have permission to perform this action.',
  bad_reason: 'Reason is required (1–180 chars).',
  bad_session_id: 'Malformed session id.',
  not_found_or_dead: 'Session already closed or not found.',
  bad_daily_cap: 'Daily cap must be an integer between 1 and 86400 seconds (24h).',
  bad_weekly_cap: 'Weekly cap must be empty (disabled) or an integer 1–604800 seconds (7d).',
  bad_monthly_cap: 'Monthly cap must be empty (unlimited) or an integer 1–2678400 seconds (31d).',
  out_of_range: 'Cap value out of range.',
};

// DAILY_MIN = 1: zero would silently block every session at ticket-mint with a
// generic quota error. Block at UI — use tier downgrade to deny access.
const DAILY_MIN = 1;
const DAILY_MAX = 86400;
const WEEKLY_MIN = 1;
const WEEKLY_MAX = 604800;
const MONTHLY_MIN = 1;
const MONTHLY_MAX = 2678400;

function errorLabel(code: string | null): string | null {
  if (!code) return null;
  return ERROR_COPY[code] ?? `Error: ${code}`;
}

export function UserDetailClient({ userId, currentTier, activeSessions, currentCaps }: Props) {
  const [selectedTier, setSelectedTier] = useState<Tier>(currentTier);
  const [tierErr, setTierErr] = useState<string | null>(null);
  const [tierOk, setTierOk] = useState(false);
  const [tierPending, startTier] = useTransition();

  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [fcErr, setFcErr] = useState<Record<string, string | null>>({});
  const [fcOk, setFcOk] = useState<Record<string, boolean>>({});
  const [fcPending, startFc] = useTransition();

  // Voice caps. Weekly/monthly are nullable — empty string in the input = NULL = disabled/unlimited.
  const [dailyStr, setDailyStr] = useState<string>(String(currentCaps.daily));
  const [weeklyStr, setWeeklyStr] = useState<string>(currentCaps.weekly === null ? '' : String(currentCaps.weekly));
  const [monthlyStr, setMonthlyStr] = useState<string>(currentCaps.monthly === null ? '' : String(currentCaps.monthly));
  const [capsErr, setCapsErr] = useState<string | null>(null);
  const [capsOk, setCapsOk] = useState(false);
  const [capsPending, startCaps] = useTransition();

  function parseCap(s: string, allowNull: boolean): number | null | 'bad' {
    const t = s.trim();
    if (t === '') return allowNull ? null : 'bad';
    if (!/^\d+$/.test(t)) return 'bad';
    const n = Number(t);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 'bad';
    return n;
  }

  const dailyParsed = parseCap(dailyStr, false);
  const weeklyParsed = parseCap(weeklyStr, true);
  const monthlyParsed = parseCap(monthlyStr, true);

  const dailyFieldErr: string | null =
    dailyParsed === 'bad' || dailyParsed === null
      ? 'Required integer.'
      : dailyParsed < DAILY_MIN
        ? 'Must be ≥1 — use tier downgrade to block access.'
        : dailyParsed > DAILY_MAX
          ? `Max ${DAILY_MAX} (24h).`
          : null;
  const weeklyFieldErr: string | null =
    weeklyParsed === 'bad'
      ? 'Integer or blank.'
      : typeof weeklyParsed === 'number' && weeklyParsed < WEEKLY_MIN
        ? 'Must be ≥1 or blank.'
        : typeof weeklyParsed === 'number' && weeklyParsed > WEEKLY_MAX
          ? `Max ${WEEKLY_MAX} (7d).`
          : null;
  const monthlyFieldErr: string | null =
    monthlyParsed === 'bad'
      ? 'Integer or blank.'
      : typeof monthlyParsed === 'number' && monthlyParsed < MONTHLY_MIN
        ? 'Must be ≥1 or blank.'
        : typeof monthlyParsed === 'number' && monthlyParsed > MONTHLY_MAX
          ? `Max ${MONTHLY_MAX} (31d).`
          : null;

  const capsInvalid = Boolean(dailyFieldErr || weeklyFieldErr || monthlyFieldErr);
  const capsUnchanged =
    dailyParsed === currentCaps.daily &&
    weeklyParsed === currentCaps.weekly &&
    monthlyParsed === currentCaps.monthly;

  return (
    <div>
      {activeSessions.length > 0 && (
        <div style={{
          padding: 12,
          marginBottom: 16,
          background: 'rgba(255, 180, 0, 0.1)',
          border: '1px solid rgba(255, 180, 0, 0.35)',
          borderRadius: 8,
          fontSize: 13,
        }}>
          <strong>{activeSessions.length} active session{activeSessions.length === 1 ? '' : 's'}.</strong>{' '}
          Tier flip is blocked until all are closed.
          <ul style={{ marginTop: 8, paddingLeft: 18 }}>
            {activeSessions.map((s) => (
              <li key={s.id} style={{ marginBottom: 8 }}>
                <code style={{ fontSize: 12 }}>{s.id.slice(0, 8)}</code>{' '}
                · started {new Date(s.started_at).toLocaleTimeString()}
                {' · '}{s.tier} / {s.model}
                <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    placeholder="Reason (required, ≤180 chars)"
                    maxLength={180}
                    value={reasons[s.id] ?? ''}
                    onChange={(e) => setReasons({ ...reasons, [s.id]: e.target.value })}
                    disabled={fcPending}
                    style={{
                      padding: '4px 8px',
                      fontSize: 12,
                      background: '#111',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.25)',
                      borderRadius: 4,
                      width: 260,
                    }}
                  />
                  <button
                    type="button"
                    disabled={fcPending || !(reasons[s.id] ?? '').trim()}
                    onClick={() => {
                      const reason = (reasons[s.id] ?? '').trim();
                      setFcErr({ ...fcErr, [s.id]: null });
                      setFcOk({ ...fcOk, [s.id]: false });
                      startFc(async () => {
                        try {
                          const r = await fetch('/api/admin/sessions/force-close', {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ session_id: s.id, reason }),
                          });
                          if (!r.ok) {
                            const b = await r.json().catch(() => ({}));
                            setFcErr({ ...fcErr, [s.id]: (b?.error as string) ?? `error_${r.status}` });
                            return;
                          }
                          setFcOk({ ...fcOk, [s.id]: true });
                          // Let the row disappear on next hard refresh.
                          setTimeout(() => window.location.reload(), 600);
                        } catch {
                          setFcErr({ ...fcErr, [s.id]: 'network' });
                        }
                      });
                    }}
                    style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4 }}
                  >
                    {fcPending ? '…' : 'Force close'}
                  </button>
                  {fcErr[s.id] && <span style={{ color: 'salmon', fontSize: 12 }}>{errorLabel(fcErr[s.id]!)}</span>}
                  {fcOk[s.id] && <span style={{ color: 'lightgreen', fontSize: 12 }}>Closed</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, opacity: 0.7 }}>Current: <strong>{currentTier}</strong></span>
        <span style={{ fontSize: 13, opacity: 0.5 }}>→</span>
        <select
          value={selectedTier}
          onChange={(e) => setSelectedTier(e.target.value as Tier)}
          disabled={tierPending || activeSessions.length > 0}
          style={{ padding: '4px 8px', fontSize: 14, background: '#111', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6 }}
        >
          <option value="free">free</option>
          <option value="premium">premium</option>
          <option value="boardroom">boardroom</option>
        </select>
        <button
          type="button"
          disabled={tierPending || selectedTier === currentTier || activeSessions.length > 0}
          onClick={() => {
            setTierErr(null);
            setTierOk(false);
            startTier(async () => {
              try {
                const r = await fetch('/api/admin/users/tier', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ target_user_id: userId, new_tier: selectedTier }),
                });
                if (!r.ok) {
                  const b = await r.json().catch(() => ({}));
                  setTierErr((b?.error as string) ?? `error_${r.status}`);
                  return;
                }
                setTierOk(true);
                setTimeout(() => window.location.reload(), 600);
              } catch {
                setTierErr('network');
              }
            });
          }}
          style={{ padding: '4px 12px', fontSize: 13, borderRadius: 6 }}
        >
          {tierPending ? '…' : 'Apply'}
        </button>
        {tierOk && <span style={{ color: 'lightgreen', fontSize: 12 }}>Applied</span>}
        {tierErr && <span style={{ color: 'salmon', fontSize: 12 }}>{errorLabel(tierErr)}</span>}
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>
          Voice caps (seconds). Weekly blank = disabled. Monthly blank = unlimited. Applies at next ticket mint, never mid-session.
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, opacity: 0.8 }}>
            Daily ({DAILY_MIN}–{DAILY_MAX})
            <input
              type="text"
              inputMode="numeric"
              value={dailyStr}
              onChange={(e) => setDailyStr(e.target.value)}
              disabled={capsPending}
              aria-invalid={dailyFieldErr ? 'true' : 'false'}
              style={{ padding: '4px 8px', fontSize: 13, background: '#111', color: '#fff', border: `1px solid ${dailyFieldErr ? 'salmon' : 'rgba(255,255,255,0.25)'}`, borderRadius: 4, width: 120 }}
            />
            <span style={{ fontSize: 11, color: 'salmon', minHeight: 14, marginTop: 2 }}>{dailyFieldErr ?? ''}</span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, opacity: 0.8 }}>
            Weekly ({WEEKLY_MIN}–{WEEKLY_MAX}, blank = off)
            <input
              type="text"
              inputMode="numeric"
              value={weeklyStr}
              onChange={(e) => setWeeklyStr(e.target.value)}
              disabled={capsPending}
              aria-invalid={weeklyFieldErr ? 'true' : 'false'}
              style={{ padding: '4px 8px', fontSize: 13, background: '#111', color: '#fff', border: `1px solid ${weeklyFieldErr ? 'salmon' : 'rgba(255,255,255,0.25)'}`, borderRadius: 4, width: 140 }}
            />
            <span style={{ fontSize: 11, color: 'salmon', minHeight: 14, marginTop: 2 }}>{weeklyFieldErr ?? ''}</span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, opacity: 0.8 }}>
            Monthly ({MONTHLY_MIN}–{MONTHLY_MAX}, blank = unlimited)
            <input
              type="text"
              inputMode="numeric"
              value={monthlyStr}
              onChange={(e) => setMonthlyStr(e.target.value)}
              disabled={capsPending}
              aria-invalid={monthlyFieldErr ? 'true' : 'false'}
              style={{ padding: '4px 8px', fontSize: 13, background: '#111', color: '#fff', border: `1px solid ${monthlyFieldErr ? 'salmon' : 'rgba(255,255,255,0.25)'}`, borderRadius: 4, width: 160 }}
            />
            <span style={{ fontSize: 11, color: 'salmon', minHeight: 14, marginTop: 2 }}>{monthlyFieldErr ?? ''}</span>
          </label>
          <button
            type="button"
            disabled={capsPending || capsInvalid || capsUnchanged}
            onClick={() => {
              setCapsErr(null);
              setCapsOk(false);
              startCaps(async () => {
                try {
                  const r = await fetch('/api/admin/users/voice-caps', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      target_user_id: userId,
                      voice_daily_cap_seconds: dailyParsed,
                      voice_weekly_cap_seconds: weeklyParsed,
                      voice_monthly_cap_seconds: monthlyParsed,
                    }),
                  });
                  if (!r.ok) {
                    const b = await r.json().catch(() => ({}));
                    setCapsErr((b?.error as string) ?? `error_${r.status}`);
                    return;
                  }
                  setCapsOk(true);
                  setTimeout(() => window.location.reload(), 600);
                } catch {
                  setCapsErr('network');
                }
              });
            }}
            style={{ padding: '4px 12px', fontSize: 13, borderRadius: 6 }}
          >
            {capsPending ? '…' : 'Save caps'}
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 18 }}>
            {capsOk && <span style={{ color: 'lightgreen', fontSize: 12 }}>Saved</span>}
            {capsErr && <span style={{ color: 'salmon', fontSize: 12 }}>{errorLabel(capsErr)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
