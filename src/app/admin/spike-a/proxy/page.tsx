import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import ProxyClient, { type CreatorOption } from './proxy-client';

export const metadata: Metadata = {
  title: 'Spike A — Proxy TTFA',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function SpikeAProxyPage() {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) redirect('/login?next=/admin/spike-a/proxy');
    throw e;
  }

  const admin = supabaseAdmin();
  const { data: rows } = await admin
    .from('creators')
    .select('id, handle, display_name')
    .order('created_at', { ascending: true });

  const creators: CreatorOption[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    handle: r.handle as string,
    displayName: r.display_name as string,
  }));

  return <ProxyClient creators={creators} />;
}
