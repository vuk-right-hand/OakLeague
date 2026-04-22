'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createVideo } from '../../actions';

type Creator = { id: string; display_name: string; handle: string };

export function NewVideoForm({ creators }: { creators: Creator[] }) {
  const [creatorId, setCreatorId] = useState(creators[0]?.id ?? '');
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
          const res = await createVideo({ creatorId, title, description: description || undefined });
          if (!res.ok) setErr(res.error);
          else if (res.videoId) router.push(`/admin/content/videos/${res.videoId}`);
        });
      }}
    >
      <label>
        <div style={{ fontSize: 13, marginBottom: 4 }}>Creator</div>
        <select value={creatorId} onChange={(e) => setCreatorId(e.target.value)} required>
          {creators.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name} (@{c.handle})
            </option>
          ))}
        </select>
      </label>
      <label>
        <div style={{ fontSize: 13, marginBottom: 4 }}>Title</div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      </label>
      <label>
        <div style={{ fontSize: 13, marginBottom: 4 }}>Description (optional)</div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
      </label>
      <button type="submit" disabled={pending || !title || !creatorId}>
        {pending ? 'Creating…' : 'Create video'}
      </button>
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </form>
  );
}
