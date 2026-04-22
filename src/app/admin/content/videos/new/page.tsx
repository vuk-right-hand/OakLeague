import { supabaseAdmin } from '@/lib/supabase/admin';
import { NewVideoForm } from './new-video-form';

export const dynamic = 'force-dynamic';

type CreatorRow = { id: string; display_name: string; handle: string };

export default async function NewVideoPage() {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from('creators')
    .select('id, display_name, handle')
    .order('display_name', { ascending: true });
  const creators = (data ?? []) as CreatorRow[];

  return (
    <section>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 16 }}>New video</h1>
      {creators.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No creators yet — approve an application first.</p>
      ) : (
        <NewVideoForm creators={creators} />
      )}
    </section>
  );
}
