// /privacy — Privacy Policy (FIVE_CREATOR_ONBOARDING_READINESS P0-4).
//
// v1 plain-language draft. Version matches CONSENT_VERSIONS.privacy. Good-faith
// v1 — review with counsel before scaled launch; sufficient for the first
// creator cohort. Describes what the app actually collects (verified against
// the schema: profiles, sessions, session_turns transcripts, feed_events,
// voice/consent records).

import { CONSENT_VERSIONS } from '@/lib/consent';

export const metadata = { title: 'Privacy Policy — OakLeague' };

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 720, margin: '6vh auto', padding: 24, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 600 }}>Privacy Policy</h1>
      <p style={{ opacity: 0.6, fontSize: 13 }}>Version {CONSENT_VERSIONS.privacy}</p>

      <h2 style={h2}>What we collect</h2>
      <ul>
        <li><strong>Account</strong>: your email and the profile details you provide (display name, goals, timezone).</li>
        <li><strong>Usage</strong>: which videos you watch and interactions with the feed, used to personalize what you see.</li>
        <li><strong>Conversations</strong>: transcripts of your AI mentorship sessions (what you ask and the avatar&apos;s replies) so the experience works and to improve quality.</li>
        <li><strong>Consent records</strong>: for creators, a versioned record of voice/likeness and Terms acceptance, including the time and (best-effort) IP/device of acceptance.</li>
        <li><strong>Technical</strong>: standard logs and error/analytics data (e.g. Sentry, PostHog).</li>
      </ul>

      <h2 style={h2}>Microphone &amp; camera</h2>
      <p>
        Your microphone is used only during an active mentorship session you
        start. The camera is <strong>off by default</strong> and only turns on if
        you explicitly enable it, with a visible indicator while it&apos;s on.
      </p>

      <h2 style={h2}>How we use it</h2>
      <p>
        To run and personalize the service, keep it secure, measure costs and
        reliability, and improve quality. We do not sell your personal data.
      </p>

      <h2 style={h2}>Voice &amp; AI providers</h2>
      <p>
        We use third-party providers to transcribe audio, generate responses, and
        synthesize a creator&apos;s cloned voice and avatar. Audio you speak during
        a session is processed by these providers to produce a reply; we retain
        the text transcript, not raw session audio.
      </p>

      <h2 style={h2}>Retention</h2>
      <p>
        We keep account and conversation data for as long as your account is
        active. Some signals are minimized on a schedule. Consent records are kept
        as long as needed to evidence the consent. You can ask us to delete your
        account and associated data.
      </p>

      <h2 style={h2}>Your choices</h2>
      <p>
        You can request access to or deletion of your data, and creators can
        withdraw voice/likeness consent. Contact OakLeague support to make a
        request.
      </p>

      <h2 style={h2}>Changes</h2>
      <p>
        We&apos;ll update the version above when this policy changes and ask you to
        re-accept where appropriate.
      </p>

      <p style={{ marginTop: 32 }}>
        See also our <a href="/terms">Terms of Service</a>.
      </p>
    </main>
  );
}

const h2: React.CSSProperties = { fontSize: 18, fontWeight: 600, marginTop: 28 };
