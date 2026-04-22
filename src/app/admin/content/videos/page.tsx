import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type VideoRow = {
  id: string;
  title: string;
  creator_id: string;
  created_at: string;
  published_at: string | null;
  lesson_count: number;
};

export default async function VideosListPage() {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from('videos')
    .select('id, title, creator_id, created_at, published_at, lesson_count')
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = (data ?? []) as VideoRow[];

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Videos</h1>
        <Link href="/admin/content/videos/new" style={{ fontSize: 14 }}>
          + New video
        </Link>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((v) => (
          <li key={v.id} style={{ border: '1px solid #2a2a2a', borderRadius: 8, padding: 12 }}>
            <Link href={`/admin/content/videos/${v.id}`} style={{ fontWeight: 600 }}>
              {v.title}
            </Link>
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
              {v.published_at ? `Published ${new Date(v.published_at).toLocaleDateString()}` : 'Draft'}
              {' · '}
              {v.lesson_count} lessons
            </div>
          </li>
        ))}
        {rows.length === 0 && <li style={{ opacity: 0.6 }}>No videos yet.</li>}
      </ul>
    </section>
  );
}
