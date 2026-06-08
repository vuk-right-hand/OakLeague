// R3-C2 (sec) — single source of truth for VOICE_TTS_LAYER_ENABLED.
// HUME_TTS_PLAN §6.2 + FISH_AUDIO_PHASE_1 §6 — extended to surface
// `ttsProvider` ∈ ('cartesia' | 'hume' | 'fish').
//
// 2026-05-14 rename: env var + field was VOICE_CARTESIA_ENABLED / useCartesia,
// renamed to VOICE_TTS_LAYER_ENABLED / useTtsLayer because the flag actually
// gates the "α' TTS layer is on" bit (Cartesia OR Hume), not Cartesia
// specifically. Probe accepts BOTH keys from the proxy response during the
// migration window — old Fly deploys keep returning `useCartesia`.
//
// The Fly voice-proxy reads VOICE_TTS_LAYER_ENABLED + VOICE_TTS_PROVIDER from
// its own env and routes traffic accordingly. The Next.js side needs to know
// (a) whether to pre-flight gate at /api/sessions/open (return 409
// `creator_voice_not_trained` when α' is on but the env-scoped voice column
// is NULL), and (b) which TTS provider to inherit when `creators.tts_provider`
// is NULL.
//
// Two flags = two sources of truth = drift bug. Round-3 audit R3-C2 caught
// this. Resolution: the proxy is the authority. Vercel polls the proxy's
// /voice-config endpoint and caches the answer for 60s. If the proxy is
// unreachable, fail-open (`useTtsLayer=false`, `ttsProvider='cartesia'`) —
// the proxy's WS-open close codes are the actual gate.
//
// VOICE_PROXY_URL must be set on Vercel as the WSS URL of the Fly proxy
// (e.g., wss://oakleague-voice-proxy.fly.dev). We swap the protocol +
// path for the healthz fetch.

export type ProxyVoiceConfig = {
  useTtsLayer: boolean;
  ttsProvider: 'cartesia' | 'hume' | 'fish';
  // HUME_TTS_PLAN §6 audit M5 — true when this value is the fail-open
  // fallback (proxy unreachable, env unset, malformed body). The caller
  // can choose to 503 instead of silently using the fallback. Bridge
  // routing decisions during failOpen=true risk a cartesia ticket for a
  // hume-overridden creator → 4009 at WS open.
  failOpen: boolean;
};

let _cache: { value: ProxyVoiceConfig; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;
// Audit M5 (§6 unit-wide) — a fail-open cache entry is held for a SHORTER
// window (5s) than a successful probe (60s). Prior behavior cached the
// fail-open value for the full 60s window (with a backdated fetchedAt
// that effectively gave it ~55s), which amplified a short proxy outage
// into a deterministic-route bug for the whole window. With a 5s TTL,
// the next request re-probes the proxy and surfaces live state quickly.
const FAIL_OPEN_CACHE_TTL_MS = 5_000;

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

function failOpen(): ProxyVoiceConfig {
  return { useTtsLayer: false, ttsProvider: 'cartesia', failOpen: true };
}

/**
 * Returns the proxy's live voice-config. Cached 60s. On any error (proxy
 * unreachable, malformed body, env unset), returns the fail-open default
 * (`useTtsLayer=false`, `ttsProvider='cartesia'`) — the pre-WS gate at
 * /api/sessions/open is just an optimization; the proxy's 4009/4014 close
 * at WS-open is the actual gate.
 */
export async function getProxyVoiceConfig(): Promise<ProxyVoiceConfig> {
  const now = Date.now();
  if (_cache) {
    const ttl = _cache.value.failOpen ? FAIL_OPEN_CACHE_TTL_MS : CACHE_TTL_MS;
    if (now - _cache.fetchedAt < ttl) return _cache.value;
  }
  const url = buildConfigUrl();
  if (!url) {
    const value = failOpen();
    _cache = { value, fetchedAt: now };
    return value;
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
    const body = (await res.json()) as { useTtsLayer?: unknown; useCartesia?: unknown; ttsProvider?: unknown };
    // Accept new key first, fall back to legacy `useCartesia` for old Fly deploys.
    const useTtsLayer = body?.useTtsLayer === true || body?.useCartesia === true;
    const rawProvider = typeof body?.ttsProvider === 'string' ? body.ttsProvider : '';
    // FISH_AUDIO_PHASE_1 §6 — 3-arm allowlist. Audit M4: a non-empty
    // rawProvider that isn't in the allowlist (proxy bug, version skew,
    // typo) MUST trigger failOpen — silently coercing 'cartersia' (typo)
    // to 'cartesia' would mask a real configuration drift and bill
    // sessions against the wrong provider. Empty string keeps the
    // pre-existing "default to cartesia" semantic for older proxies that
    // didn't return ttsProvider at all.
    if (rawProvider !== '' && rawProvider !== 'cartesia' && rawProvider !== 'hume' && rawProvider !== 'fish') {
      const value = failOpen();
      _cache = { value, fetchedAt: now };
      return value;
    }
    const ttsProvider: 'cartesia' | 'hume' | 'fish' =
      rawProvider === 'hume' ? 'hume'
      : rawProvider === 'fish' ? 'fish'
      : 'cartesia';
    const value: ProxyVoiceConfig = { useTtsLayer, ttsProvider, failOpen: false };
    _cache = { value, fetchedAt: now };
    return value;
  } catch {
    // Audit M5 — surface failOpen=true so callers can 503 instead of
    // silently routing to a possibly-wrong provider. Short-cache the
    // fallback (5s) so the next request re-probes the proxy.
    const value = failOpen();
    _cache = { value, fetchedAt: now };
    return value;
  }
}

/** Test-only — flush the cache so a fresh fetch happens. */
export function _resetVoiceConfigCache() {
  _cache = null;
}
