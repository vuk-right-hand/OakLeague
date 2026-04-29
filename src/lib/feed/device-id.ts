'use client';

import { useEffect, useState } from 'react';

// Stable per-device id used by Mux Data for QoE bucketing across video
// surfaces (feed hooks AND long-form viewer). Without this, all anon
// viewers collapse into a single Mux Data viewer_user_id and QoE charts
// can't tell tab-A from tab-B. Persisted in localStorage so the value
// survives session restarts; scope is the browser profile.
export function useDeviceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    try {
      let existing = localStorage.getItem('oak_device_id');
      if (!existing) {
        existing = `anon_${crypto.randomUUID()}`;
        localStorage.setItem('oak_device_id', existing);
      }
      setId(existing);
    } catch {
      setId(null);
    }
  }, []);
  return id;
}
