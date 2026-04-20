import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCallerUserId } from '@/lib/auth-guards';
import { ApplyForm } from './apply-form';

export default async function ApplyPage() {
  const userId = await getCallerUserId();
  if (!userId) redirect(`/login?next=${encodeURIComponent('/apply')}`);

  const jar = await cookies();
  const nonce = jar.get('invite_nonce')?.value;
  if (!nonce) {
    return (
      <main style={{ maxWidth: 520, margin: '10vh auto', padding: 24, textAlign: 'center' }}>
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Your invite session expired</h1>
        <p style={{ opacity: 0.7, marginTop: 12 }}>
          Click the invite link in your email again to resume.
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '4vh auto', padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Creator application</h1>
      <p style={{ opacity: 0.7, marginTop: 8 }}>
        Tell us who you are, what you teach, and where to verify you.
      </p>
      <ApplyForm />
    </main>
  );
}
