import 'server-only';
import { notFound } from 'next/navigation';
import { randomUUID } from 'crypto';
import { supabaseServer } from '@/lib/supabase/server';
import { ExplainForm } from './explain-form';

export const dynamic = 'force-dynamic';

type Summary = {
  profile: {
    id: string;
    handle: string | null;
    display_name: string | null;
    tier: 'free' | 'premium' | 'boardroom';
    timezone: string;
    created_at: string;
    interest_slugs: string[];
    feed_regime: 'A' | 'B' | 'C' | 'D';
    goals: string[] | null;
    obstacles: string[] | null;
  };
  engagement_depth: number;
  events_30d: { total: number; by_event: Record<string, number> };
  user_topic_max: number;
  user_creator_max: number;
};

type TopTopic = {
  topic_slug: string;
  affinity_score: number;
  impressions: number;
  mic_taps: number;
  full_opens: number;
  completions: number;
  negatives: number;
  last_event_at: string;
  sign: 'positive' | 'neutral' | 'negative';
};

type TopCreator = {
  creator_id: string;
  handle: string;
  display_name: string | null;
  creator_type: 'human' | 'brand' | 'sponsored_segment';
  is_published: boolean;
  affinity_score: number;
  impressions: number;
  full_opens: number;
  mic_taps: number;
  total_session_seconds: number;
  last_event_at: string;
};

type Funnel = {
  window_days: number;
  impressions: number;
  dwell_ge_80: number;
  full_video_open: number;
  mic_tap: number;
  session_opened: number;
  rates: Record<string, number | null>;
};

type RecentEvent = {
  id: number;
  created_at: string;
  event_name: string;
  hook_id: string | null;
  video_id: string | null;
  creator_id: string | null;
  session_id: string | null;
  payload_safe: Record<string, unknown>;
  skipped_reason: string | null;
};

export default async function AdminAlgoUserPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const sessionCorrelationId = randomUUID();

  const sb = await supabaseServer();

  // Audit-log call swallows its own errors so a transient INSERT failure
  // doesn't break the page. The 5 read RPCs are the load-bearing ones.
  const logPromise: Promise<null> = (async () => {
    try {
      await sb.rpc('admin_algo_log_inspector_view', {
        p_user_id: userId,
        p_session_correlation_id: sessionCorrelationId,
      });
    } catch {
      // intentionally swallowed
    }
    return null;
  })();

  const [, summaryResp, topicsResp, creatorsResp, funnelResp, eventsResp] = await Promise.all([
    logPromise,
    sb.rpc('admin_algo_user_summary', { p_user_id: userId }),
    sb.rpc('admin_algo_top_topics',   { p_user_id: userId, p_limit: 5 }),
    sb.rpc('admin_algo_top_creators', { p_user_id: userId, p_limit: 5 }),
    sb.rpc('admin_algo_funnel_7d',    { p_user_id: userId }),
    sb.rpc('admin_algo_recent_events',{ p_user_id: userId, p_limit: 50 }),
  ]);

  if (summaryResp.error || !summaryResp.data) notFound();

  const summary  = summaryResp.data as Summary;
  const topics   = (topicsResp.data   ?? []) as TopTopic[];
  const creators = (creatorsResp.data ?? []) as TopCreator[];
  const funnel   = (funnelResp.data   ?? null) as Funnel | null;
  const events   = (eventsResp.data   ?? []) as RecentEvent[];
  const p = summary.profile;

  return (
    <main>
      <a href="/admin/algo" style={{ fontSize: 13, opacity: 0.7 }}>← Algo</a>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8, marginBottom: 4 }}>
        {p.handle ? `@${p.handle}` : p.id}
      </h1>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 24 }}>
        {p.display_name ?? '—'} · tier {p.tier} · tz {p.timezone}
        {' · '}regime <code>{p.feed_regime}</code>
        {' · '}engagement_depth <strong>{summary.engagement_depth}</strong>
        {' · '}30d events <strong>{summary.events_30d.total}</strong>
      </div>

      {p.interest_slugs.length > 0 && (
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 24 }}>
          interest_slugs: {p.interest_slugs.map((s) => (
            <code key={s} style={{ marginRight: 8 }}>{s}</code>
          ))}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 32 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            Top topics <span style={{ opacity: 0.5, fontWeight: 400 }}>(max {summary.user_topic_max.toFixed(1)})</span>
          </h2>
          {topics.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.6 }}>No affinity yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {topics.map((t) => (
                  <tr key={t.topic_slug} style={{ borderTop: '1px solid #222' }}>
                    <td><code style={{ fontSize: 12 }}>{t.topic_slug}</code></td>
                    <td align="right" style={{
                      color: t.sign === 'negative' ? 'salmon' : t.sign === 'positive' ? 'lightgreen' : 'inherit',
                    }}>
                      {t.affinity_score >= 0 ? '+' : ''}{t.affinity_score.toFixed(2)}
                    </td>
                    <td align="right" style={{ opacity: 0.6, fontSize: 11 }}>
                      {t.sign === 'negative' ? '◀ neg' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            Top creators <span style={{ opacity: 0.5, fontWeight: 400 }}>(max {summary.user_creator_max.toFixed(1)})</span>
          </h2>
          {creators.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.6 }}>No creator affinity yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {creators.map((c) => (
                  <tr key={c.creator_id} style={{ borderTop: '1px solid #222' }}>
                    <td>
                      @{c.handle}
                      {c.creator_type !== 'human' && (
                        <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>
                          ({c.creator_type})
                        </span>
                      )}
                      {!c.is_published && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'salmon' }}>
                          unpublished
                        </span>
                      )}
                    </td>
                    <td align="right">+{c.affinity_score.toFixed(2)}</td>
                    <td align="right" style={{ opacity: 0.6, fontSize: 11 }}>
                      {c.total_session_seconds}s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Funnel (last {funnel?.window_days ?? 7}d)
        </h2>
        {funnel == null ? (
          <p style={{ fontSize: 13, opacity: 0.6 }}>No funnel data.</p>
        ) : (
          <div style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 8 }}>
              impressions <strong>{funnel.impressions}</strong>
              {' → '}dwell≥0.8 <strong>{funnel.dwell_ge_80}</strong>
              {' → '}full_open <strong>{funnel.full_video_open}</strong>
              {' → '}mic_tap <strong>{funnel.mic_tap}</strong>
              {' → '}session <strong>{funnel.session_opened}</strong>
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {Object.entries(funnel.rates).map(([k, v]) => (
                <span key={k} style={{ marginRight: 16 }}>
                  <code>{k}</code> {v == null ? '—' : `${(v * 100).toFixed(1)}%`}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Why this hook?</h2>
        <ExplainForm
          pUserId={userId}
          sessionCorrelationId={sessionCorrelationId}
        />
      </section>

      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Last 50 feed events
        </h2>
        {events.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.6 }}>No events.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th align="left">When</th>
                <th align="left">Event</th>
                <th align="left">Hook</th>
                <th align="left">Payload</th>
                <th align="left">Skip</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} style={{ borderTop: '1px solid #222' }}>
                  <td style={{ opacity: 0.7 }}>{new Date(e.created_at).toLocaleString()}</td>
                  <td><code>{e.event_name}</code></td>
                  <td style={{ opacity: 0.7 }}>{e.hook_id ? e.hook_id.slice(0, 8) : '—'}</td>
                  <td style={{ opacity: 0.8, fontFamily: 'monospace', fontSize: 11 }}>
                    {Object.keys(e.payload_safe).length === 0
                      ? '—'
                      : JSON.stringify(e.payload_safe)}
                  </td>
                  <td style={{ opacity: 0.6 }}>{e.skipped_reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
