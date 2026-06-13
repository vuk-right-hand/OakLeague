import { notFound } from 'next/navigation';
import { cache } from 'react';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';

const cachedAssert = cache(async () => {
  try {
    return await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return null;
    throw e;
  }
});

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await cachedAssert();
  if (!admin) notFound();
  return (
    <div style={{ maxWidth: 960, margin: '4vh auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <strong>OakLeague Admin</strong>
        <nav style={{ display: 'flex', gap: 16, fontSize: 14, flexWrap: 'wrap' }}>
          <a href="/admin/cogs">COGS</a>
          <a href="/admin/users">Users</a>
          <a href="/admin/algo">Algo</a>
          <a href="/admin/creators">Creators</a>
          <a href="/admin/requests">Requests</a>
          <a href="/admin/invites/new">New invite</a>
          <a href="/admin/applications">Applications</a>
          <a href="/admin/content/videos">Videos</a>
          <a href="/admin/content/welcome">Welcome</a>
          <a href="/admin/content/reports">Reports</a>
        </nav>
      </header>
      {children}
    </div>
  );
}
