'use client';

import { useState, useTransition } from 'react';

type Tier = 'free' | 'premium' | 'boardroom';
type ActiveSession = { id: string; started_at: string; tier: string; model: string };

type Props = {
  userId: string;
  currentTier: Tier;
  activeSessions: ActiveSession[];
};

const ERROR_COPY: Record<string, string> = {
  has_active_session: 'This user has an active session. Force-close it first, then retry.',
  downgrade_blocked_until_tomorrow: 'Downgrade blocked: user has logged seconds today. Retry after midnight in their timezone.',
  unauthenticated: 'Your admin session expired. Reload the page and sign in again.',
  forbidden: 'You don’t have permission to perform this action.',
  bad_reason: 'Reason is required (1–180 chars).',
  bad_session_id: 'Malformed session id.',
  not_found_or_dead: 'Session already closed or not found.',
};

function errorLabel(code: string | null): string | null {
  if (!code) return null;
  return ERROR_COPY[code] ?? `Error: ${code}`;
}

export function UserDetailClient({ userId, currentTier, activeSessions }: Props) {
  const [selectedTier, setSelectedTier] = useState<Tier>(currentTier);
  const [tierErr, setTierErr] = useState<string | null>(null);
  const [tierOk, setTierOk] = useState(false);
  const [tierPending, startTier] = useTransition();

  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [fcErr, setFcErr] = useState<Record<string, string | null>>({});
  const [fcOk, setFcOk] = useState<Record<string, boolean>>({});
  const [fcPending, startFc] = useTransition();

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
    </div>
  );
}
