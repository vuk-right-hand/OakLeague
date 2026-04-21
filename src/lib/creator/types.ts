// Hand-authored because Supabase client is typed as `any` in v1 (see
// src/lib/supabase/*.ts). Casting at the DB-read boundary is what makes the
// exhaustive `switch` on BrainStatus a real compile-time check.

export type BrainStatus = 'pending' | 'queued' | 'training' | 'ready' | 'errored';

export type SampleSourceType =
  | 'youtube'
  | 'transcript'
  | 'book_or_doc'
  | 'mastermind_or_course'
  | 'testimonial';

export type CreatorRow = {
  id: string;
  user_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  brain_status: BrainStatus;
  published_at: string | null;
};

export type CreatorTopicRow = {
  id: string;
  creator_id: string;
  slug: string;
  title: string;
  description: string | null;
  sort_order: number;
  created_at: string;
};

export type SampleContentRow = {
  id: string;
  creator_id: string;
  source_type: SampleSourceType;
  title: string | null;
  source_url: string | null;
  raw_text: string | null;
  topic_tags: string[];
  fetch_status: BrainStatus;
  created_at: string;
};

export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${String(x)}`);
}
