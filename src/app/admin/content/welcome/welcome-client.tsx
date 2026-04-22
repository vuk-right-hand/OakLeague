'use client';

import { useState, useTransition } from 'react';
import MuxUploader from '@mux/mux-uploader-react';
import { createWelcomeHook, activateWelcomeHook } from '../actions';

type Welcome = {
  id: string;
  creator_id: string;
  video_id: string | null;
  mux_playback_id: string | null;
  mux_status: string;
  active: boolean;
  transcript: string | null;
  processing_error: string | null;
};

type Creator = { id: string; display_name: string; handle: string };

type Props = {
  welcomeHooks: Welcome[];
  creators: Creator[];
};

export function WelcomeConsoleClient({ welcomeHooks, creators }: Props) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [creatorId, setCreatorId] = useState(creators[0]?.id ?? '');
  const [transcript, setTranscript] = useState('');

  return (
    <section>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 16 }}>Welcome hook</h1>
      <p style={{ opacity: 0.7, fontSize: 13, marginBottom: 24 }}>
        One active welcome plays for new visitors. Must be status=ready before it can be activated.
      </p>

      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520, marginBottom: 32 }}
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          start(async () => {
            const res = await createWelcomeHook({
              creatorId,
              transcript: transcript || undefined,
            });
            if (!res.ok) setErr(res.error);
            else setTranscript('');
          });
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>New welcome</h2>
        <label style={{ fontSize: 13 }}>
          Creator
          <select
            value={creatorId}
            onChange={(e) => setCreatorId(e.target.value)}
            required
            style={{ display: 'block', marginTop: 4 }}
          >
            {creators.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name} (@{c.handle})
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          Transcript (optional)
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            maxLength={8192}
            rows={3}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </label>
        <button type="submit" disabled={pending || !creatorId}>
          {pending ? 'Creating…' : 'Create welcome slot'}
        </button>
      </form>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Existing welcomes</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {welcomeHooks.map((w) => (
          <WelcomeCard key={w.id} welcome={w} />
        ))}
        {welcomeHooks.length === 0 && <li style={{ opacity: 0.6 }}>No welcome hooks yet.</li>}
      </ul>

      {err && <div role="alert" style={{ color: 'salmon', marginTop: 12 }}>{err}</div>}
    </section>
  );
}

function WelcomeCard({ welcome }: { welcome: Welcome }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const resolveEndpoint = async (): Promise<string> => {
    const res = await fetch('/api/admin/mux-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'welcome_hook', id: welcome.id }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: 'upload_failed' }))) as { error?: string };
      throw new Error(body.error ?? 'upload_failed');
    }
    const json = (await res.json()) as { uploadUrl: string };
    return json.uploadUrl;
  };

  return (
    <li
      style={{
        border: welcome.active ? '1px solid #2e6bff' : '1px solid #2a2a2a',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{welcome.active ? 'ACTIVE · ' : ''}Welcome #{welcome.id.slice(0, 8)}</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{welcome.mux_status}</span>
      </div>
      {welcome.transcript && <div style={{ fontSize: 13, opacity: 0.75, marginTop: 8 }}>{welcome.transcript}</div>}
      {welcome.processing_error && (
        <div style={{ fontSize: 12, color: 'salmon', marginTop: 4 }}>{welcome.processing_error}</div>
      )}

      {welcome.mux_status !== 'ready' && (
        <div style={{ marginTop: 12 }}>
          <MuxUploader
            endpoint={resolveEndpoint}
            onUploadError={(e: Event | CustomEvent) => {
              const detail = (e as CustomEvent).detail as { message?: string } | undefined;
              setErr(detail?.message ?? 'upload_error');
            }}
          />
        </div>
      )}

      {welcome.mux_status === 'ready' && !welcome.active && (
        <button
          type="button"
          style={{ marginTop: 12 }}
          disabled={pending}
          onClick={() => {
            setErr(null);
            start(async () => {
              const res = await activateWelcomeHook({ welcomeHookId: welcome.id });
              if (!res.ok) setErr(res.error);
            });
          }}
        >
          {pending ? 'Activating…' : 'Set as active'}
        </button>
      )}

      {err && <div role="alert" style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</div>}
    </li>
  );
}
