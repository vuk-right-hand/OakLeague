import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadReconcile, type ReconcileReport } from '@/lib/minutes/reconcile';

// /admin/minutes — Phase-7 COGS reconciliation viewer. Read-only. Admin access
// is enforced by the /admin layout (assertAdminFromSession → notFound), so this
// server component loads with the service-role client directly.

export const dynamic = 'force-dynamic';

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function fmtMin(seconds: number): string {
  return `${(seconds / 60).toFixed(1)} min`;
}
function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export default async function AdminMinutesPage() {
  const until = new Date();
  const since = new Date(until.getTime() - WINDOW_MS);
  const floorEnv = process.env.MINUTES_WELCOME_GAP_FLOOR;
  const welcomeFloor =
    floorEnv && !Number.isNaN(new Date(floorEnv).getTime()) ? new Date(floorEnv).toISOString() : null;

  let report: ReconcileReport | null = null;
  let error: string | null = null;
  try {
    report = await loadReconcile(supabaseAdmin(), {
      since: since.toISOString(),
      until: until.toISOString(),
      welcomeFloor,
      violationLimit: 200,
    });
  } catch (e) {
    error = (e as Error).message;
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: 13 };
  const card: React.CSSProperties = {
    border: '1px solid #e5e5e5', borderRadius: 8, padding: 16, minWidth: 200, flex: '1 1 220px',
  };
  const kpi: React.CSSProperties = { fontSize: 22, fontWeight: 700 };
  const lbl: React.CSSProperties = { fontSize: 12, opacity: 0.6, marginBottom: 4 };

  return (
    <main>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Minutes &amp; Wallet Reconcile</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Read-only. <strong>Flows</strong> (granted / consumed / billed) cover the last 30 days;{' '}
        <strong>stocks</strong> and <strong>invariant violations</strong> are live (point-in-time). Actual
        COGS is production-only. The <strong>implied $</strong> (minutes × pinned blended rate) is a sanity
        estimate, <em>not</em> an exact match to billed — read it as a ratio (a stale rate or leak shows as a
        large divergence). Consumed is bucketed by the user&rsquo;s local day, so this 30-day view carries
        ±1-day edge noise; run <code>scripts/minutes-reconcile.mjs</code> all-time for an exact reconcile.
        Paid-tier (monthly-allowance) consumption has no wallet grant and is reconciled in Phase 6.
      </p>

      {error && (
        <div style={{ ...card, borderColor: '#f5c2c7', background: '#fff5f5', marginBottom: 16 }}>
          <strong>reconcile failed:</strong> {error.slice(0, 200)}
        </div>
      )}

      {report && (
        <>
          {/* Violations banner — the headline integrity signal. */}
          <div
            style={{
              ...card,
              marginBottom: 16,
              borderColor: report.violations.total > 0 ? '#f5c2c7' : '#badbcc',
              background: report.violations.total > 0 ? '#fff5f5' : '#f1fcf4',
            }}
          >
            <div style={lbl}>Invariant violations</div>
            <div style={kpi}>{report.violations.total === 0 ? '✓ none' : `⚠ ${report.violations.total}`}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              wallet_mismatch {report.violations.wallet_mismatch_count} · overspent{' '}
              {report.violations.overspent_count} · welcome_gap {report.violations.welcome_gap_count}
              {welcomeFloor == null && ' (welcome_gap suppressed — no MINUTES_WELCOME_GAP_FLOOR set)'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={card}>
              <div style={lbl}>Wallet active (live)</div>
              <div style={kpi}>{fmtMin(report.stocks.wallet_active_seconds)}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>
                spent {fmtMin(report.stocks.wallet_spent_seconds)} · remaining{' '}
                {fmtMin(report.stocks.wallet_remaining_seconds)}
              </div>
            </div>
            <div style={card}>
              <div style={lbl}>Granted (30d)</div>
              <div style={kpi}>{fmtMin(report.flows.granted_seconds)}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>
                {Object.keys(report.flows.granted_by_type).length === 0
                  ? '—'
                  : Object.entries(report.flows.granted_by_type)
                      .map(([k, v]) => `${k} ${fmtMin(v)}`)
                      .join(' · ')}
              </div>
            </div>
            <div style={card}>
              <div style={lbl}>Consumed (30d)</div>
              <div style={kpi}>{fmtMin(report.flows.consumed_seconds)}</div>
            </div>
            <div style={card}>
              <div style={lbl}>
                Voice COGS — implied vs actual{' '}
                {!report.cogs.blended_rate_configured && (
                  <span style={{ color: '#b54708' }}>(rate = seed fallback)</span>
                )}
              </div>
              <div style={kpi}>{fmtUsd(report.cogs.actual_voice_usd)}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>
                actual · implied(granted) {fmtUsd(report.cogs.implied_usd_from_granted)} · implied(consumed){' '}
                {fmtUsd(report.cogs.implied_usd_from_consumed)}
                <br />
                rate {fmtUsd(report.cogs.blended_rate_usd_per_min)}/min
                {report.cogs.blended_rate_quoted_at ? ` (quoted ${report.cogs.blended_rate_quoted_at})` : ''}
              </div>
            </div>
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 600, margin: '8px 0' }}>
            Offenders {report.violations.offenders.length > 0 && `(${report.violations.offenders.length})`}
          </h2>
          {/* M5: the offenders list is capped (200); the counts are not — show the cap. */}
          {report.violations.offenders.length < report.violations.total && (
            <p style={{ fontSize: 12, color: '#b54708', margin: '0 0 8px' }}>
              Showing the first {report.violations.offenders.length} of {report.violations.total} — run the CLI
              for the full list.
            </p>
          )}
          {/* M3: welcome_gap only fires above the floor; set it correctly to avoid noise. */}
          {report.violations.welcome_gap_count > 0 && (
            <p style={{ fontSize: 12, opacity: 0.6, margin: '0 0 8px' }}>
              welcome_gap uses <code>MINUTES_WELCOME_GAP_FLOOR</code> — set it to the signup-bonus{' '}
              <em>go-live</em> timestamp (not the Growth launch) so pre-feature users aren&rsquo;t flagged.
            </p>
          )}
          {report.violations.offenders.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.6 }}>No invariant violations. Ledger reconciles.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>violation</th>
                  <th style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>user_id</th>
                  <th style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>detail</th>
                </tr>
              </thead>
              <tbody>
                {report.violations.offenders.map((o) => (
                  <tr key={`${o.violation}:${o.user_id}`}>
                    <td style={cell}>{o.violation}</td>
                    <td style={{ ...cell, fontFamily: 'monospace' }}>{o.user_id}</td>
                    <td style={cell}>{o.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
