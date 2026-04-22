import 'server-only';
import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { UserDetailClient } from './user-detail-client';

export const dynamic = 'force-dynamic';

type Profile = {
  id: string;
  handle: string | null;
  display_name: string | null;
  email: string | null;
  tier: 'free' | 'premium' | 'boardroom';
  timezone: string;
  created_at: string;
  onboarded_at: string | null;
  voice_daily_cap_seconds: number;
  voice_weekly_cap_seconds: number | null;
  voice_monthly_cap_seconds: number | null;
};

type SessionRow = {
  id: string;
  creator_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  model_used: string;
  tier_at_session: string;
  active_seconds: number;
  total_cost_usd: number;
  end_reason: string | null;
};

type Quota = {
  quota_date: string;
  tier_snapshot: string;
  daily_limit_s: number;
  seconds_used: number;
  kill_switch_fired_at: string | null;
};

type AuditRow = {
  id: string;
  admin_user_id: string;
  action: string;
  target_kind: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
};

export default async function AdminUserDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const sb = supabaseAdmin();

  const [{ data: profile }, { data: sessions }, { data: quotas }, { data: profileAudit }] = await Promise.all([
    sb.from('profiles')
      .select('id, handle, display_name, email, tier, timezone, created_at, onboarded_at, voice_daily_cap_seconds, voice_weekly_cap_seconds, voice_monthly_cap_seconds')
      .eq('id', id)
      .maybeSingle<Profile>(),
    sb.from('sessions')
      .select('id, creator_id, status, started_at, ended_at, model_used, tier_at_session, active_seconds, total_cost_usd, end_reason')
      .eq('user_id', id)
      .order('started_at', { ascending: false })
      .limit(25),
    sb.from('daily_quotas')
      .select('quota_date, tier_snapshot, daily_limit_s, seconds_used, kill_switch_fired_at')
      .eq('user_id', id)
      .order('quota_date', { ascending: false })
      .limit(7),
    sb.from('admin_audit_log')
      .select('id, admin_user_id, action, target_kind, target_id, before, after, created_at')
      .eq('target_kind', 'profile')
      .eq('target_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (!profile) notFound();

  const sessionRows = (sessions ?? []) as SessionRow[];
  const activeSessions = sessionRows.filter((s) => s.ended_at === null);
  const quotaRows = (quotas ?? []) as Quota[];

  // R5-C2: admin_force_close_session writes audit rows with target_kind='session'
  // and target_id=session_id, NOT target_id=user_id. Fetch those separately
  // for the sessions we already loaded and merge.
  const sessionIds = sessionRows.map((s) => s.id);
  const { data: sessionAudit } = sessionIds.length > 0
    ? await sb.from('admin_audit_log')
        .select('id, admin_user_id, action, target_kind, target_id, before, after, created_at')
        .eq('target_kind', 'session')
        .in('target_id', sessionIds)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: [] as AuditRow[] };

  const auditRows = [...((profileAudit ?? []) as AuditRow[]), ...((sessionAudit ?? []) as AuditRow[])]
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    .slice(0, 20);

  return (
    <main>
      <a href="/admin/users" style={{ fontSize: 13, opacity: 0.7 }}>← Users</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8, marginBottom: 4 }}>
        {profile.handle ? `@${profile.handle}` : profile.email ?? profile.id}
      </h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 24 }}>
        {profile.display_name ?? '—'} · {profile.email ?? '—'} · tz {profile.timezone}
      </div>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Tier &amp; voice caps</h2>
        <UserDetailClient
          userId={profile.id}
          currentTier={profile.tier}
          activeSessions={activeSessions.map((s) => ({ id: s.id, started_at: s.started_at, tier: s.tier_at_session, model: s.model_used }))}
          currentCaps={{
            daily: profile.voice_daily_cap_seconds,
            weekly: profile.voice_weekly_cap_seconds,
            monthly: profile.voice_monthly_cap_seconds,
          }}
        />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Daily quotas (last 7)</h2>
        {quotaRows.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>No quota rows yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">Date</th>
                <th align="left">Tier</th>
                <th align="right">Used (s)</th>
                <th align="right">Limit (s)</th>
                <th align="left">Latched?</th>
              </tr>
            </thead>
            <tbody>
              {quotaRows.map((q) => (
                <tr key={q.quota_date} style={{ borderTop: '1px solid #222' }}>
                  <td>{q.quota_date}</td>
                  <td>{q.tier_snapshot}</td>
                  <td align="right">{q.seconds_used}</td>
                  <td align="right">{q.daily_limit_s}</td>
                  <td>{q.kill_switch_fired_at ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Recent sessions (25)</h2>
        {sessionRows.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>No sessions.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">Status</th>
                <th align="left">Started</th>
                <th align="right">Active (s)</th>
                <th align="right">Cost</th>
                <th align="left">Tier</th>
                <th align="left">End reason</th>
              </tr>
            </thead>
            <tbody>
              {sessionRows.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid #222' }}>
                  <td>{s.status}</td>
                  <td style={{ opacity: 0.8 }}>{new Date(s.started_at).toLocaleString()}</td>
                  <td align="right">{s.active_seconds}</td>
                  <td align="right">${Number(s.total_cost_usd).toFixed(4)}</td>
                  <td>{s.tier_at_session}</td>
                  <td style={{ opacity: 0.7 }}>{s.end_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Audit log</h2>
        {auditRows.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>No admin actions on this profile.</p>
        ) : (
          <ul style={{ fontSize: 13, opacity: 0.85, listStyle: 'none', padding: 0 }}>
            {auditRows.map((a) => (
              <li key={a.id} style={{ borderTop: '1px solid #222', padding: '6px 0' }}>
                <span style={{ opacity: 0.7 }}>{new Date(a.created_at).toLocaleString()}</span>{' '}
                <strong>{a.action}</strong>{' '}
                <span style={{ opacity: 0.6, fontSize: 12 }}>
                  [{a.target_kind}{a.target_id ? ` ${a.target_id.slice(0, 8)}` : ''}]
                </span>{' '}
                <span style={{ opacity: 0.7 }}>by {a.admin_user_id.slice(0, 8)}</span>
                {' · '}
                <code style={{ fontSize: 12 }}>
                  {JSON.stringify(a.before)} → {JSON.stringify(a.after)}
                </code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
