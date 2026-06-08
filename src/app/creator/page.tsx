import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { BrainStatusBadge } from '@/components/creator/BrainStatusBadge';
import { DeepBrainPanel } from '@/components/creator/DeepBrainPanel';
import type { CreatorTopicRow } from '@/lib/creator/types';

export const dynamic = 'force-dynamic';

export default async function CreatorDashboardPage() {
  const { creatorId, creator } = await getCreatorForCaller();

  const sb = supabaseAdmin();
  const { data: topicsRaw } = await sb
    .from('creator_topics')
    .select('id, creator_id, slug, title, description, sort_order, created_at')
    .eq('creator_id', creatorId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  const topics = (topicsRaw ?? []) as CreatorTopicRow[];
  const bio = creator.bio ?? '';
  const bioTruncated = bio.length > 300 ? bio.slice(0, 300).trimEnd() + '…' : bio;

  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Avatar url={creator.avatar_url} displayName={creator.display_name} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>{creator.display_name}</h1>
          <span style={{ opacity: 0.7, fontSize: 14 }}>@{creator.handle}</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <PublishChip publishedAt={creator.published_at} />
          <BrainStatusBadge initialStatus={creator.brain_status} />
        </div>
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>Knowledge topics</h2>
        {topics.length === 0 ? (
          <p style={{ opacity: 0.7, marginTop: 8 }}>
            No topics yet. <a href="/creator/brain">Add your first topic →</a>
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {topics.map((t) => (
                <span key={t.id} style={chip}>
                  {t.title}
                </span>
              ))}
            </div>
            <a href="/creator/brain" style={{ display: 'inline-block', marginTop: 12, fontSize: 14 }}>
              Manage knowledge →
            </a>
          </>
        )}
      </section>

      <DeepBrainPanel
        initialRetrievalVersion={creator.retrieval_version}
        brainStatus={creator.brain_status}
      />

      <section style={card}>
        <h2 style={sectionTitle}>Voice playback</h2>
        <p style={{ marginTop: 8, opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>
          Dial how fast your cloned voice plays back to people who tap to ask you a question.
        </p>
        <a href="/creator/voice" style={{ display: 'inline-block', marginTop: 12, fontSize: 14 }}>
          Adjust voice speed →
        </a>
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>Profile</h2>
        {bio ? (
          <p style={{ marginTop: 8, lineHeight: 1.5 }}>{bioTruncated}</p>
        ) : (
          <p style={{ marginTop: 8, opacity: 0.6 }}>No bio yet.</p>
        )}
      </section>
    </main>
  );
}

const card: React.CSSProperties = {
  padding: 16,
  border: '1px solid #222',
  borderRadius: 8,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  margin: 0,
};

const chip: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 999,
  background: '#1c1c1c',
  border: '1px solid #2a2a2a',
  fontSize: 13,
};

function Avatar({ url, displayName }: { url: string | null; displayName: string }) {
  const initials = displayName
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={56} height={56} style={{ borderRadius: '50%', objectFit: 'cover' }} />;
  }
  return (
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: '#1c1c1c',
        border: '1px solid #2a2a2a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
      }}
    >
      {initials || '?'}
    </div>
  );
}

function PublishChip({ publishedAt }: { publishedAt: string | null }) {
  const live = publishedAt !== null;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        background: live ? '#103a1e' : '#222',
        color: live ? '#4ad07a' : '#999',
      }}
    >
      {live ? 'Live' : 'Not published'}
    </span>
  );
}
