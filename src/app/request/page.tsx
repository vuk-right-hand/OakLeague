import { RequestForm } from './request-form';

export const metadata = {
  title: 'Request to become a creator — OakLeague',
};

export default function RequestPage() {
  return (
    <main style={{ maxWidth: 640, margin: '4vh auto', padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Request to become a creator</h1>
      <p style={{ opacity: 0.7, marginTop: 8, lineHeight: 1.5 }}>
        Tell us who you are and where to find your work. Our team reviews every request by
        hand — if it’s a fit, we’ll email you an invite to set up your profile. Links are
        optional; share whatever shows your work best.
      </p>
      <RequestForm />
    </main>
  );
}
