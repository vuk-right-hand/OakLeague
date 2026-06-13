import Link from 'next/link';
import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NewVideoForm } from './new-video-form';
import { VoiceRecorderCard } from '@/components/creator/VoiceRecorderCard';
import { FaceCard } from '@/components/creator/FaceCard';

export const dynamic = 'force-dynamic';

type VideoRow = {
  id: string;
  title: string;
  created_at: string;
  published_at: string | null;
  lesson_count: number;
  long_form_published_at: string | null;
};

const MAX_VIDEOS_PER_CREATOR = 20; // mirror of the server-action quota (display only)

export default async function CreatorStudioPage() {
  const { creatorId, creator } = await getCreatorForCaller();

  const sb = supabaseAdmin();
  const [{ data }, { data: identity }, { data: pendingFace }] = await Promise.all([
    sb
      .from('videos')
      .select('id, title, created_at, published_at, lesson_count, long_form_published_at')
      .eq('creator_id', creatorId)
      .order('created_at', { ascending: false })
      .limit(200),
    sb.from('creators').select('voice_id, simli_face_id').eq('id', creatorId).maybeSingle<{
      voice_id: string | null;
      simli_face_id: string | null;
    }>(),
    // Most recent in-flight face train (tab-close resume for the Face card).
    sb
      .from('face_clone_uploads')
      .select('id, vendor_face_id')
      .eq('creator_id', creatorId)
      .eq('state', 'pending')
      .not('vendor_face_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: number; vendor_face_id: string }>(),
  ]);

  const rows = (data ?? []) as VideoRow[];
  const atQuota = rows.length >= MAX_VIDEOS_PER_CREATOR;
  const published = creator.published_at != null;
  const hasVoice = identity?.voice_id != null;
  const hasFace = identity?.simli_face_id != null;

  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Studio</h1>
        <p style={{ opacity: 0.7, fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>
          Set up your voice and face, then upload your hooks and full lessons. No review
          queue — you publish on your own. {rows.length}/{MAX_VIDEOS_PER_CREATOR} videos used.
        </p>
      </div>

      <VoiceRecorderCard hasExistingVoice={hasVoice} published={published} />
      <FaceCard
        hasExistingFace={hasFace}
        published={published}
        pendingUpload={
          pendingFace ? { uploadId: pendingFace.id, vendorFaceId: pendingFace.vendor_face_id } : null
        }
      />

      <section style={card}>
        <h2 style={sectionTitle}>New video</h2>
        {atQuota ? (
          <p style={{ opacity: 0.6, marginTop: 8, fontSize: 14 }}>
            You&apos;ve reached the {MAX_VIDEOS_PER_CREATOR}-video limit. Delete or reuse an
            existing video, or contact us to raise the cap.
          </p>
        ) : (
          <div style={{ marginTop: 12 }}>
            <NewVideoForm />
          </div>
        )}
      </section>

      <section style={card}>
        <h2 style={sectionTitle}>Your videos</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((v) => (
            <li key={v.id} style={{ border: '1px solid #2a2a2a', borderRadius: 8, padding: 12 }}>
              <Link href={`/creator/studio/${v.id}`} style={{ fontWeight: 600 }}>
                {v.title}
              </Link>
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                {v.published_at
                  ? `Published ${new Date(v.published_at).toLocaleDateString()}`
                  : 'Draft'}
                {' · '}
                {v.lesson_count} {v.lesson_count === 1 ? 'lesson' : 'lessons'}
                {v.long_form_published_at && ' · full lesson live'}
              </div>
            </li>
          ))}
          {rows.length === 0 && (
            <li style={{ opacity: 0.6, fontSize: 14 }}>No videos yet. Create your first above.</li>
          )}
        </ul>
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
