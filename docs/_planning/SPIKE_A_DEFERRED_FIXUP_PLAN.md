# Spike-A Deferred Fixup — Plan REV 5

REV 4 audit: 4 critical, 7 important, 9 light. All 20 folded into REV 5. Direction changes from REV 4:

- **§1A.1 file map rewritten** (C-A). REV 4 named `cogs-operations.ts` as an aggregation site — verified, it's a 39-line static allowlist. Aggregation lives inline in the route handlers. New file map below.
- **`cogs_failed` reducer action added explicitly** (C-B). Verified: `session-reducer.ts` has `fatal_error` and `ws_closed{wasClean}` but no `session_error`. Plan now adds a real action + reducer case + UI copy.
- **Factory signature reshaped** (C-C). `makeLogTurnCogs({supabase, env, onConsecutiveFailure})` so per-session counter + WS-close hook can both be tested.
- **Phase 0 disambiguation query added** (C-D). Sibling query counts gemini cogs rows by date regardless of metadata shape, so "0 truth rows" can be distinguished from "Gemini stopped shipping responseTokenCount."
- **Phase 0 gate is now finding-based, not time-based** (I-A). Specific branches require explicit Vuk-go; others auto-proceed after 5 min.
- **Reaper cadence test tests the *interval*, not the const** (I-B). `installReaper()` returns the interval handle; test inspects the underlying delay.
- **§1A.2 brownout UX risk acknowledged + quantified**. Per-session counter resets on success; sustained Supabase brownout can kill multiple sessions in a row — Sentry rule pages Vuk; manual kill-switch-bypass env var documented.
- **§3D scaling-guard CI grounded in reality** (I-F). No `.github/workflows` exists — REV 5 either wires one (~15 min) or explicitly downgrades §3D to a code-review checklist line. Plan picks: wire one. Realistic time +15 min.
- **Time estimate corrected to 15–17h** (REV 4's 11–13h was optimistic).
- **Aggregator stays deleted** (REV 2 → REV 3 decision unchanged).
- **Reaper threshold stays at 60s** with corrected structural justification (REV 4's I-D).
- **Items #2 and #5 stay re-opened as deferred** (M6, M7 — unchanged).

---

## Item status (verified against code)

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | `mic-processor.js` carry logic | NOT FIXED — live-path | [mic-processor.js:43](../../public/worklets/mic-processor.js#L43); [use-session-pipe.ts:469-471](../../src/app/s/[id]/use-session-pipe.ts#L469-L471) |
| 2 | iOS TTS via MSE/SourceBuffer | DEFERRED until Cartesia is in the data path | Today: Gemini bytes → Simli directly at [use-session-pipe.ts:213-214](../../src/app/s/[id]/use-session-pipe.ts#L213-L214). Pipeline α' aspirational. |
| 3 | Priming Window primitive | DEFERRED + dead interface deletion | `seedContents()` declared, never implemented. Phase 3 deletes the interface member. |
| 4 | `session_turns` write amplification | WONTFIX — needs batch RPC | One `cogs_insert_turn_voice` per turn is the current contract. In-memory aggregation without a batch RPC reduces nothing. Re-open when a batch RPC variant exists. |
| 5 | `daily_quotas.day_utc` GENERATED + index | RE-OPENED — kill-switch still reads `daily_quotas` | [kill-switch.ts:42-57](../../src/lib/voice/kill-switch.ts#L42-L57) reads `seconds_used`, `daily_limit_s`, `kill_switch_fired_at`. Not superseded. |
| 6 | Ghost-session reaper | PARTIAL — needs cadence tighten, not just threshold | [index.js:485](../../server/voice-proxy/index.js#L485) cadence = 60s; [index.js:284](../../server/voice-proxy/index.js#L284) override = 90s. Both must change. |
| 7 | COGS pricing seconds → tokens | DRIFTED — `cogs_insert_turn` was dropped by [migration 0055](../../supabase/migrations/20260428000001_cogs_insert_turn_voice.sql); proxy still calls it at [index.js:173](../../server/voice-proxy/index.js#L173) | If 0055 applied to prod, COGS has been silently broken (try/catch swallows errors at [index.js:172-192](../../server/voice-proxy/index.js#L172-L192)). |

---

## Phase 0 — Verify the COGS drift (must run first, gated)

Goal: settle whether item #7 is a P0 hotfix or a routine cutover, plus pull two numbers we'll need for Phase 1A.

### 0.1 — Queries (Vuk runs; agent does not have prod credentials)

**Vuk runs these manually**. Agent waits for results before starting Phase 1.

**A. Supabase dashboard → SQL editor → prod project** (Vuk's normal path):
```sql
-- A1. Function presence
SELECT proname, pronargs
  FROM pg_proc
 WHERE proname IN ('cogs_insert_turn', 'cogs_insert_turn_voice');

-- A2. Migration apply timestamp
SELECT version, name, executed_at
  FROM supabase_migrations.schema_migrations
 WHERE version LIKE '20260428000001%'
 ORDER BY executed_at DESC LIMIT 1;

-- A3. Empirical tokens-per-second from existing truth rows (drives the
-- GEMINI_TOKENS_PER_SEC_FALLBACK constant per REV 3 I-9). The proxy today
-- writes metadata.source='spike_a' and nests usage as metadata.usage.<key>;
-- rows present iff the bridge surfaced finite responseTokenCount on that turn.
SELECT
  count(*) AS truth_rows,
  avg((metadata->'usage'->>'responseTokenCount')::numeric / NULLIF(units, 0)) AS avg_tokens_per_sec,
  stddev_pop((metadata->'usage'->>'responseTokenCount')::numeric / NULLIF(units, 0)) AS stddev_tokens_per_sec
  FROM cogs_log
 WHERE service = 'gemini'
   AND operation = 'voice_audio_output_seconds'
   AND metadata->'usage'->>'responseTokenCount' ~ '^[0-9]+$'
   AND units > 0
 ORDER BY created_at DESC
 LIMIT 1000;

-- A4. (REV 5 / C-D) Disambiguation: how many gemini cogs rows exist regardless
-- of metadata shape, by day for the last 14 days. If A3 returns 0 truth_rows,
-- A4 tells us whether the cause is "no cogs writes at all" (proxy broken since
-- 0055 applied — see A1+A2) vs. "cogs writes exist but usage metadata went
-- silent" (Gemini API regression). Different fallback strategies for each.
SELECT
  date_trunc('day', created_at)::date AS day,
  count(*)                            AS total_rows,
  count(*) FILTER (WHERE metadata->'usage'->>'responseTokenCount' ~ '^[0-9]+$') AS rows_with_token_count,
  count(*) FILTER (WHERE metadata->>'source' = 'spike_a')                      AS spike_a_rows
  FROM cogs_log
 WHERE service = 'gemini'
   AND created_at >= now() - interval '14 days'
 GROUP BY 1
 ORDER BY 1 DESC;

-- A5. (REV 5 / I-C) Per-token rate verification — Vuk pastes from Google's
-- pricing page directly into findings. No SQL; just a checklist line.
--   URL: https://ai.google.dev/pricing  (3.1 Flash Live → audio output → $/token)
```

**B. Sentry web UI → oakleague-voice-proxy project** (Vuk's normal path):
- Issues filter: `error.type:PostgrestError* OR message:*cogs_insert_turn*`
- Time range: 14d
- Group by day; capture exception count per day.

### 0.2 — Findings format

Vuk reports back:
```
{
  cogs_insert_turn present?       Y/N         (A1)
  cogs_insert_turn_voice present? Y/N         (A1)
  0055 applied at:                <ISO date or 'not applied'>  (A2)
  sentry exceptions/day (14d):    [d1: N, d2: N, ...]
  broken-window-days:             N
  empirical tokens/sec mean:      <number or 'no data'>   (A3)
  empirical tokens/sec stddev:    <number>                (A3)
  gemini cogs rows by day:        [d1: total/with-token, ...]   (A4)
  per-token rate from price card: <USD per token>         (A5)
  rate-card URL+date snapshot:    <URL, fetched <date>>    (A5)
}
```

### 0.3 — Decision matrix

- **`cogs_insert_turn` absent + Sentry shows exceptions** → P0. COGS broken in prod since 0055 applied. Phase 1A ships immediately as the single hotfix.
- **`cogs_insert_turn` absent + Sentry clean** → either 0055 hasn't actually fired any cogs writes (proxy idle), OR the try/catch swallowed enough to mask it. Same fix path; no urgency change but flag the Sentry/proxy disconnect.
- **`cogs_insert_turn` present** → 0055 is unapplied. Routine cutover; Phase 1A still ships in this PR alongside the migration apply.
- **Empirical tokens/sec available** → use it for `GEMINI_TOKENS_PER_SEC_FALLBACK` (I-9). If <100 truth rows, default to 50 with a `metadata.fallback_constant_source='default-50'` tag so we can see the imprecision in the dashboard.
- **No truth rows yet** → 50 is a placeholder; Phase 1A's deploy is the moment we *start* collecting truth rows. Re-derive after 7 days; file follow-up to update the env var if empirical mean diverges from 50 by >25%.

### 0.4 — Compute COGS data-loss scope

`turns × creators` over the broken window. v1 default: do **not** backfill. Admin dashboards re-aggregate from existing rows; gap is annotated in the dashboard. Re-decide if window > 7 days (Vuk's call).

### 0.5 — Phase 0 → Phase 1 gate (I-4 + REV 4 audit I-A: gate on findings, not time)

Vuk's standing instruction: "fix all of these today." But the convenience-of-auto-proceed varies by what Phase 0 surfaces. Decision tree:

| Finding pattern | Gate |
|---|---|
| `cogs_insert_turn` absent **AND** Sentry shows >0 exceptions/day for ≥1 of last 7 days | **Explicit Vuk-go required.** Broken in prod for at least N days; needs rollback-vs-patch-forward discussion. |
| `cogs_insert_turn` absent **AND** Sentry clean | **Explicit Vuk-go required.** The combination is suspicious (proxy should have errored if it tried to call). Likely indicates the proxy hasn't run in N days OR Sentry is misconfigured. |
| `cogs_insert_turn` present (0055 unapplied) | **5-min auto-proceed.** Routine cutover; agent ships Phase 1 in the same PR as the migration apply. |
| A4 shows total_rows > 0 but rows_with_token_count = 0 for >7 days | **Explicit Vuk-go required.** Gemini may have stopped shipping `responseTokenCount`; fallback constant decision changes. |
| Per-token rate from A5 differs from `0.000010` placeholder by >20% | **Explicit Vuk-go required.** Pricing constant must be re-pinned before deploy. |
| All other branches | **5-min auto-proceed.** |

When auto-proceeding, agent posts findings + a "proceeding to Phase 1 in 5 min" message; Vuk can `/halt` (or just type) to interrupt.

### 0.6 — Atomic-redeploy contract (M1)

Phase 1 proxy patches ship as a single Fly machine update. There is no path that leaves prod COGS broken longer — if Phase 0 finds `cogs_insert_turn` absent, Phase 1A is the only fix and ships immediately. The deploy unit is `1A + 1A.1 + 1A.2 + 1B + 1D tests` — all-or-nothing.

Time: **20 min Vuk-execution + 5-min gate + 5 min agent-side analysis = ~30 min wall-clock**.

---

## Phase 1 — Proxy-side fixes (one PR)

Files: `server/voice-proxy/index.js`, no SQL migrations.

### 1A.0 — Refactor: extract testable handlers (I-2 + REV 4 C-C signature redesign)

Today, `logTurnCogs`, `runReaper`, `checkQuotaOk`, `accumulateSeconds` and friends are top-level functions in `server/voice-proxy/index.js` but **not exported**. The Phase 1D regression-guard tests cannot be written without them being importable.

Refactor:
- Create `server/voice-proxy/proxy-handlers.js` exporting:
  - **`makeLogTurnCogs({ supabase, env, onConsecutiveFailure })`** → returns `logTurnCogs(payload)` closure. The factory **owns** the per-session consecutive-failure counter (Map<sessionId, count>); when count hits 3, it invokes `onConsecutiveFailure(sessionId)` (which `index.js` wires to `closeWs(ws, 1011, 'cogs_rpc_failed')`). On a successful turn, counter resets to 0. Idle turns don't increment.
  - **`makeRunReaper({ supabase })`** → returns `runReaper()` closure.
  - **`installReaper({ supabase, intervalMs = REAPER_CADENCE_MS })`** → wires the `setInterval`, returns the interval handle. Tests inspect `handle._idleTimeout` (Node internal, ugly but works) to assert the actual delay. (REV 4 I-B fix.)
  - `REAPER_CADENCE_MS = 20_000` exported const.
  - Pricing constants block from §1A above.
- `index.js` imports + wires them up. Per-session WS-close hook plumbed: `makeLogTurnCogs({ supabase, env, onConsecutiveFailure: sessionId => closeWs(sessionToWs.get(sessionId), 1011, 'cogs_rpc_failed') })`. Requires a `sessionToWs` Map maintained on connection-open and removed on close — currently implicit in the connection-scoped closures of `wss.on('connection', ...)`. Add an explicit `Map<sessionId, ws>` at module level.
- Tests import the factory functions, pass a mock supabase client (`{ rpc: jest.fn(), from: ... }`) AND a mock `onConsecutiveFailure` callback, invoke the returned handler, and inspect both.

**Realistic scope** (REV 4 C-C):
- Handler extraction itself: ~30 min (logTurnCogs/runReaper transitively only depend on supabase + captureException).
- Per-session counter + `sessionToWs` Map plumbing: ~30 min.
- Integration in `index.js` (rewiring the `wss.on('connection')` handler to register/unregister in `sessionToWs`): ~30 min.
- **Total: ~1.5h, not 30 min.** Honest estimate beats optimism at hour 14.

Not optional — without it, §1D regression guards cannot exist.

### 1A — Item #7: switch to `cogs_insert_turn_voice`

Verified signature (parameters in this exact order):
```
p_user_id uuid, p_session_id uuid, p_turn_number int,
p_gemini_audio_in_seconds  numeric, p_gemini_audio_in_cost  numeric,
p_gemini_audio_out_tokens  int,     p_gemini_audio_out_cost numeric,
p_cartesia_characters      int,     p_cartesia_cost         numeric,
p_cartesia_audio_seconds   numeric,
p_environment text, p_metadata jsonb
```

#### Pricing constants (M2 — `QUOTED_AT` pinned; I-9 — fallback constant derived)
Add to `server/voice-proxy/proxy-handlers.js` (the new module created by §1A.0 below), replacing the deleted `PRICE_USD_PER_SEC` at [index.js:56](../../server/voice-proxy/index.js#L56):
```js
// QUOTED_AT = 2026-04-30 — Gemini 3.1 Flash Live preview rate card.
// Source: https://ai.google.dev/pricing (audio-in priced per second; audio-out
// priced per output token in 3.1 Live. Verify on every model bump.)
const PRICING_QUOTED_AT = '2026-04-30';
const GEMINI_INPUT_USD_PER_SEC           = Number(process.env.GEMINI_INPUT_USD_PER_SEC           ?? 0.005 / 60);
const GEMINI_OUTPUT_USD_PER_TOKEN        = Number(process.env.GEMINI_OUTPUT_USD_PER_TOKEN        ?? 0.000010);
const GEMINI_OUTPUT_USD_PER_SEC_FALLBACK = Number(process.env.GEMINI_OUTPUT_USD_PER_SEC_FALLBACK ?? 0.018 / 60);
// I-9: derived from Phase 0.1's empirical query when ≥100 truth rows exist.
// Default 50 is a placeholder for cold-start; tagged in metadata as
// 'fallback_constant_source' so the dashboard exposes the imprecision.
const GEMINI_TOKENS_PER_SEC_FALLBACK     = Number(process.env.GEMINI_TOKENS_PER_SEC_FALLBACK     ?? 50);
```

The per-token rate (`GEMINI_OUTPUT_USD_PER_TOKEN = 0.000010`) is a placeholder — Vuk pins from the rate card before deploy. Phase 0.1 confirms the actual number; if it diverges from `0.000010` by more than 20%, halt and re-quote.

#### Leg mapping

- **Leg 1 (Gemini audio-in seconds)**: `p_gemini_audio_in_seconds = inputSeconds`, `p_gemini_audio_in_cost = inputSeconds × GEMINI_INPUT_USD_PER_SEC`. Audio-in stays seconds-based — `usageMetadata.promptTokenCount` is text-equivalent and unreliable for audio-in.
- **Leg 2 (Gemini audio-out tokens)**: `usageMetadata.responseTokenCount` is the source of truth. Match the existing `Number.isFinite` gate at [index.js:166-170](../../server/voice-proxy/index.js#L166-L170) exactly:
  ```js
  const tokensTruth =
    usageMetadata && Number.isFinite(usageMetadata.responseTokenCount)
      ? usageMetadata.responseTokenCount
      : null;
  ```
  - **Truth path**: `p_gemini_audio_out_tokens = tokensTruth`, `p_gemini_audio_out_cost = tokensTruth × GEMINI_OUTPUT_USD_PER_TOKEN`. Metadata: `{ leg: 'gemini_audio_out' }` — RPC adds the rest.
  - **Fallback path** (C1, C2): when `tokensTruth === null`, derive tokens from seconds and tag with a **distinct operation string**. The leg-2 RPC parameter name doesn't change (still `p_gemini_audio_out_tokens`) but we write a synthetic value with provenance:
    ```js
    const tokensFallback = Math.round(outputSeconds * GEMINI_TOKENS_PER_SEC_FALLBACK);
    const costFallback   = outputSeconds * GEMINI_OUTPUT_USD_PER_SEC_FALLBACK;
    // Metadata gates the dashboard distinction:
    metadata.fallback = 'seconds';
    metadata.fallback_seconds = outputSeconds;
    metadata.fallback_tokens_per_sec = GEMINI_TOKENS_PER_SEC_FALLBACK;
    metadata.quoted_at = PRICING_QUOTED_AT;
    ```
  - **Why not a separate operation string at the SQL level**: the `cogs_insert_turn_voice` RPC hardcodes `operation = 'voice_audio_out_tokens'` for leg 2 ([migration 0055 line 133](../../supabase/migrations/20260428000001_cogs_insert_turn_voice.sql#L133)). We'd need a migration to add a second operation enum value. **Decision**: keep the operation string the same, gate the dashboard via `metadata->>'fallback'` (1A.1 below).
  - **Follow-up trigger** (L-2, hardened): file a migration to split the operation string when fallback-rate is **>5% sustained for 24h** OR **cumulative fallback-row count exceeds 1000**. Either condition = real signal Gemini's `usageMetadata` is unreliable for this model; cumulative threshold prevents a 4%-forever steady state from going untracked.

- **Leg 3 (Cartesia chars)** and **Leg 4 (Cartesia seconds)**: Cartesia is **not** in the proxy or the client data path today. Pass:
  ```js
  p_cartesia_characters: 0,
  p_cartesia_cost: 0,
  p_cartesia_audio_seconds: 0,
  metadata: { ..., cartesia_pending: true }
  ```
  See "Cartesia leg deferral spec" below.

- **Delete `PRICE_USD_PER_SEC`** at [index.js:56](../../server/voice-proxy/index.js#L56). Explicit line for the patch.

#### 1A.1 — Dashboard fallback-row gating (REV 4 C-A: file map rewritten)

REV 4 named `src/lib/admin/cogs-operations.ts` as an aggregation site. **Verified — that file is a 39-line static allowlist of services and operations, no aggregation.** Aggregation lives inline in the route handlers. Real file map:

| File | Edit | Notes |
|---|---|---|
| `src/app/api/admin/cogs/live/route.ts` | Extend the `byId` Map fold around line 102-112: split per-session `voice_turn_cost_usd` into `truth` + `fallback`; compute `fallback_rate` for leg-2 rows; return both fields | The route already has aggregation; widen the `Agg` type and the fold |
| `src/app/api/admin/cogs/historical/route.ts` | Add `metadata` to the SELECT projection (currently absent — verified at `CogsRow` type lines 37-48); extend `SummaryRow` with `truth/fallback split`; widen the by-operation aggregation; gate `summary_truncated` correctly | Bigger lift than `live`: the SELECT projection change cascades through the row type, the response shape, and the cap-at-10k truncation logic |
| `src/app/admin/cogs/cogs-dashboard.tsx` | Render headline as truth-only sum; add badge `est. $X.XX from N fallback turns` next to each session row when `fallbackRate > 0`; add a small color/icon when `fallbackRate > 0.05` | UI-only after the API returns the new fields |
| `src/lib/admin/cogs-operations.ts` | **No edit needed.** This file is allowlist-only. Removed from REV 4's edit list. | |
| `src/app/api/admin/cogs/live/__tests__/route.test.ts` (new) | Asserts split-by-fallback aggregation correctness | Mock the supabase client; feed mixed truth+fallback rows; assert response shape |
| `src/app/api/admin/cogs/historical/__tests__/route.test.ts` (new) | Same, with paginated/capped scenarios | |

Behavior:
- Headline cost number = sum of `cost_usd` WHERE `metadata->>'fallback' IS NULL` (truth rows only).
- `fallbackRate` per session: `count(*) WHERE metadata->>'fallback' = 'seconds'` ÷ `count(*)` for leg-2 rows (`operation = 'voice_audio_out_tokens'`).
- Sentry breadcrumb if `fallbackRate > 0.05` on any session — flags a Gemini API regression where `usageMetadata` stops shipping.
- **Cartesia-pending row handling** (REV 4 I-E): rows with `metadata->>'cartesia_pending' = 'true'` have `cost_usd=0` so they don't inflate the dollar figure. But they DO show up in `turn_rows` counts (live route line 132). To prevent admin confusion: rename the field from `turn_rows` → `cogs_rows`, AND add a separate `cartesia_pending_rows` count. Display: "5 turns / 20 cogs rows / 10 pending Cartesia". Honest about what we're counting.

Phase 1 deliverable. Without it, leg-2 fallback writes silently corrupt the YC-demo cost number.

**Time**: **~3h** for the 3-file route+UI change + 2 new test files (REV 4 C-A re-estimate).

#### 1A.2 — Stop swallowing the cogs RPC error (REV 4 C-B reducer wiring + UX brownout note)

CLAUDE.md "Voice" §: *"Don't silently catch exceptions in voice connect."* Today's `logTurnCogs` catches and logs to Sentry only. Replace with:

- **On RPC error**: `captureException` (Sentry) + `console.error`. No prom-client / statsd surface exists in the proxy today (verified: not in `package.json`), so failure-count tracking lives in Sentry breadcrumbs only — drop the "Fly metric" language from REV 3 (I-5).
- **WS close trigger** (I-3, sharpened): close WS with `1011, reason='cogs_rpc_failed'` after **3 consecutive turns where the cogs RPC errored**. Idle turns and turns where COGS write succeeded reset the counter to 0. Counter is per-session (held inside the `makeLogTurnCogs` factory closure per §1A.0). A flaky session doesn't kill the whole proxy.
- **Client behavior on `1011 cogs_rpc_failed`** (REV 4 C-B — verified `session-reducer.ts` has no `session_error` action):

  Add to `src/app/s/[id]/session-reducer.ts`:
  ```ts
  | { kind: 'cogs_failed' }   // 1011 'cogs_rpc_failed' from proxy: terminal, retry-OK
  ```
  Reducer transition: `cogs_failed` → terminal `closed` state with `errorMessage = "Cost accounting is unavailable. Please retry in a moment."` (distinct from `fatal_error`'s message; surfaces in the existing UI overlay).

  Wiring in `src/app/s/[id]/use-session-pipe.ts` (the WS `onclose` handler): inspect `event.code === 1011 && event.reason === 'cogs_rpc_failed'` → dispatch `{kind: 'cogs_failed'}` instead of the generic `ws_closed`. Otherwise fall through to existing `ws_closed{wasClean}`. (REV 4 C-B fix: existing reducer doesn't see code/reason, so we must dispatch a different action at the WS layer.)

  UI: existing terminal-error overlay surfaces with the new copy. Manual retry button re-mints a ticket and reopens the session — if the brownout has cleared, this works; if not, the same path repeats. We accept this looping over silently burning user quota with broken accounting.

  Time: ~1.5h (reducer test updates, action plumbing in `use-session-pipe.ts`, copy in the overlay component).

- **Brownout UX risk** (REV 4 light-finding): per-session counter resets on success but does NOT reset across sessions. Sustained Supabase brownout >10% means ~27% of sessions hit ≥3 consecutive failures → die. **Mitigation**: Sentry rule pages Vuk; manual escape hatch is `COGS_RPC_BYPASS_UNTIL=<ISO timestamp>` env var (proxy reads at start of each turn; if set and not expired, logs to Sentry but doesn't increment the failure counter, so sessions stay alive at the cost of accounting drift during the incident). Document the env var in `.claude_learnings.md` as an incident-response tool.

**Sentry alert rule (I-6 — manual post-deploy step)**: provisioning is dashboard config, not infra-as-code. Add to deploy checklist:
> [ ] In Sentry → oakleague-voice-proxy → Alerts → New rule: trigger when `tag:op = cogs_insert_turn_voice` events exceed **10 in 5 min**, page Vuk via PagerDuty integration. (Owner: Vuk; one-time setup at first deploy of this PR.)

**Post-deploy verification** (REV 4 light-finding): add `scripts/check-sentry-cogs-rule.mjs` that hits the Sentry API (`/api/0/projects/{org}/{proj}/rules/`) and exits non-zero if the rule isn't present. Run in the §1A.2 deploy checklist. Cheap insurance against forgetting the manual step.

This is the lever that prevents repeating today's "0055 applied, proxy broken, nobody noticed" scenario.

#### Cartesia leg deferral spec (M7-aligned)

Pipeline α' is not wired. Cartesia legs ship in a future phase ("D-α'-cutover"), spec:

- When the client switches from forwarding Gemini audio bytes → forwarding Gemini transcript text into Cartesia, the bridge that calls Cartesia POSTs `{session_id, turn_number, characters, audio_seconds, cost_usd}` to a new proxy endpoint `POST /cogs/cartesia-leg`.
- **Idempotency** (L-1): per-leg dedup is already provided by the partial unique index `cogs_log_turn_idempotency` ([migration 0055 line 24](../../supabase/migrations/20260428000001_cogs_insert_turn_voice.sql#L24)) on `(session_id, turn_number, service, operation) WHERE turn_number IS NOT NULL`. The endpoint can safely retry; the RPC's existing `ON CONFLICT ... DO NOTHING` clauses handle duplicates.
- Until D-α'-cutover ships, COGS dashboards filter `metadata->>'cartesia_pending' = 'true'` and label those turns "Cartesia pending — α' not yet wired."
- Owner: same engineer who lands the α' switch in `use-session-pipe.ts`. Tracking issue cross-referenced from this plan.

### 1B — Item #6: tighten reaper, real change this time (C3 + C-1 re-justified)

Two changes, not one:

1. **Cadence**: `setInterval(... runReaper, 60_000)` at [index.js:485](../../server/voice-proxy/index.js#L485) → `setInterval(... runReaper, 20_000)` (every 20s). Wired via `REAPER_CADENCE_MS` exported const from `proxy-handlers.js` (per §1A.0).
2. **Threshold**: drop the `90s` override at [index.js:284](../../server/voice-proxy/index.js#L284) → `supabase.rpc('reap_stale_sessions', {})` (RPC default = 60s).

Resulting max ghost life: 60s threshold + 20s cadence = **80s** (vs. today's 90 + 60 = 150s). Real improvement.

**Why threshold = 60s is safe (C-1, rewritten with REV 4 I-D correction)**: REV 3's "6×10s heartbeat math" was wrong — actual ping cadence is 20s ([index.js:405](../../server/voice-proxy/index.js#L405)), not 10s. The real argument is structural, not arithmetic:

- The **proxy itself** detects dead clients at 90s (3 missed pongs at [index.js:400](../../server/voice-proxy/index.js#L400)) and closes the WS with `1011 heartbeat_timeout`, which already updates `sessions.ended_at`.
- A live, healthy session updates `sessions.last_heartbeat_at` on every pong (every 20s). Threshold = 60s gives 3× headroom over the pong cadence; a single dropped pong won't reap.
- Setting threshold higher (e.g., 120s) would mean ghost sessions live up to ~140s — strictly worse with no real safety benefit.

**What the reaper actually protects against** (REV 4 I-D — REV 4's "exists for proxy crash" claim was sloppy because the reaper runs *inside* the proxy via `setInterval` at [index.js:485](../../server/voice-proxy/index.js#L485); a crashed proxy can't reap):

1. **Proxy noticing a dead client late** — heartbeat-timeout logic could be bypassed by a partial failure (e.g., a buggy `teardown()` path leaving the row in `status='active'`). Reaper catches it.
2. **`endSession()` itself failing silently** — see [index.js:131-158](../../server/voice-proxy/index.js#L131-L158). If the UPDATE returns 0 rows affected (RLS, race, etc.), the WS closes but the row stays open. Reaper catches it.
3. **Proxy crash + restart** — when Fly restarts the crashed machine, [index.js:484](../../server/voice-proxy/index.js#L484) runs `runReaper()` immediately on boot, sweeping ghost rows from the dead session. **This is the actual proxy-crash recovery mechanism, not the periodic reaper.** REV 4's confusion is corrected here.

So the reaper is a belt-and-suspenders for already-handled cases, plus a startup sweep after a crash. 60s threshold + 20s cadence is appropriate for that role.

[DAYS_8_12_VOICE_PLAN.md:198](DAYS_8_12_VOICE_PLAN.md#L198) reads "6× flush-interval safety margin with the new 10s heartbeat cadence" — that doc was written assuming a planned 10s pong cadence that was never shipped. **Both REV 3 and the planning doc are stale on the math.** Add a one-line correction to `DAYS_8_12_VOICE_PLAN.md:198` as part of this PR.

**RPC default stays 60s** (no migration). Floor guard stays at 30s. Cadence is independent of the threshold-vs-pong contract — it governs check frequency, not the staleness window.

### 1C — Item #4 disposition: WONTFIX, document why (C5)

REV 2 proposed an in-memory aggregator. The auditor's analysis is correct: with the current per-turn `cogs_insert_turn_voice` RPC, aggregation does not reduce DB round-trips and adds 4 failure modes (SIGTERM-flush timeout, crash window, reconnect-loss, test surface). **Drop the aggregator from this plan.**

Replace with:
- Close item #4 as `wontfix-needs-batch-rpc` in `.claude_learnings.md`.
- Open follow-up: design `cogs_insert_turn_voice_batch(p_turns jsonb)` that takes an array of turn payloads and writes them in one transaction. ON CONFLICT semantics carry over per-turn. Then aggregator becomes a real win.
- Until then: per-turn writes are the contract. The 1A.2 hardening (alert on cogs RPC failure rate) is sufficient back-pressure visibility.

### 1D — Tests for Phase 1 (I-1 + I-2 corrected)

Existing patterns: `server/voice-proxy/quota-gate.test.js`, `supabase/tests/*.test.sql`. Tests import the factory functions from `proxy-handlers.js` (per §1A.0); no proxy boot required.

**I-1 correction**: the migration's leg-2 INSERT merges proxy-supplied metadata with RPC-added keys ([migration 0055 line 135](../../supabase/migrations/20260428000001_cogs_insert_turn_voice.sql#L135)): `p_metadata || jsonb_build_object('leg', 'gemini_audio_out', 'pipeline', 'alpha_prime', 'audio_discarded', true)`. **Test assertions on the proxy RPC call inspect the `p_metadata` *parameter* (proxy-supplied keys only)**. Tests on the resulting `cogs_log` row (if any go end-to-end against a test DB) inspect the *merged* shape. Don't conflate the two layers.

| Test | File | Asserts |
|---|---|---|
| cogs RPC happy path | `voice-proxy/cogs-rpc.test.js` (new) | Factory `makeLogTurnCogs(mockSupabase, env)`'s closure calls `mockSupabase.rpc('cogs_insert_turn_voice', payload)` with verified parameter shape; truthy `usageMetadata.responseTokenCount` flows through as `p_gemini_audio_out_tokens`. Inspects `p_metadata` parameter only — does NOT assert the RPC-merged keys. |
| cogs RPC fallback path | same | When `usageMetadata` is null OR `responseTokenCount` non-finite, `p_gemini_audio_out_tokens = round(outputSeconds × 50)`, `p_metadata.fallback === 'seconds'`, `p_metadata.fallback_seconds === outputSeconds`, `p_metadata.quoted_at === '2026-04-30'` |
| cogs RPC partial usageMetadata | same | When only `totalTokenCount` is finite, leg 2 still falls back (we don't know in/out split). `Number.isFinite` gate is on `responseTokenCount` specifically. |
| cogs RPC name regression guard (M3) | same | Asserts call is `supabase.rpc('cogs_insert_turn_voice', ...)`, not legacy name |
| cogs RPC failure → WS close | same | After 3 consecutive turns where `mockSupabase.rpc` returns `{error}`, the WS-close hook is invoked with `1011, 'cogs_rpc_failed'`. Successful turn between failures resets the counter. |
| reaper RPC default-60s contract | `supabase/tests/reap_stale_sessions_default_60s.test.sql` (new) | `reap_stale_sessions()` with no args reaps rows older than 60s, leaves rows ≥31s younger |
| reaper proxy-call regression guard (M3) | `voice-proxy/reaper-call.test.js` (new) | Factory `makeRunReaper(mockSupabase)`'s closure calls `mockSupabase.rpc('reap_stale_sessions', {})` — empty/undefined args object. Catches future re-add of `{ p_threshold_seconds: 90 }`. |
| reaper cadence regression guard (REV 4 I-B) | same | Calls `installReaper({ supabase: mockSupabase })`; inspects returned interval handle's `_idleTimeout === 20_000`. Tests the *behavior* (actual setInterval delay), not just a constant. Cleanup: `clearInterval(handle)` in test teardown. |
| fallback default-50 source tag (REV 4 light) | `voice-proxy/cogs-rpc.test.js` | When `<100` truth rows pre-deploy, `p_metadata.fallback_constant_source === 'default-50'` — flagged via env var `GEMINI_TOKENS_PER_SEC_FALLBACK_SOURCE` at proxy boot |
| dashboard fallback gating | `src/lib/admin/__tests__/cogs-operations.test.ts` (new) | Headline cost excludes rows where `metadata->>'fallback'='seconds'`; `fallbackRate` field returned per session |

Skip-coverage: `gemini-bridge.test.js` continues to cover bridge mechanics.

**Test runner setup** (REV 4 I-G): `server/voice-proxy/package.json` currently has no `test` script. Add:
```json
"scripts": {
  "test": "node --test *.test.js"
}
```
Existing `quota-gate.test.js` already uses `node --test`; the new test files match. No new dependencies. Without this, the new tests are easily forgotten in pre-deploy checks.

### 1E — REMOVED (small finding 1)

REV 2 §1E mentioned a hypothetical migration filename. Phase 1 ships zero SQL migrations. Section deleted.

Time: **5–6 hours** including tests.

---

## Phase 2 — Mic-processor fix (separate PR)

### 2A — Item #1: extract decimation as pure JS, not TS (M4)

**Build mechanism** (M4): AudioWorklet modules cannot reliably `import` from `node_modules` or TS files in iOS Safari < 16.4. Pattern:

1. Write the pure function as **plain JS** in a new file: `public/worklets/mic-decimate.js`. ES module syntax (`export function`) — modern browsers + worklets support it; iOS 15.x is the lowest supported per CLAUDE.md.
2. `mic-processor.js` imports it at the top:
   ```js
   import { decimate3to1 } from './mic-decimate.js';
   ```
   Both files are static under `public/worklets/`. Next.js serves them as-is, no build step.
3. Tests: `src/lib/voice/__tests__/mic-decimate.test.ts` does `import { decimate3to1 } from '../../../../public/worklets/mic-decimate.js';`. Vitest/Jest handles the .js import natively. No build-time concat.

If iOS < 16.4 worklet-module support turns out to be broken in the field, fallback is a `<script type="module">`-loaded shim that pre-registers the function on `globalThis` before the worklet `addModule` call. Not the default plan.

**Pre-deploy device check** (REV 4 light-finding): before merging Phase 2, verify the import-style worklet loads on iOS 15.7 Safari. Path: BrowserStack live-test or a real device pointed at the Vercel preview URL. If `addModule` throws on iOS 15.x, swap to the `globalThis`-preregister fallback before merging. This is non-negotiable for YC demo on whatever phone Vuk hands a partner.

#### Pure function signature
```js
// public/worklets/mic-decimate.js
// Stateful 3:1 decimator. Caller owns the state object across calls.
// Phase tracks where in the next-3-sample window the next emitted sample lives.
export function decimate3to1(input, state) {
  // input: Float32Array
  // state: { phase: number }  // 0..2
  // returns: Float32Array of length ceil((input.length - state.phase) / 3)
  // mutates state.phase in place
}
```

### 2B — Test cases (REV 2's set + 2 caveats from M5)

| Test | Asserts |
|---|---|
| Continuity across chunk boundary | feed 25× 480-sample chunks (10ms @ 48k); concatenate outputs; assert output equals decimating one 12000-sample buffer in a single call |
| First-chunk sample-0 drop is intentional | starting phase=0, first output sample is `input[0]` (NOT dropped); on a fresh worklet instance with phase=0, no carry exists yet |
| Output length math | for any input length L and starting phase P ∈ {0,1,2}, output length = ⌈(L − P) / 3⌉ |
| Phase update math | given input length L and starting phase P, ending phase = `(P + (3 − ((L − P) % 3)) % 3) % 3` |
| Empty input | length-0 input returns length-0 output, phase unchanged |
| **Worklet-restart sample loss caveat (M5)** | Documented (not a test): every fresh worklet instance starts with `phase=0` and no carry. AudioContext suspend/resume preserves the worklet, so iOS background-foreground does not lose samples. Page reload / fatal_error retry creates a new worklet → ~1/16000s of audio drop per restart. Acceptable; documented in code comment. |

**Decision**: ship pure-fn carry fix. Polyphase FIR is Day 13–14 polish only if iOS LTE testing shows audible artifacts.

Time: **4–5 hours** including tests.

---

## Phase 3 — Close-outs (docs + dead-code, one PR)

### 3A — Item #5: RE-OPEN, do not close (M6 + I-7)

REV 2 said "superseded." That is wrong. [kill-switch.ts:42-57](../../src/lib/voice/kill-switch.ts#L42-L57) reads three columns from `daily_quotas`: `seconds_used`, `daily_limit_s`, `kill_switch_fired_at`. It's the active enforcement gate for Spike-A.

**Disposition**: do nothing in this PR; document the re-open in `.claude_learnings.md`. Two follow-up paths:
- Path A — migrate the kill-switch read to `voice_usage_daily` (which has `seconds_used` and a per-day shape). Then `daily_quotas` becomes truly latch-only and item #5 closes for real.
- Path B — do the original deferred work: add `daily_quotas.day_utc` GENERATED column + composite index. Smaller change, but `daily_quotas` stays in the read path.

**Concrete follow-up trigger** (I-7 — REV 3's "Day-8 hardening" reference is stale; Day 8 was 2026-04-27): park until **either** the v2 kill-switch redesign ships **or** the strict timezone-aware `quota_date` equality match referenced in [kill-switch.ts:13-17](../../src/lib/voice/kill-switch.ts#L13-L17) ships, whichever comes first. At that point, pick path A or B based on which is the smaller diff.

### 3B — Item #2: RE-OPEN, do not close (M7)

REV 2 said "obsolete because Cartesia rides Simli's WebRTC track." That is aspirational. Today's runtime: [use-session-pipe.ts:213-214](../../src/app/s/[id]/use-session-pipe.ts#L213-L214) forwards Gemini's raw PCM bytes directly to Simli. Cartesia is not in the data path.

**Disposition**: park as `deferred-pending-α'-cutover`. When the client switches to forwarding Gemini transcript text to Cartesia (and Cartesia output is what Simli lipsyncs against), revisit whether iOS Web Audio playback is needed — if all audio still rides Simli's WebRTC track, item #2 closes naturally. If Cartesia output ever needs to play directly to a `<audio>` element, the MSE/SourceBuffer iOS path is in scope again.

Track in `.claude_learnings.md`.

### 3C — Item #3: ~~delete the dead `seedContents()` interface~~ DO NOT DELETE (REV 5 build-time correction)

REV 1–4 framed `seedContents()` as dead code. **Verified during build (2026-04-30): NOT dead.** [supabase/migrations/20260427000005_voice_build_resume_context_rpc.sql](../../supabase/migrations/20260427000005_voice_build_resume_context_rpc.sql) explicitly builds the data the interface consumes — it's planned for the resume flow when a session WS reconnects. The interface member is intentionally optional (`?`) so STT-only bridges can skip it.

**Disposition**: leave the interface as-is. Deleting it would break the planned resume implementation. Re-evaluate as part of the resume-flow ticket.

Lesson logged in `.claude_learnings.md`: "interface declared, never implemented" doesn't mean "delete" — grep for the data plumbing too.

### 3D — Single-instance-Fly guard (REV 4 I-F — CI substrate didn't exist; now wired)

REV 3's "fail if `min_machines_running > 1`" was wrong directionally. REV 4 specified a CI script that depended on `.github/workflows/`. **Verified: `.github/workflows/` does not exist** (no GitHub Actions, no Vercel CI step in repo). REV 5 wires it.

**Add to `server/voice-proxy/fly.toml` as a top-level comment**:
```toml
# OAKLEAGUE-SCALING-GUARD: This proxy holds per-session in-memory state
# (cogs counters, quota cache). Horizontal scaling beyond 1 machine requires
# revisiting SPIKE_A_DEFERRED_FIXUP_PLAN.md §1A.2 + adding session-affinity
# routing or moving state to Redis. Before changing min_machines_running
# above 0, increasing fly scale count above 1, or adding additional [[vm]]
# blocks, leave a comment '# scaling-approved: <issue#>' next to the change.
```

**Add `.github/workflows/scaling-guard.yml`**:
```yaml
name: scaling-guard
on:
  pull_request:
    paths:
      - 'server/voice-proxy/fly.toml'
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: bash scripts/check-fly-scaling-guard.sh
```

**Add `scripts/check-fly-scaling-guard.sh`**:
- `git diff origin/main..HEAD -- server/voice-proxy/fly.toml`. If the diff touches `min_machines_running`, increases `[[vm]]` block count, or adds any `auto_scale_*`/`fly scale count` field, AND the new content doesn't include `# scaling-approved:`, fail with a link to this plan section.

**Time**: ~20 min for both files (workflow + shell script). Adds ~15 min vs REV 4's "performative script" alternative.

**Realistic acknowledgment**: this is the FIRST GitHub Actions workflow in the repo. It will only run on PRs (push-to-main bypasses, since main is the deploy branch per CLAUDE.md). Acceptable: this guard is a "you intended a scaling change, write down why" speed bump, not a blocker. If we add more workflows later they coexist; this is the seed.

Time: **45 min**.

---

## Total ship plan

| Phase | Time (REV 5) | Gate |
|---|---|---|
| 0 — verify COGS drift | ~30 min wall-clock | Vuk runs queries; finding-based gate (§0.5) |
| 1A.0 — handler extraction + WS-close plumbing | ~1.5 h | `proxy-handlers.js` exports factories; `index.js` rewired |
| 1A — cogs RPC switch + pricing constants | ~1 h | `cogs_insert_turn_voice` shipping; legacy `cogs_insert_turn` call deleted |
| 1A.1 — dashboard fallback gating | ~3 h | 3 routes + UI updated; 2 new test files; truth/fallback split visible |
| 1A.2 — error policy + reducer wiring | ~1.5 h | `cogs_failed` action + reducer case + UI copy + Sentry alert rule + verification script |
| 1B — reaper cadence + threshold | ~30 min | Cadence 20s, override dropped, plan-doc comment corrected |
| 1D — Phase 1 tests | ~2 h | 3 new test files (cogs-rpc, reaper-call, dashboard) all green |
| 2 — mic-processor (2A + 2B) | 4–5 h | Pure-fn extracted; tests green; iOS-15 import-style verified or fallback in place |
| 3 — close-outs (3A + 3B + 3C + 3D wired CI) | ~1.5 h | Re-opens documented; dead interface deleted; scaling-guard CI workflow + script in place |
| **Total** | **15–17 h** | 1.5–2 focused days |

REV 4 estimated 11–13h. REV 5 corrects to 15–17h based on the audit. Drivers: §1A.0 plumbing (was 30 min, now 1.5h after factoring `sessionToWs` Map + counter wiring); §1A.1 (was 2h with wrong file map, now 3h with correct files + 2 test files); §1A.2 reducer wiring (was implicit, now ~1.5h after C-B); §3D CI wiring (~20 min added). Aggregator removal still nets a save vs REV 2.

**Plan for 1.5 focused days, not 1.** Honest estimate at hour 0 beats panic at hour 14.

---

## Auditor REV 4 findings — disposition

### Critical
| # | Finding | Disposition |
|---|---|---|
| C-A | §1A.1 file map is wrong; `cogs-operations.ts` is allowlist, not aggregation | §1A.1 rewritten with correct 3-file edit list (live route, historical route, dashboard tsx) + 2 test files; time re-estimated to 3h |
| C-B | `session_error` action doesn't exist in reducer | §1A.2 — explicit `cogs_failed` action added to reducer; `use-session-pipe.ts` dispatches it on `1011 cogs_rpc_failed`; new copy; ~1.5h |
| C-C | Factory signature can't carry per-session counter | §1A.0 — signature reshaped to `makeLogTurnCogs({ supabase, env, onConsecutiveFailure })`; `sessionToWs` Map plumbed in `index.js`; time +1h |
| C-D | Phase 0 tokens-per-sec query depends on data that may not exist | §0.1 query A4 added — disambiguates "no cogs writes" from "Gemini stopped shipping responseTokenCount"; A5 adds rate-card snapshot |

### Important
| # | Finding | Disposition |
|---|---|---|
| I-A | 5-min auto-proceed unsafe in worst-case branch | §0.5 — finding-based decision tree; explicit Vuk-go required for 4 scenarios |
| I-B | Reaper cadence test was placebo (tests const, not behavior) | §1A.0 — `installReaper()` returns interval handle; §1D test inspects `handle._idleTimeout` |
| I-C | Per-token rate has no verification step | §0.1 A5 — explicit price-card lookup added to Phase 0 findings |
| I-D | Reaper claim "for proxy crash" was wrong; reaper runs IN proxy | §1B — re-framed: protects against partial-failure cases + endSession 0-rows; proxy-crash recovery is the boot-time `runReaper()` at index.js:484 |
| I-E | Cartesia-pending rows pollute row counts | §1A.1 — rename `turn_rows` → `cogs_rows`; add separate `cartesia_pending_rows` count |
| I-F | CI script for §3D runs nowhere (no `.github/workflows`) | §3D — wires the first GitHub Actions workflow as part of this PR (~20 min) |
| I-G | No test runner script in proxy `package.json` | §1D — add `"test": "node --test *.test.js"` to `server/voice-proxy/package.json` |

### Light / nits (folded inline)
- Fallback default-50 source tag: §1D — explicit test row added
- Cartesia `POST /cogs/cartesia-leg` endpoint scaffolding: noted in deferral spec; ~1h when α' bridge lands
- iOS 15 worklet import: §2A — pre-deploy device-check step added (BrowserStack or real device); fallback already in plan
- Vitest can import from `public/`: confirmed (`vitest.config.ts` doesn't restrict imports)
- Migration 0055 metadata key collision: zero overlap with proxy keys; flagged for posterity (don't introduce `pipeline`/`leg`/`audio_discarded` proxy-side)
- Sentry alert post-deploy verification: §1A.2 — `scripts/check-sentry-cogs-rule.mjs` added
- §3A item #5 deferral: acceptable per CLAUDE.md (correctness intact via Postgres latch trigger; only query-perf concern); flagged in `.claude_learnings.md`
- Brownout UX quantification: §1A.2 — acknowledged ~27% session-loss at 10% Supabase brownout; `COGS_RPC_BYPASS_UNTIL` env var as escape hatch

### Spot-check on REV 3 dispositions (REV 4 audit's spot-check)
- **I-2 (refactor)**: REV 4 had it directionally right; REV 4 C-C surfaced the signature gap. Now fully resolved in REV 5 §1A.0.
- **I-9 (tokens-per-sec from data)**: REV 4 had the query; REV 4 C-D surfaced the data-availability gap. Now resolved with §0.1 A4 disambiguation.
- **I-8 (CI directionality)**: REV 4 had the conceptual fix; REV 4 I-F surfaced the missing CI substrate. Now resolved with §3D wiring the workflow.

## Auditor REV 3 findings — disposition

### Critical
| # | Finding | Disposition |
|---|---|---|
| C-1 | "6×10s" math wrong (real ping = 20s, not 10s) | §1B rewritten — structural argument (proxy self-close at 90s; reaper for proxy-crash recovery) supersedes the arithmetic. One-line correction added to `DAYS_8_12_VOICE_PLAN.md:198`. |
| C-2 | Phase 0 prod query mechanism unspecified | §0.1 — Supabase dashboard SQL editor; Vuk runs; explicit SQL provided |
| C-3 | Phase 0 Sentry query mechanism unspecified | §0.1 — Sentry web UI; Vuk runs; explicit filter + grouping provided |

### Important
| # | Finding | Disposition |
|---|---|---|
| I-1 | Tests must expect merged metadata shape | §1D — explicit "inspects `p_metadata` parameter only" note; merged shape only for end-to-end DB tests |
| I-2 | Test-implementability requires refactor | §1A.0 — extract handlers to `proxy-handlers.js`; tests import factory + mock supabase |
| I-3 | WS 1011 trigger + client behavior under-specified | §1A.2 — "3 consecutive turns where cogs RPC errored" + "successful turn resets counter" + client treats as `session_error` in existing reducer |
| I-4 | Phase 0 → Phase 1 gate vs Vuk's pre-auth | §0.5 — agent reports + auto-proceeds after 5-min silence; Vuk can halt |
| I-5 | Fly metric counter assumes a surface that doesn't exist | §1A.2 — drop "Fly metric" language; Sentry-only |
| I-6 | Sentry alert rule provisioning is manual | §1A.2 — explicit deploy-checklist item, owner = Vuk |
| I-7 | "Day-8 hardening" reference is stale | §3A — replaced with concrete trigger ("v2 kill-switch redesign OR strict timezone-aware quota_date match, whichever first") |
| I-8 | CI check directionality wrong (`min_machines_running` doesn't gate scaling) | §3D — replaced with `# OAKLEAGUE-SCALING-GUARD` comment in fly.toml + diff-based CI script enforcing `# scaling-approved:` annotation |
| I-9 | `GEMINI_TOKENS_PER_SEC_FALLBACK = 50` plucked from air | §0.1 — empirical query in Phase 0; if ≥100 truth rows, use measured mean; if <100, use 50 + tag `metadata.fallback_constant_source` |
| I-10 | §1A.1 dashboard scope understated | §1A.1 — explicit 4-file list + ~2h sub-time estimate |

### Light
| # | Finding | Disposition |
|---|---|---|
| L-1 | Cite the actual unique index name | Cartesia leg deferral spec — references `cogs_log_turn_idempotency` ([migration 0055 line 24](../../supabase/migrations/20260428000001_cogs_insert_turn_voice.sql#L24)) |
| L-2 | Migration follow-up trigger should compound | §1A leg-2 decision — ">5% sustained 24h OR cumulative >1000 rows" |
| L-3 | CI check should be implementable | §3D — diff-based grep for `# scaling-approved:`, achievable today |

## Auditor REV 2 findings — disposition

### Critical
| # | Finding | Disposition |
|---|---|---|
| C1 | Leg-2 fallback writes seconds-as-tokens (fictional units) | §1A — derive tokens via `outputSeconds × GEMINI_TOKENS_PER_SEC_FALLBACK`, tag `metadata.fallback='seconds'` with full provenance |
| C2 | Dashboard merges fallback + truth rows silently | §1A.1 — headline cost filters fallback rows; fallback-rate field exposed; Sentry breadcrumb on >5% rate |
| C3 | Reaper cadence is also 60s — call-site change alone is marginal | §1B — cadence drops to 20s; max ghost life 80s |
| C4 | Aggregator + WS reconnect = silent COGS loss across machines | Moot — aggregator deleted (C5) |
| C5 | Aggregator has no round-trip win, adds 4 failure modes | §1C — aggregator removed; item #4 closed `wontfix-needs-batch-rpc` |

### Medium
| # | Finding | Disposition |
|---|---|---|
| M1 | Phase 0 rollback unclear | §Phase 0 — "atomic-redeploy contract" paragraph |
| M2 | `GEMINI_OUTPUT_USD_PER_TOKEN` needs `QUOTED_AT` pin | §1A — `PRICING_QUOTED_AT='2026-04-30'` const + comment |
| M3 | Tests miss proxy-side regression for reaper args + cogs name | §1D — two new tests: "cogs RPC name regression guard" + "reaper proxy-call regression guard" |
| M4 | Phase 2A worklet build mechanism vague | §2A — explicit: plain JS file in `public/worklets/`, ES-module import; no build step |
| M5 | Sample-0 drops on every fresh worklet, not just first chunk ever | §2B — documented as a code-comment caveat with frequency analysis |
| M6 | Item #5 close-out wrong; `daily_quotas` is active | §3A — re-opened; two follow-up paths sketched |
| M7 | Item #2 close-out premature; Cartesia not in data path | §3B — re-opened as `deferred-pending-α'-cutover` |

### Small / nits
| # | Finding | Disposition |
|---|---|---|
| §1E dead text | §1E removed entirely |
| `PRICE_USD_PER_SEC` deletion line not enumerated | §1A — explicit reference to [index.js:56](../../server/voice-proxy/index.js#L56) |
| `try/catch` swallows cogs errors | §1A.2 — close WS after 3 consecutive failures + Sentry alert rule |
| Migration filename suffix scheme | Moot — no migrations in Phase 1 |
| `outputSeconds` semantic comment | §1A — included in fallback metadata (`fallback_seconds`) |
| `Number.isFinite` gate mirroring | §1A — explicit code snippet matches `index.js:166-170` |
| `min_machines_running` CI check | §3D — new CI job |
| Floor-guard 22003 vs admin "reap-now" | Acknowledged: admin tooling will use a separate non-floored RPC if needed; current reap-now flow does not invoke `reap_stale_sessions`. No change required for this PR. |
| Partial-usageMetadata apportionment | §1A — `Number.isFinite(responseTokenCount)` only; `totalTokenCount`-only triggers fallback (we don't know the in/out split) |

Ready for re-audit.
