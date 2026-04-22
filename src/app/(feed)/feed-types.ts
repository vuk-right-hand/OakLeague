export type FeedItem = {
  hook_id: string;
  video_id: string;
  creator_id: string;
  creator_handle: string;
  creator_name: string;
  creator_avatar: string | null;
  video_title: string;
  lesson_number: number;
  hook_title: string | null;
  hook_caption: string | null;
  hook_transcript: string | null;
  topic_tags: string[];
  mux_playback_id: string;
  mux_aspect_ratio: string | null;
  mux_duration_ms: number | null;
  duration_seconds: number | null;
  opening_prompt: string | null;
  question_seeds: unknown;
  hook_created_at: string;
};

export type WelcomeHook = {
  id: string;
  creator_id: string;
  video_id: string | null;
  mux_playback_id: string;
  mux_aspect_ratio: string | null;
  mux_duration_ms: number | null;
  duration_seconds: number | null;
  transcript: string | null;
  active: boolean;
};

export type FeedCursor = {
  cursor_created_at: string;
  cursor_id: string;
};

export type VideoGroup = {
  videoId: string;
  creator: {
    id: string;
    handle: string;
    name: string;
    avatar: string | null;
  };
  title: string;
  items: FeedItem[];  // sorted by lesson_number asc
};

export function groupByVideo(items: FeedItem[]): VideoGroup[] {
  const map = new Map<string, VideoGroup>();
  for (const it of items) {
    let group = map.get(it.video_id);
    if (!group) {
      group = {
        videoId: it.video_id,
        creator: {
          id: it.creator_id,
          handle: it.creator_handle,
          name: it.creator_name,
          avatar: it.creator_avatar,
        },
        title: it.video_title,
        items: [],
      };
      map.set(it.video_id, group);
    }
    group.items.push(it);
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => a.lesson_number - b.lesson_number);
  }
  return Array.from(map.values());
}
