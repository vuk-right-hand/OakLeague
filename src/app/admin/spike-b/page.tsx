import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import SpikeBClient from './spike-b-client';

export const metadata: Metadata = {
  title: 'Spike B — Avatar Provider Harness',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function SpikeBPage() {
  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) redirect('/login?next=/admin/spike-b');
    throw e;
  }

  const simliReplica = process.env.SIMLI_REPLICA_ID ?? '';
  const tavusReplica = process.env.TAVUS_REPLICA_ID ?? '';

  return <SpikeBClient simliReplicaId={simliReplica} tavusReplicaId={tavusReplica} />;
}
