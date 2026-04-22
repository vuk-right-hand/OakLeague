'use client';

import { useState, useTransition } from 'react';
import MuxUploader from '@mux/mux-uploader-react';
import { createHook, setVideoPublished, replaceHookTake, resetFailedHook } from '../../actions';

type Video = {
  id: string;
  title: string;
  description: string | null;
  published_at: string | null;
  lesson_count: number;
  creator_id: string;
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

type Props = {
  video: Video;
  hooks: Hook[];
  creator: { id: string; display_name: string; handle: string } | null;
  topics: Topic[];
};

export function VideoDetailClient({ video, hooks, creator, topics }: Props) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const published = video.published_at != null;
  const nextLessonNumber = (hooks.reduce((m, h) => Math.max(m, h.lesson_number), 0) || 0) + 1;
  const canAddHook = nextLessonNumber <= 5;

  return (
    <section>
      <div style={{ marginBottom: 8, opacity: 0.6, fontSize: 13 }}>
        {creator ? `@${creator.handle}` : '(no creator)'}
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>{video.title}</h1>
      {video.description && <p style={{ opacity: 0.75, marginTop: 8 }}>{video.description}</p>}

      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => {
            setErr(null);
            start(async () => {
              const res = await setVideoPublished({ videoId: video.id, publish: !published });
              if (!res.ok) setErr(res.error);
            });
          }}
          disabled={pending}
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

      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Lessons ({hooks.length}/5)</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {hooks.map((h) => (
          <HookCard key={h.id} hook={h} videoId={video.id} />
        ))}
      </ul>

      {canAddHook && (
        <AddHookForm
          videoId={video.id}
          nextLessonNumber={nextLessonNumber}
          topics={topics}
        />
      )}

      {err && <div role="alert" style={{ color: 'salmon', marginTop: 12 }}>{err}</div>}
    </section>
  );
}

function HookCard({ hook, videoId }: { hook: Hook; videoId: string }) {
  const [pending, start] = useTransition();
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const resolveEndpoint = async (): Promise<string> => {
    const res = await fetch('/api/admin/mux-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'hook', id: hook.id }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: 'upload_failed' }))) as { error?: string };
      throw new Error(body.error ?? 'upload_failed');
    }
    const json = (await res.json()) as { uploadUrl: string };
    setUploadUrl(json.uploadUrl);
    return json.uploadUrl;
  };

  return (
    <li style={{ border: '1px solid #2a2a2a', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>
          Lesson {hook.lesson_number} — {hook.title ?? '(untitled)'}
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

      {hook.mux_status !== 'ready' && (
        <div style={{ marginTop: 12 }}>
          <MuxUploader
            endpoint={resolveEndpoint}
            onSuccess={() => setUploadUrl(null)}
            onUploadError={(e: Event | CustomEvent) => {
              const detail = (e as CustomEvent).detail as { message?: string } | undefined;
              setErr(detail?.message ?? 'upload_error');
            }}
          />
        </div>
      )}

      {hook.mux_status === 'ready' && hook.mux_playback_id && (
        <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>
          Playback ID: <code>{hook.mux_playback_id}</code>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        {hook.mux_status === 'ready' && (
          <button
            type="button"
            onClick={() => {
              setErr(null);
              start(async () => {
                const res = await replaceHookTake({ hookId: hook.id });
                if (!res.ok) setErr(res.error);
              });
            }}
            disabled={pending}
          >
            Replace take
          </button>
        )}
        {hook.mux_status === 'failed' && (
          <button
            type="button"
            onClick={() => {
              setErr(null);
              start(async () => {
                const res = await resetFailedHook({ hookId: hook.id });
                if (!res.ok) setErr(res.error);
              });
            }}
            disabled={pending}
          >
            Retry upload
          </button>
        )}
      </div>
      {uploadUrl && <div style={{ fontSize: 10, opacity: 0.3, marginTop: 4 }}>Uploading…</div>}
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

  const toggleTag = (slug: string) => {
    setSelectedTags((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
  };

  return (
    <form
      style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        start(async () => {
          const res = await createHook({
            videoId,
            lessonNumber: nextLessonNumber,
            title,
            caption: caption || undefined,
            topicTags: selectedTags,
          });
          if (!res.ok) setErr(res.error);
          else {
            setTitle('');
            setCaption('');
          }
        });
      }}
    >
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Add lesson {nextLessonNumber}</h3>
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
            No topics configured for this creator yet.
          </span>
        )}
      </div>
      <button type="submit" disabled={pending || !title || selectedTags.length === 0}>
        {pending ? 'Adding…' : 'Add lesson'}
      </button>
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
    </form>
  );
}
