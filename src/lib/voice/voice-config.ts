// R3-C2 (sec) — single source of truth for VOICE_CARTESIA_ENABLED.
//
// The Fly voice-proxy reads VOICE_CARTESIA_ENABLED from its own env and
// routes traffic accordingly. The Next.js side needs to know whether to
// pre-flight gate at /api/sessions/open (return 409
// `creator_voice_not_trained` when α' is on but creator.voice_id IS NULL).
//
// Two flags = two source of truth = drift bug. Round-3 audit R3-C2 caught
// this. Resolution: the proxy is the authority. Vercel polls the proxy's
// /voice-config endpoint and caches the answer for 60s. If the proxy is
// unreachable, fail-open (don't pre-gate) — the proxy will still issue
// the proper 4009 close on WS open if α' is on, so the user-facing
// outcome is at most a slightly worse error path during a brief outage.
//
// VOICE_PROXY_URL must be set on Vercel as the WSS URL of the Fly proxy
// (e.g., wss://oakleague-voice-proxy.fly.dev). We swap the protocol +
// path for the healthz fetch.

let _cache: { useCartesia: boolean; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

function buildConfigUrl(): string | null {
  const wsUrl = process.env.NEXT_PUBLIC_VOICE_PROXY_URL || process.env.VOICE_PROXY_URL || '';
  if (!wsUrl) return null;
  // wss://oakleague-voice-proxy.fly.dev/voice/spike-a → https://oakleague-voice-proxy.fly.dev/voice-config
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/voice-config';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Returns whether Cartesia α' is currently enabled on the proxy.
 * Cached 60s. On any error (proxy unreachable, malformed body, env unset),
 * returns `false` — the pre-WS gate at /api/sessions/open is just an
 * optimization; the proxy's 4009 close at WS-open is the actual gate.
 */
export async function getProxyVoiceConfig(): Promise<{ useCartesia: boolean }> {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return { useCartesia: _cache.useCartesia };
  }
  const url = buildConfigUrl();
  if (!url) {
    _cache = { useCartesia: false, fetchedAt: now };
    return { useCartesia: false };
  }
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 2000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) throw new Error(`status=${res.status}`);
    const body = (await res.json()) as { useCartesia?: unknown };
    const useCartesia = body?.useCartesia === true;
    _cache = { useCartesia, fetchedAt: now };
    return { useCartesia };
  } catch {
    // Fail-open: proxy unreachable. Cache `false` for a short window so we
    // don't hammer the proxy on every session-open during an outage.
    _cache = { useCartesia: false, fetchedAt: now - (CACHE_TTL_MS - 5_000) };
    return { useCartesia: false };
  }
}

/** Test-only — flush the cache so a fresh fetch happens. */
export function _resetVoiceConfigCache() {
  _cache = null;
}
