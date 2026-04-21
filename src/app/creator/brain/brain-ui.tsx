'use client';

import { useState, useTransition } from 'react';
import { SampleFetchBadge } from '@/components/creator/SampleFetchBadge';
import type { CreatorTopicRow, SampleContentRow, SampleSourceType } from '@/lib/creator/types';
import {
  addTopic,
  deleteTopic,
  addSampleContent,
  deleteSampleContent,
} from './actions';

const SLUG_RE = /^[a-z0-9_-]+$/;

const SOURCE_TYPE_LABELS: Record<SampleSourceType, string> = {
  youtube: 'YouTube',
  transcript: 'Transcript',
  book_or_doc: 'Book / Doc',
  mastermind_or_course: 'Mastermind / Course',
  testimonial: 'Testimonial',
};

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 40);
}

export function AddTopicForm({
  disabled,
  disabledReason,
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const effectiveSlug = slugEdited ? slug : slugify(title);
  const slugValid = effectiveSlug.length >= 2 && effectiveSlug.length <= 40 && SLUG_RE.test(effectiveSlug);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    if (!slugValid) {
      setError('Slug must be 2–40 chars, lowercase letters, digits, _ or -.');
      return;
    }
    startTransition(async () => {
      const res = await addTopic({
        slug: effectiveSlug,
        title: title.trim(),
        description: description.trim() || undefined,
      });
      if (!res.ok) {
        setError(errorLabel(res.error));
        return;
      }
      setTitle('');
      setSlug('');
      setDescription('');
      setSlugEdited(false);
    });
  }

  if (disabled) {
    return (
      <p style={{ opacity: 0.6, fontSize: 13, margin: 0 }}>{disabledReason}</p>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Topic title (e.g. Go-To-Market)"
          style={inputStyle}
          disabled={pending}
        />
        <input
          value={effectiveSlug}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugEdited(true);
          }}
          placeholder="slug"
          style={{ ...inputStyle, maxWidth: 200 }}
          disabled={pending}
        />
        <button type="submit" style={buttonPrimary} disabled={pending || !title || !slugValid}>
          {pending ? 'Adding…' : 'Add topic'}
        </button>
      </div>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Short description (optional)"
        style={inputStyle}
        maxLength={500}
        disabled={pending}
      />
      {error && <p style={errorText}>{error}</p>}
    </form>
  );
}

export function TopicAccordion({
  topic,
  samples,
  allTopics,
}: {
  topic: CreatorTopicRow;
  samples: SampleContentRow[];
  allTopics: CreatorTopicRow[];
}) {
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    if (!confirm(`Delete topic "${topic.title}"? This cannot be undone.`)) return;
    setDeleteError(null);
    startTransition(async () => {
      const res = await deleteTopic({ topicId: topic.id });
      if (!res.ok) setDeleteError(errorLabel(res.error));
    });
  }

  return (
    <details style={{ border: '1px solid #222', borderRadius: 8, padding: 12 }}>
      <summary
        style={{
          cursor: 'pointer',
          listStyle: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <strong style={{ fontSize: 15 }}>{topic.title}</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>#{topic.slug}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 12 }}>
          {samples.length} source{samples.length === 1 ? '' : 's'}
        </span>
      </summary>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {topic.description && <p style={{ opacity: 0.8, margin: 0 }}>{topic.description}</p>}

        {samples.length === 0 ? (
          <p style={{ opacity: 0.6, margin: 0 }}>
            No sources yet for {topic.title} — add one below.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {samples.map((s) => (
              <SampleRow key={s.id} sample={s} />
            ))}
          </ul>
        )}

        <AddSampleForm topic={topic} allTopics={allTopics} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            onClick={handleDelete}
            disabled={pending}
            style={buttonDanger}
          >
            {pending ? 'Deleting…' : 'Delete topic'}
          </button>
        </div>
        {deleteError && <p style={errorText}>{deleteError}</p>}
      </div>
    </details>
  );
}

function SampleRow({ sample }: { sample: SampleContentRow }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    if (!confirm('Delete this source?')) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteSampleContent({ id: sample.id });
      if (!res.ok) setError(errorLabel(res.error));
    });
  }

  const label =
    sample.title ||
    (sample.source_url ? truncateUrl(sample.source_url) : sample.raw_text?.slice(0, 80) || '(untitled)');

  return (
    <li
      style={{
        padding: 10,
        border: '1px solid #222',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          padding: '2px 8px',
          borderRadius: 4,
          background: '#1c1c1c',
          border: '1px solid #2a2a2a',
          fontSize: 11,
        }}
      >
        {SOURCE_TYPE_LABELS[sample.source_type]}
      </span>
      {sample.source_url ? (
        <a href={sample.source_url} target="_blank" rel="noopener noreferrer ugc">
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
      <SampleFetchBadge status={sample.fetch_status} />
      <button
        type="button"
        onClick={handleDelete}
        disabled={pending}
        style={{ marginLeft: 'auto', ...buttonGhost }}
      >
        {pending ? '…' : 'Delete'}
      </button>
      {error && <p style={{ ...errorText, width: '100%' }}>{error}</p>}
    </li>
  );
}

function AddSampleForm({
  topic,
  allTopics,
}: {
  topic: CreatorTopicRow;
  allTopics: CreatorTopicRow[];
}) {
  const [sourceType, setSourceType] = useState<SampleSourceType>('youtube');
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [rawText, setRawText] = useState('');
  const [extraTags, setExtraTags] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const tags = [topic.slug, ...Array.from(extraTags)];
    startTransition(async () => {
      const res = await addSampleContent({
        source_type: sourceType,
        title: title.trim() || undefined,
        source_url: sourceUrl.trim() || undefined,
        raw_text: rawText || undefined,
        topic_tags: tags,
      });
      if (!res.ok) {
        setError(errorLabel(res.error));
        return;
      }
      setTitle('');
      setSourceUrl('');
      setRawText('');
      setExtraTags(new Set());
    });
  }

  const otherTopics = allTopics.filter((t) => t.id !== topic.id);

  return (
    <form
      onSubmit={submit}
      style={{
        marginTop: 8,
        padding: 12,
        border: '1px dashed #2a2a2a',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as SampleSourceType)}
          style={inputStyle}
          disabled={pending}
        >
          {(Object.keys(SOURCE_TYPE_LABELS) as SampleSourceType[]).map((k) => (
            <option key={k} value={k}>
              {SOURCE_TYPE_LABELS[k]}
            </option>
          ))}
        </select>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
          maxLength={200}
          disabled={pending}
        />
      </div>
      <input
        value={sourceUrl}
        onChange={(e) => setSourceUrl(e.target.value)}
        placeholder="https://… (optional)"
        style={inputStyle}
        maxLength={2048}
        disabled={pending}
      />
      <textarea
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
        placeholder="Raw text / notes (optional, up to 256KB)"
        style={{ ...inputStyle, minHeight: 80, fontFamily: 'inherit' }}
        maxLength={262144}
        disabled={pending}
      />
      {otherTopics.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>Also tag:</span>
          {otherTopics.map((t) => {
            const checked = extraTags.has(t.slug);
            return (
              <label key={t.id} style={{ fontSize: 12, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setExtraTags((prev) => {
                      const next = new Set(prev);
                      if (checked) next.delete(t.slug);
                      else next.add(t.slug);
                      return next;
                    });
                  }}
                  style={{ marginRight: 4 }}
                  disabled={pending}
                />
                #{t.slug}
              </label>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" style={buttonPrimary} disabled={pending}>
          {pending ? 'Adding…' : 'Add source'}
        </button>
      </div>
      {error && <p style={errorText}>{error}</p>}
    </form>
  );
}

function truncateUrl(url: string): string {
  if (url.length <= 60) return url;
  return url.slice(0, 40) + '…' + url.slice(-15);
}

function errorLabel(code: string): string {
  switch (code) {
    case 'sign_in_required':
      return 'Please sign in again.';
    case 'forbidden':
      return 'You do not have access.';
    case 'not_found':
      return 'Not found.';
    case 'slug_taken':
      return 'You already have a topic with that slug.';
    case 'topic_limit_reached':
      return 'You already have 5 topics (maximum).';
    case 'invalid_topic':
      return 'Invalid topic.';
    case 'invalid_slug':
      return 'Slug must be 2–40 chars, lowercase letters, digits, _ or -.';
    case 'missing_title':
      return 'Title is required.';
    case 'title_too_long':
      return 'Title is too long.';
    case 'description_too_long':
      return 'Description is too long.';
    case 'topic_has_sources':
      return 'Remove all sources tagged with this topic first.';
    case 'topic_has_hooks':
      return 'This topic is referenced by a hook and cannot be deleted.';
    case 'source_quota_reached':
      return 'Source quota reached — delete older sources first.';
    case 'invalid_topic_tags':
      return 'One or more topic tags are not registered for your account.';
    case 'invalid_source':
      return 'Invalid source data.';
    case 'invalid_source_type':
      return 'Invalid source type.';
    case 'topic_tags_required':
      return 'At least one topic tag is required.';
    case 'raw_text_too_long':
      return 'Raw text is too long (max 256KB).';
    case 'url_too_long':
      return 'URL is too long.';
    case 'url_insecure_scheme':
      return 'URL must use https://.';
    case 'url_invalid_url':
      return 'URL is not valid.';
    case 'url_private_address':
      return 'URL points to a private or internal address.';
    case 'url_blocked_hostname':
      return 'URL hostname is not allowed.';
    case 'url_non_ascii_hostname':
      return 'URL hostname must be ASCII.';
    case 'url_empty_hostname':
      return 'URL has no hostname.';
    case 'url_userinfo_forbidden':
      return 'URL may not contain user:pass credentials.';
    case 'url_blocked_port':
      return 'URL must use the standard HTTPS port.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: '#0c0c0c',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  color: 'inherit',
  fontSize: 14,
};

const buttonPrimary: React.CSSProperties = {
  padding: '6px 14px',
  background: '#2a5bff',
  color: 'white',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
};

const buttonDanger: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  color: '#f07070',
  border: '1px solid #3a1010',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
};

const buttonGhost: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: '#999',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
};

const errorText: React.CSSProperties = {
  color: '#f07070',
  fontSize: 13,
  margin: 0,
};
