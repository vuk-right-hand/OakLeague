import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; sent?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (data.user) {
    redirect(safeNext(sp.next));
  }
  return (
    <main style={{ maxWidth: 420, margin: '8vh auto', padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Sign in to OakLeague</h1>
      <LoginForm next={safeNext(sp.next)} error={sp.error} sent={sp.sent === '1'} />
    </main>
  );
}

function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}
