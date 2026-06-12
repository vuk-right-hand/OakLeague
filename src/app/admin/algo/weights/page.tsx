import 'server-only';
import { supabaseServer } from '@/lib/supabase/server';
import { WeightsForm, type WeightRow } from './weights-form';

export const dynamic = 'force-dynamic';

export default async function AdminAlgoWeightsPage() {
  // Cookie-bound client: the RPC's SECURITY DEFINER admin guard reads
  // auth.uid(), which is NULL under supabaseAdmin().
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('admin_list_feed_algo_weights');

  const rows = (data ?? []) as WeightRow[];

  return (
    <main>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Feed Algo Weights</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 4 }}>
        Live scorer knobs. Changes apply to the next feed page load — no deploy.
        Every change writes an audit row.
      </p>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        <code>*_ANON</code> keys tune the anonymous feed only; the rest tune the
        authenticated scorer. <code>W_DIVERSITY_STEP</code> controls the
        same-creator slate interleave (0 disables).
      </p>

      {error ? (
        <p style={{ color: '#f87171', fontSize: 14 }}>
          Failed to load weights: {error.message}
        </p>
      ) : (
        <WeightsForm rows={rows} />
      )}
    </main>
  );
}
