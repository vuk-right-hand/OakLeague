// /terms — Terms of Service (FIVE_CREATOR_ONBOARDING_READINESS P0-4).
//
// v1 plain-language draft. The version string MUST match CONSENT_VERSIONS.tos
// (src/lib/consent.ts) — that's what acceptance is recorded against. This is a
// good-faith v1 draft and SHOULD be reviewed by counsel before scaled launch;
// it is sufficient for the first cohort of creators + their audiences.

import { CONSENT_VERSIONS } from '@/lib/consent';

export const metadata = { title: 'Terms of Service — OakLeague' };

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 720, margin: '6vh auto', padding: 24, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Terms of Service</h1>
      <p style={{ opacity: 0.6, fontSize: 13 }}>Version {CONSENT_VERSIONS.tos}</p>

      <h2 style={h2}>1. What OakLeague is</h2>
      <p>
        OakLeague provides interactive video mentorship. You can watch short and
        long-form videos from creators and have a real-time conversation with an
        AI avatar trained on a creator&apos;s own materials and voice. By creating
        an account or using the service, you agree to these Terms.
      </p>

      <h2 style={h2}>2. Your account</h2>
      <p>
        You are responsible for activity under your account and for keeping your
        sign-in secure. You must be old enough to form a binding contract in your
        jurisdiction. We may suspend accounts that abuse the service, attempt to
        breach security, or violate these Terms.
      </p>

      <h2 style={h2}>3. AI conversations</h2>
      <p>
        The AI avatar generates responses automatically. It speaks in a
        creator&apos;s cloned voice and persona but is <strong>not</strong> the
        creator personally and may be inaccurate. Responses are for general
        educational purposes only and are not professional, legal, medical, or
        financial advice. Do not rely on them as a substitute for a qualified
        professional.
      </p>

      <h2 style={h2}>4. Acceptable use</h2>
      <p>
        Don&apos;t use OakLeague to break the law, harass others, infringe
        intellectual property, attempt to extract another user&apos;s data, or
        probe/abuse the AI to produce harmful content. We may remove content and
        terminate access for violations.
      </p>

      <h2 style={h2}>5. Creators &amp; content</h2>
      <p>
        Creators control the knowledge their avatar is trained on and authorize
        the cloning of their voice and likeness through a separate consent step.
        Creators retain ownership of their content and grant OakLeague the
        licenses needed to operate the service. A creator may withdraw consent;
        we will stop new sessions and remove the creator from the feed.
      </p>

      <h2 style={h2}>6. Privacy</h2>
      <p>
        Our <a href="/privacy">Privacy Policy</a> explains what we collect and
        why. Using OakLeague means you also agree to that policy.
      </p>

      <h2 style={h2}>7. Disclaimers &amp; liability</h2>
      <p>
        The service is provided &quot;as is&quot; without warranties. To the
        fullest extent permitted by law, OakLeague is not liable for indirect or
        consequential damages arising from your use of the service or reliance on
        AI-generated responses.
      </p>

      <h2 style={h2}>8. Changes</h2>
      <p>
        We may update these Terms. When we do, we&apos;ll change the version above
        and ask you to accept the new version. Continued use after an update means
        you accept the current Terms.
      </p>

      <p style={{ marginTop: 32, opacity: 0.6, fontSize: 13 }}>
        Questions? Contact OakLeague support.
      </p>
    </main>
  );
}

const h2: React.CSSProperties = { fontSize: 18, fontWeight: 600, marginTop: 28 };
