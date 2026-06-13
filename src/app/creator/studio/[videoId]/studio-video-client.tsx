'use client';

import { useState, useTransition } from 'react';
import MuxUploader from '@mux/mux-uploader-react';
import {
  creatorCreateHook,
  creatorSetVideoPublished,
  creatorReplaceHookTake,
  creatorPublishLongForm,
  creatorUnpublishLongForm,
  creatorResetLongForm,
} from '../actions';

type Video = {
  id: string;
  title: string;
  description: string | null;
  published_at: string | null;
  lesson_count: number;
  creator_id: string;
  admin_removed_at: string | null;
  long_form_mux_status: string;
  long_form_mux_playback_id: string | null;
  long_form_mux_aspect_ratio: string | null;
  long_form_mux_duration_ms: number | null;
  long_form_processing_error: string | null;
  long_form_published_at: string | null;
};

type Hook = {
  id: string;
  lesson_number: number;
  title: string | null;
  caption: string | null;
  mux_status: string;
  mux_playback_id: string | null;
  processing_error: string | null;
  topic_tags: string[];
};

type Topic = { slug: string; label: string };

type Props = { video: Video; hooks: Hook[]; topics: Topic[] };

// Creator-facing copy for the shared publish-gate / action error codes.
const ERR_LABELS: Record<string, string> = {
  not_ready: 'Still processing — wait until the status reads “ready”.',
  duration_out_of_range: 'The full lesson must be between 5 and 55 minutes. Re-upload.',
  aspect_ratio_unsupported: 'The full lesson must be landscape 16:9. Re-upload.',
  aspect_ratio_missing: 'We couldn’t read the aspect ratio. Re-upload or contact us.',
  admin_removed: 'This video was removed by an OakLeague admin and is locked.',
  creator_not_live: 'Your creator profile isn’t live yet, so you can’t publish.',
  not_found: 'Video not found.',
  long_form_minutes_quota: 'You’ve hit your total full-lesson minutes limit.',
  rate_limited: 'Too many uploads in a short window. Wait a minute and retry.',
  insert_failed: 'Couldn’t save that — make sure each hook tag matches one of your knowledge topics.',
  video_quota_reached: 'You’ve reached your video limit.',
};
const label = (e: string) => ERR_LABELS[e] ?? e;

export function StudioVideoClient({ video, hooks, topics }: Props) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const published = video.published_at != null;
  const removed = video.admin_removed_at != null;
  // Audit S4: lowest FREE slot in 1–5, not max+1 — so deleting hook 3 of
  // {1..5} and re-adding reuses 3 instead of hitting the 1–5 CHECK at 6.
  const usedSlots = new Set(hooks.map((h) => h.lesson_number));
  const nextLessonNumber = [1, 2, 3, 4, 5].find((n) => !usedSlots.has(n)) ?? 0;
  const canAddHook = nextLessonNumber !== 0 && !removed;

  return (
    <section>
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>{video.title}</h1>
      {video.description && <p style={{ opacity: 0.75, marginTop: 8 }}>{video.description}</p>}

      {removed && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 12,
            border: '1px solid #5a2020',
            background: '#2a1010',
            borderRadius: 8,
            color: '#f0a0a0',
            fontSize: 13,
          }}
        >
          This video was removed by an OakLeague admin. Publishing and re-uploads are
          locked. Reach out if you think this was a mistake.
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => {
            setErr(null);
            start(async () => {
              const res = await creatorSetVideoPublished({ videoId: video.id, publish: !published });
              if (!res.ok) setErr(label(res.error));
              else if (res.longFormWarning) {
                setErr(`Hook published — but the full lesson didn’t go live: ${label(res.longFormWarning)}`);
              }
            });
          }}
          disabled={pending || removed}
        >
          {published ? 'Unpublish' : 'Publish'}
        </button>
        {published && (
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            Published {new Date(video.published_at!).toLocaleDateString()}
          </span>
        )}
      </div>

      <hr style={{ margin: '24px 0', borderColor: '#333' }} />

      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        Hooks ({hooks.length}/5)
      </h2>
      <p style={{ fontSize: 13, opacity: 0.65, marginTop: -4, marginBottom: 12 }}>
        Vertical 9:16 clips. Each one is a hook people swipe in the feed; tapping it opens
        the full lesson and lets them talk to your avatar.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {hooks.map((h) => (
          <HookCard key={h.id} hook={h} locked={removed} />
        ))}
      </ul>

      {canAddHook && (
        <AddHookForm videoId={video.id} nextLessonNumber={nextLessonNumber} topics={topics} />
      )}

      <hr style={{ margin: '24px 0', borderColor: '#333' }} />

      <LongFormPanel video={video} locked={removed} />

      {err && <div role="alert" style={{ color: 'salmon', marginTop: 12 }}>{err}</div>}
    </section>
  );
}

function LongFormPanel({ video, locked }: { video: Video; locked: boolean }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const status = video.long_form_mux_status;
  const isReady = status === 'ready';
  const isPublished = video.long_form_published_at != null;
  const aspect = video.long_form_mux_aspect_ratio;
  const durationS =
    video.long_form_mux_duration_ms != null ? video.long_form_mux_duration_ms / 1000.0 : null;
  const canMint = (status === 'pending' || status === 'failed') && !locked;

  const resolveEndpoint = async (): Promise<string> => {
    const res = await fetch('/creator/api/mux-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'video_long_form', id: video.id }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: 'upload_failed' }))) as { error?: string };
      throw new Error(label(body.error ?? 'upload_failed'));
    }
    const json = (await res.json()) as { uploadUrl: string };
    return json.uploadUrl;
  };

  const onPublish = () => {
    setErr(null);
    start(async () => {
      const res = await creatorPublishLongForm({ videoId: video.id });
      if (!res.ok) setErr(label(res.error));
    });
  };

  const onUnpublish = () => {
    setErr(null);
    start(async () => {
      const res = await creatorUnpublishLongForm({ videoId: video.id });
      if (!res.ok) setErr(label(res.error));
    });
  };

  const onReset = () => {
    if (!confirm('Reset the full lesson? This deletes the uploaded video.')) return;
    setErr(null);
    start(async () => {
      const res = await creatorResetLongForm({ videoId: video.id });
      if (!res.ok) setErr(label(res.error));
    });
  };

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Full lesson (optional)</h2>
      <div style={{ fontSize: 13, opacity: 0.65, marginBottom: 12 }}>
        Landscape 16:9, between 5 and 55 minutes. This is what people watch after tapping a
        hook — they can ask your avatar questions while it plays.
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 12 }}>
        <span style={{ fontSize: 13 }}>
          Status: <strong>{status}</strong>
          {isPublished && <span style={{ marginLeft: 8, color: '#5cb85c' }}>· published</span>}
        </span>
        {aspect && <span style={{ fontSize: 12, opacity: 0.6 }}>aspect {aspect}</span>}
        {durationS != null && (
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            {Math.floor(durationS / 60)}:
            {Math.floor(durationS % 60).toString().padStart(2, '0')}
          </span>
        )}
      </div>

      {video.long_form_processing_error && (
        <div style={{ fontSize: 12, color: 'salmon', marginBottom: 8 }}>
          {video.long_form_processing_error}
        </div>
      )}

      {canMint && (
        <div style={{ marginTop: 8 }}>
          <MuxUploader
            endpoint={resolveEndpoint}
            onUploadError={(e: Event | CustomEvent) => {
              const detail = (e as CustomEvent).detail as { message?: string } | undefined;
              setErr(detail?.message ?? 'upload_error');
            }}
          />
        </div>
      )}

      {isReady && video.long_form_mux_playback_id && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}>Uploaded ✓</div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {isReady && !isPublished && !locked && (
          <button type="button" onClick={onPublish} disabled={pending}>
            {pending ? 'Publishing…' : 'Publish full lesson'}
          </button>
        )}
        {isPublished && (
          <button type="button" onClick={onUnpublish} disabled={pending}>
            {pending ? 'Unpublishing…' : 'Unpublish full lesson'}
          </button>
        )}
        {!canMint && !isPublished && status !== 'pending' && !locked && (
          <button type="button" onClick={onReset} disabled={pending}>
            {pending ? 'Resetting…' : 'Reset full lesson'}
          </button>
        )}
      </div>

      {err && (
        <div role="alert" style={{ color: 'salmon', fontSize: 13, marginTop: 8 }}>
          {err}
        </div>
      )}
    </section>
  );
}

function HookCard({ hook, locked }: { hook: Hook; locked: boolean }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // Mint route accepts pending|failed; for a ready take the creator must
  // "Replace take" first (which resets it back to pending).
  const canUpload = hook.mux_status !== 'ready' && !locked;

  const resolveEndpoint = async (): Promise<string> => {
    const res = await fetch('/creator/api/mux-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'hook', id: hook.id }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: 'upload_failed' }))) as { error?: string };
      throw new Error(label(body.error ?? 'upload_failed'));
    }
    const json = (await res.json()) as { uploadUrl: string };
    return json.uploadUrl;
  };

  return (
    <li style={{ border: '1px solid #2a2a2a', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>
          Hook {hook.lesson_number} — {hook.title ?? '(untitled)'}
        </strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{hook.mux_status}</span>
      </div>
      {hook.caption && <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>{hook.caption}</div>}
      {hook.processing_error && (
        <div style={{ fontSize: 12, color: 'salmon', marginTop: 4 }}>{hook.processing_error}</div>
      )}
      <div style={{ fontSize: 12, opacity: 0.5, marginTop: 4 }}>
        Tags: {hook.topic_tags.join(', ')}
      </div>

      {canUpload && (
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

      {hook.mux_status === 'ready' && (
        <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>Uploaded ✓</div>
      )}

      {hook.mux_status === 'ready' && !locked && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              if (!confirm('Replace this take? The current clip is deleted.')) return;
              setErr(null);
              start(async () => {
                const res = await creatorReplaceHookTake({ hookId: hook.id });
                if (!res.ok) setErr(label(res.error));
              });
            }}
            disabled={pending}
          >
            {pending ? 'Resetting…' : 'Replace take'}
          </button>
        </div>
      )}
      {err && <div role="alert" style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</div>}
    </li>
  );
}

function AddHookForm({
  videoId,
  nextLessonNumber,
  topics,
}: {
  videoId: string;
  nextLessonNumber: number;
  topics: Topic[];
}) {
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>(topics[0] ? [topics[0].slug] : []);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggleTag = (slug: string) =>
    setSelectedTags((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));

  return (
    <form
      style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        start(async () => {
          const res = await creatorCreateHook({
            videoId,
            lessonNumber: nextLessonNumber,
            title,
            caption: caption || undefined,
            topicTags: selectedTags,
          });
          if (!res.ok) setErr(label(res.error));
          else {
            setTitle('');
            setCaption('');
          }
        });
      }}
    >
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Add hook {nextLessonNumber}</h3>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" required maxLength={200} />
      <input
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Caption (optional)"
        maxLength={280}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {topics.map((t) => {
          const active = selectedTags.includes(t.slug);
          return (
            <button
              key={t.slug}
              type="button"
              onClick={() => toggleTag(t.slug)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 12,
                border: '1px solid #444',
                background: active ? '#2e6bff' : 'transparent',
                color: active ? '#fff' : '#ddd',
              }}
            >
              {t.label}
            </button>
          );
        })}
        {topics.length === 0 && (
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            Add knowledge topics first (Knowledge tab) so hooks can be tagged.
          </span>
        )}
      </div>
      <button type="submit" disabled={pending || !title || selectedTags.length === 0}>
        {pending ? 'Adding…' : 'Add hook'}
      </button>
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </form>
  );
}
