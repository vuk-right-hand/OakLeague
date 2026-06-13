'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { creatorCreateVideo } from './actions';

// Creator-scoped: NO creator picker (the action derives the creator from the
// session). Mirror of the admin NewVideoForm minus the creatorId field.

const ERR_LABELS: Record<string, string> = {
  video_quota_reached: 'You have reached your video limit.',
  invalid_input: 'Please add a title.',
  unauthenticated: 'Your session expired. Refresh and sign in again.',
  forbidden: 'Your account is not a creator.',
  insert_failed: 'Could not create the video. Try again.',
};

export function NewVideoForm() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        start(async () => {
          const res = await creatorCreateVideo({ title, description: description || undefined });
          if (!res.ok) setErr(ERR_LABELS[res.error] ?? res.error);
          else if (res.videoId) router.push(`/creator/studio/${res.videoId}`);
        });
      }}
    >
      <label>
        <div style={{ fontSize: 13, marginBottom: 4 }}>Title</div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      </label>
      <label>
        <div style={{ fontSize: 13, marginBottom: 4 }}>Description (optional)</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
        />
      </label>
      <button type="submit" disabled={pending || !title}>
        {pending ? 'Creating…' : 'Create video'}
      </button>
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </form>
  );
}
