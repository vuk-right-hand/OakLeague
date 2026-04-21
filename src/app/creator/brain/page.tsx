import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { CreatorTopicRow, SampleContentRow } from '@/lib/creator/types';
import { AddTopicForm, TopicAccordion } from './brain-ui';

export const dynamic = 'force-dynamic';

export default async function CreatorBrainPage() {
  const { creatorId } = await getCreatorForCaller();

  const sb = supabaseAdmin();
  const [{ data: topicsRaw }, { data: samplesRaw }] = await Promise.all([
    sb
      .from('creator_topics')
      .select('id, creator_id, slug, title, description, sort_order, created_at')
      .eq('creator_id', creatorId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
    sb
      .from('sample_content')
      .select('id, creator_id, source_type, title, source_url, raw_text, topic_tags, fetch_status, created_at')
      .eq('creator_id', creatorId)
      .order('created_at', { ascending: false }),
  ]);

  const topics = (topicsRaw ?? []) as CreatorTopicRow[];
  const samples = (samplesRaw ?? []) as SampleContentRow[];

  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Knowledge</h1>

      {topics.length === 0 ? (
        <section
          style={{
            padding: 24,
            border: '1px dashed #333',
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <p style={{ margin: 0, fontSize: 15 }}>
            Add your first topic to get started. Each topic is a drawer of knowledge your AI twin
            will draw from — up to 5 per creator.
          </p>
          <AddTopicForm />
        </section>
      ) : (
        <>
          <AddTopicForm
            disabled={topics.length >= 5}
            disabledReason={topics.length >= 5 ? 'Maximum of 5 topics reached.' : undefined}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {topics.map((t) => (
              <TopicAccordion
                key={t.id}
                topic={t}
                samples={samples.filter((s) => s.topic_tags.includes(t.slug))}
                allTopics={topics}
              />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
