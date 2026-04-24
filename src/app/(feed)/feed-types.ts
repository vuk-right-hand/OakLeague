import type { FeedHook } from '@/types/feed';

export type FeedItem = FeedHook;

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
