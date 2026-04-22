import 'server-only';
import { CogsDashboard } from './cogs-dashboard';

export const dynamic = 'force-dynamic';

export default function AdminCogsPage() {
  return (
    <main>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>COGS</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Rollup materialized view refreshes every 60s (pg_cron <code>cogs_rollup_refresh</code>).
        Dashboard polls every 30s. Kill-switch fires at 150% of user quota — see voice RPCs.
      </p>
      <CogsDashboard />
    </main>
  );
}
