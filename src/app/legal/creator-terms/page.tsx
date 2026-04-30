import type { Metadata } from 'next';
import { CREATOR_TERMS_VERSION } from '@/lib/legal/creator-terms-version';

// Static page — pinned content. Re-export the version constant for
// convenience but the source-of-truth lives in the leaf lib module.
export { CREATOR_TERMS_VERSION };

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: `Creator Terms — ${CREATOR_TERMS_VERSION}`,
  description:
    'OakLeague creator agreement covering voice cloning, brain training, ' +
    'user-generated duet recordings, and creator-side controls.',
};

export default function CreatorTermsPage() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '6vh auto',
        padding: '0 24px 80px',
        lineHeight: 1.55,
      }}
    >
      <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 4 }}>
        Version <strong>{CREATOR_TERMS_VERSION}</strong>
      </p>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
        OakLeague Creator Terms
      </h1>

      <p>
        By submitting a creator application, you agree to the terms below in
        addition to OakLeague&apos;s general Terms of Service. These terms
        govern the relationship between you (&quot;Creator&quot;) and OakLeague
        with respect to interactive AI mentorship on the platform.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>
        1. Voice cloning &amp; brain training
      </h2>
      <p>
        OakLeague will clone your voice using sample audio you provide and
        train a knowledge model (&quot;brain&quot;) on the topic content you
        upload. The cloned voice and trained brain are used solely to power
        interactive conversations between users and your AI mentor on
        OakLeague. You retain ownership of all source materials you upload.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>
        2. User-generated duet recordings
      </h2>
      <p>
        OakLeague users may record and share duet videos that include your
        AI-cloned voice and avatar likeness as part of natural conversations
        on the platform. These recordings are produced and shared by users
        from their own devices. By accepting these terms you consent to this
        use as a normal mode of platform operation.
      </p>
      <p>
        OakLeague will provide creator-side controls to (a) review which of
        your conversations have been recorded and shared, and (b) request
        takedown of specific recordings that materially harm your brand or
        reputation. Takedown turnaround is best-effort and not contractual
        in this version of the terms.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>
        3. Tier &amp; provider routing
      </h2>
      <p>
        OakLeague routes interactive sessions through third-party voice and
        avatar providers. Provider selection may change at session-open based
        on user tier and infrastructure availability. The creator-experience
        guarantee is that your cloned voice (Cartesia) is the only voice
        users hear from your AI mentor — generic AI voices will never be
        served on any tier.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>
        4. Approval &amp; revocation
      </h2>
      <p>
        Creator applications are admin-reviewed; submission does not
        guarantee approval. You may request offboarding at any time, after
        which OakLeague will (a) stop opening new sessions against your
        brain, (b) delete your cloned voice from active use within 30 days,
        and (c) retain training source material only as required to honor
        existing sessions in flight.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>
        5. Compensation
      </h2>
      <p>
        Creator compensation, perks, and revenue-share are out of scope of
        this version of the terms and will be set out in a separate
        amendment before any monetization launches.
      </p>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 32 }}>
        6. Changes
      </h2>
      <p>
        OakLeague may update these terms. Material changes will be
        communicated by email to your creator-account address. The terms
        version effective at the time of your application submission is the
        version that governs that submission and is recorded in your
        application audit trail.
      </p>

      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 48 }}>
        Questions: <a href="mailto:legal@oakleague.com">legal@oakleague.com</a>
      </p>
    </main>
  );
}
