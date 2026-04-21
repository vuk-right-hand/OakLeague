import { WaitlistForm } from './waitlist-form';

export default function LandingPage() {
  return (
    <main style={{ maxWidth: 640, margin: '10vh auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
        <a
          href="/login?next=/creator"
          style={{ fontSize: 13, opacity: 0.5 }}
        >
          Creator portal
        </a>
      </div>
      <h1 style={{ fontSize: 40, fontWeight: 700, lineHeight: 1.1 }}>
        Talk to the people you&apos;d pay $10K/mo to sit across from.
      </h1>
      <p style={{ opacity: 0.75, marginTop: 16, fontSize: 18 }}>
        Interactive video mentorship. Tap a hook, ask a question, get an answer in real time.
      </p>
      <div style={{ marginTop: 32 }}>
        <WaitlistForm />
      </div>
    </main>
  );
}
