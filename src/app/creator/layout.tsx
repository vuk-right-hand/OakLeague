import { redirect } from 'next/navigation';
import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { AuthGuardError } from '@/lib/auth-guards';

// Creator-surface uses redirect() (login prompt for unauth users).
// Admin uses notFound() (hides admin existence). Both intentional.

export default async function CreatorLayout({ children }: { children: React.ReactNode }) {
  try {
    await getCreatorForCaller();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      if (e.status === 401) redirect('/login');
      if (e.status === 403) redirect('/');
    }
    throw e;
  }

  return (
    <div style={{ maxWidth: 960, margin: '4vh auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <strong>OakLeague Creator</strong>
        <nav style={{ display: 'flex', gap: 16, fontSize: 14 }}>
          <a href="/creator">Dashboard</a>
          <a href="/creator/brain">Knowledge</a>
        </nav>
      </header>
      {children}
    </div>
  );
}
