'use client';

import { useState, useTransition } from 'react';
import { submitCreatorApplication } from './actions';
import { CREATOR_TERMS_VERSION } from '@/lib/legal/creator-terms-version';

type Topic = { slug: string; title: string; description: string };

export function ApplyForm() {
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [bio, setBio] = useState('');
  const [topics, setTopics] = useState<Topic[]>([{ slug: '', title: '', description: '' }]);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [twitterUrl, setTwitterUrl] = useState('');
  const [website, setWebsite] = useState('');
  const [duetConsent, setDuetConsent] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const updateTopic = (i: number, patch: Partial<Topic>) =>
    setTopics(topics.map((t, j) => (i === j ? { ...t, ...patch } : t)));

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 24 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        const proof = {
          youtube_url: youtubeUrl || undefined,
          twitter_url: twitterUrl || undefined,
          website: website || undefined,
        };
        startTransition(async () => {
          const res = await submitCreatorApplication({
            display_name: displayName,
            handle,
            bio,
            topics,
            proof,
            duet_consent: duetConsent,
          });
          if (!res.ok) {
            // Stale-client: server received a request shape from an
            // old bundle (no duet_consent field). Force a hard reload
            // so the user gets the new form with the consent checkbox.
            // (audit R2 M1)
            if (res.error === 'stale_client') {
              window.location.reload();
              return;
            }
            setErr(humanize(res.error));
          } else window.location.href = '/apply/submitted';
        });
      }}
    >
      <label>
        Display name
        <input
          required
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={pending}
        />
      </label>

      <label>
        Handle (a-z, 0-9, underscore; 3-30 chars)
        <input
          required
          minLength={3}
          maxLength={30}
          pattern="^[a-z0-9_]+$"
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
          disabled={pending}
        />
      </label>

      <label>
        Bio
        <textarea
          maxLength={2000}
          rows={4}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          disabled={pending}
        />
      </label>

      <fieldset style={{ border: '1px solid #333', padding: 12 }}>
        <legend>Topics (1–5)</legend>
        {topics.map((t, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            <input
              placeholder="slug (e.g. distributed-systems)"
              value={t.slug}
              onChange={(e) => updateTopic(i, { slug: e.target.value.toLowerCase() })}
              maxLength={40}
              disabled={pending}
            />
            <input
              placeholder="title"
              value={t.title}
              onChange={(e) => updateTopic(i, { title: e.target.value })}
              maxLength={80}
              disabled={pending}
            />
            <textarea
              placeholder="description (optional)"
              value={t.description}
              onChange={(e) => updateTopic(i, { description: e.target.value })}
              maxLength={500}
              rows={2}
              disabled={pending}
            />
            {topics.length > 1 && (
              <button
                type="button"
                onClick={() => setTopics(topics.filter((_, j) => j !== i))}
                disabled={pending}
              >
                Remove topic
              </button>
            )}
          </div>
        ))}
        {topics.length < 5 && (
          <button
            type="button"
            onClick={() => setTopics([...topics, { slug: '', title: '', description: '' }])}
            disabled={pending}
          >
            Add topic
          </button>
        )}
      </fieldset>

      <fieldset style={{ border: '1px solid #333', padding: 12 }}>
        <legend>Proof</legend>
        <label>
          YouTube URL
          <input
            type="url"
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            disabled={pending}
          />
        </label>
        <label>
          Twitter / X URL
          <input
            type="url"
            value={twitterUrl}
            onChange={(e) => setTwitterUrl(e.target.value)}
            disabled={pending}
          />
        </label>
        <label>
          Website
          <input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            disabled={pending}
          />
        </label>
      </fieldset>

      <fieldset style={{ border: '1px solid #333', padding: 12 }}>
        <legend>Duet recording consent</legend>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={duetConsent}
            onChange={(e) => setDuetConsent(e.target.checked)}
            disabled={pending}
            style={{ marginTop: 4 }}
          />
          <span>
            I understand that users may record and share duet videos that include
            my AI-cloned voice and avatar likeness as part of natural conversations
            on OakLeague, as described in the{' '}
            <a
              href="/legal/creator-terms"
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'underline' }}
            >
              Creator Terms ({CREATOR_TERMS_VERSION})
            </a>
            .
          </span>
        </label>
      </fieldset>

      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
      <button type="submit" disabled={pending || !duetConsent}>
        Submit application
      </button>
    </form>
  );
}

// Note: 'stale_client' is intentionally NOT humanized here — the
// submit handler short-circuits to window.location.reload() before
// reaching this map.
function humanize(code: string): string {
  switch (code) {
    case 'handle_taken': return 'That handle is already taken. Try another.';
    case 'duplicate_application': return 'You already have an application under review.';
    case 'invite_claim_invalid': return 'Your invite session expired. Open the invite email again.';
    case 'invite_unavailable': return 'This invite is no longer valid.';
    case 'needs_invite': return 'You need an active invite to apply.';
    case 'duet_consent_required': return 'You must consent to user duet recordings to apply.';
    case 'duet_consent_terms_version_invalid': return 'Terms version mismatch. Refresh and try again.';
    default: return 'Submission failed. Try again.';
  }
}
