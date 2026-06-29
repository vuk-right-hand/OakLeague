# Growth & Minutes Economy — Plan (v1, pre-audit draft)

**Branch:** `worktree-growth-minutes-economy` (off `origin/main`, worktree `.claude/worktrees/growth-minutes-economy`)
**Date:** 2026-06-15
**Author:** Claude (planning loop per CLAUDE.md)

> Goal: turn minutes into a growth currency — referral-earned minutes, a graceful
> in-session upsell, urgency nudges, and a $1–2/mo "support" tier — on top of the
> existing voice-quota infra, built so it scales when traffic arrives.

This doc is the strike-through checklist + architecture decision + edge cases. It
goes through the auditor subagent (≥2 rounds) before any code is written. Nothing
below is built yet.

---

## 0. Verify-don't-guess — what already exists (read, not assumed)

I read the live code. The growth system is **additive to a working quota stack**, not
a greenfield. Key facts that constrain the design:

### 0.1 Two parallel quota systems are LIVE (do not break either)

- **System A — COGS fuse.** `daily_quotas` table + `sessions_enforce_tier_and_kill_switch`
  trigger + `voice_check_quota` / `voice_accumulate_seconds` RPCs
  ([20260421000003](../../supabase/migrations/20260421000003_voice_quota_rpc.sql),
  [20260510000001](../../supabase/migrations/20260510000001_unify_voice_caps_to_profile.sql)).
  Latches a **150 %-of-daily-cap kill switch** (`kill_switch_fired_at`). The proxy
  calls `voice_check_quota` at **every `turn_start`** ([server/voice-proxy/index.js:3088](../../server/voice-proxy/index.js#L3088),
  gate logic in [quota-gate.js](../../server/voice-proxy/quota-gate.js)). On `!ok` it
  **tears down + closes the WS** (1008 normal, 4006 fatal quota-state-inconsistent).
- **System B — minutes-per-day cap.** `voice_usage_daily` / `voice_usage_weekly`
  / `voice_usage_turns` (idempotency) + `voice_usage_record` (per-turn, exactly-once)
  + `voice_usage_ticket_check` (session-open) ([20260428000002](../../supabase/migrations/20260428000002_voice_usage_counters.sql)).
  Source of truth for caps = **`profiles.voice_daily_cap_seconds` / `_weekly_` / `_monthly_`**.
  `voice_usage_ticket_check` returns `remaining_seconds = min(cap − used)` across enabled
  caps. `/api/sessions/open` pre-mint-checks this and returns **429 `daily_cap_hit`**
  with `{remaining_seconds, daily_used, daily_cap, weekly_used, weekly_cap, …}` BEFORE
  creating a session row ([route.ts:398-464](../../src/app/api/sessions/open/route.ts#L398)).
- **Tier → caps** is a single source-of-truth helper `tier_default_voice_caps(tier)`:
  free = (300, 900, NULL); premium = (3600, NULL, NULL); boardroom = (14400, NULL, NULL).
  `admin_set_profile_tier` writes the cap columns on flip.
- **Weekly reset is already automatic** — `voice_usage_weekly` is keyed by
  `(user_id, iso_week_mon)`; a new ISO week = fresh row = 0 used. The weekly 15-min
  bucket + "never exceed 15" (LEAST clamp in `voice_usage_ticket_check`) **already
  ship today.** Item 4's reset machinery is *already done*; item 4's real work is the
  email nudges + surfacing the number.

### 0.2 Referral plumbing exists (reuse, don't rebuild)

- `referral_tokens` (HMAC, 90-day TTL) + `referral_redemptions`
  (`landing | first_session | first_paid`) + `recording_token_mints_daily`
  (per-user mint cap, default 20/day) ([20260506000001](../../supabase/migrations/20260506000001_recording_referrals.sql)).
- RPCs `recording_referral_mint`, `recording_referral_credit_first_session`,
  `recording_referral_redeem_landing` ([20260506000002](../../supabase/migrations/20260506000002_recording_referral_rpcs.sql)).
  `credit_first_session` is **already wired** into `/api/sessions/open` via Next 15
  `after()` and is **idempotent** on `(token_hash, new_user_id, 'first_session')`
  ([route.ts:1239-1343](../../src/app/api/sessions/open/route.ts#L1239)). This is the exact
  verified-conversion hook for the +15-min referral grant.
- HMAC: `RECORDING_REFERRAL_HMAC_SECRET_CURRENT` / `_NEXT`, token helpers in
  [src/lib/recording/referral-token.ts](../../src/lib/recording/referral-token.ts).

### 0.3 Plumbing for the rest

- **COGS:** `cogs_log` append-only, RLS service-role-only, UPDATE/DELETE/TRUNCATE
  blocked ([20260420000020](../../supabase/migrations/20260420000020_cogs_log.sql)).
  Grants are **not** paid API calls → they do **not** write `cogs_log`. Reconciliation
  is a read-side join (grants vs consumption vs billed-COGS).
- **Email:** [src/lib/email/send-email.ts](../../src/lib/email/send-email.ts) — Resend
  wrapper with a 4-state result (`sent | sent_sandbox | skipped | failed`). Already warns
  loudly on the `@resend.dev` sandbox sender. **Domain must be verified before nudges
  go live** (gate, see §7).
- **Cron:** one cron today (`vercel.json` → `/api/cron/cleanup-verifications`),
  Bearer-`CRON_SECRET` guarded with constant-time compare + import-time fail-closed
  ([cron route](../../src/app/api/cron/cleanup-verifications/route.ts)). Reuse this exact
  auth pattern.
- **Client upsell surfaces already exist:** `AskErrorPill` renders the cap-hit copy +
  `Upgrade for unlimited →` link to `/upgrade?source=cap_hit`
  ([ask-error-pill.tsx](../../src/lib/feed/ask-error-pill.tsx),
  [ask-error-copy.ts](../../src/lib/feed/ask-error-copy.ts)). `CAP_HIT_CODES` already
  includes `daily_cap_hit`. The in-session client is
  [session-client.tsx](../../src/app/s/[id]/session-client.tsx); proxy→client control
  messages are parsed in [proxy-client.ts:107-163](../../src/lib/voice/proxy-client.ts#L107)
  (`type: 'error' | 'warning' | …`).

---

## 1. The pivotal architecture decision (READ FIRST)

The brief says: *"Daily/weekly balance = ledger sum, replacing the flat cap columns on
profiles."* Taken literally, that is a **rip-and-replace of the load-bearing quota
stack** — `voice_usage_ticket_check`, the `sessions_*` trigger, `tier_default_voice_caps`,
`admin_set_profile_tier`, `admin_set_user_voice_caps`, the 150 % fuse anchor, and ~25
pgTAP tests — in one migration. High blast radius for a pre-traffic system whose voice
path is already correct.

**Recommendation — Hybrid "allowance + durable wallet" (Option A).** Keep the
battle-tested per-period counters as the **free allowance**; add the ledger as a
**durable wallet** layered on top. One new RPC unifies them.

```
effective_remaining(user) =
      allowance_remaining            -- max(0, weekly_cap − weekly_used)   [existing System B]
    + wallet_remaining               -- max(0, Σ active grants − wallet_spent) [new ledger]
  , then clamped by daily & monthly ceilings (fair-use, unchanged)
```

- **Free allowance** = the existing `voice_weekly_cap_seconds` (900) + `voice_usage_weekly`
  counter. Auto-resets weekly. No rollover ("never exceed 15"). Untouched.
- **Durable wallet** = `minute_grants` ledger. `signup_bonus`, `share_tap`,
  `referral_verified`, `paid_topup` land here. Optional `expires_at`. **Rolls over**
  across weeks (earned/bought minutes you keep). Consumed only **after** the free
  allowance is exhausted, so purchased minutes never get burned by the free refill.
- **Recruiter perk** = a **permanent daily-cap bump** (`profiles.recruiter_bonus_daily_seconds`,
  hard-ceilinged) — a cap property, not a consumable. (Divergence from the brief's
  `recruiter_daily` grant_type: minting a daily ledger row *forever* per user is waste;
  a bumped cap column is O(1) and reconciles trivially. Flagged for audit.)
- **150 % fuse** unchanged — remains the absolute COGS backstop anchored to the daily cap.

**Why not the literal pure-ledger (Option B)?** It is the "correct" double-entry model
but (1) forces consumption to also become signed ledger rows with FIFO grant draw-down +
expiry reconciliation (materially more complex per-turn write path), (2) rewrites every
quota RPC + the sessions trigger + all quota pgTAP at once, (3) gives the user nothing
extra over Option A at v1 scale. Option A reaches the **same product surface** (a balance
made of earned/bought minutes) with a fraction of the blast radius and keeps the proven
150 % fuse and idempotent per-turn counter exactly as-is.

> **DECISION REQUIRED at the gate.** Default = Option A (hybrid). If you want the literal
> pure-ledger (Option B), say so and I'll re-plan the cutover (it roughly doubles Phase 1
> and adds a backfill + a full quota-suite rewrite).

The rest of this plan assumes **Option A**.

---

## 2. Build order (spine first, each phase shippable behind a flag)

`GROWTH_*` env flags gate every behavior change so each phase can deploy dark and flip on
independently. Phases are ordered so nothing references a not-yet-built dependency.

```
Phase 1  Ledger spine + gate     minute_grants + balance RPC + per-turn wallet draw
                                 + UNIFIED session-open gate + max_duration_s rework  (R1-C1/C2/M3)
Phase 2  Soft gate (item 1)      tier_exhausted at 100% → graceful in-session upsell, SERVER-owned kill
Phase 3  Proactive meter (item 2) "X min left this week" persistent UI + reset copy
Phase 4  Referral engine (item 3) share-tap / verified-signup / welcome / recruiter bump (atomic RPC)
Phase 5  Weekly nudges (item 4)  Resend cron emails (gated on domain-verify)
Phase 6  Paid tiers (item 5)     Stripe checkout + webhook → tier flip (Evangelist $3.36 / Boardroom $27)
Phase 7  Reconciliation          admin viewer + COGS-reconcile script
```

> **Audit Round 1 (auditor subagent) — applied.** 5 Critical, 7 Medium, 8 Small. The
> single biggest correction: **Phase 1 is NOT "zero UX change."** The wallet is invisible
> at session-open until the 429 gate + `max_duration_s` + `session_rollover` all consume a
> unified balance — otherwise a user with bought/earned minutes is 429'd at open and the
> whole payoff is unreachable (R1-C1/C2/M3). The per-turn consumption model and the
> soft-gate kill ownership were also reworked (R1-C3/C5). Full resolution log in §14.

---

## 3. Phase 1 — Ledger spine + unified gate  ⟶  *build first*

> **Consumption model (rewritten after R1-C3).** All wallet grants are **non-expiring**
> (`expires_at = NULL`) — this removes the FIFO/expiry-vs-counter corruption the auditor
> flagged and makes `wallet_remaining = Σ(grants) − wallet_spent_seconds` exactly correct.
> The free weekly allowance is the existing resetting `voice_usage_weekly` counter; the
> wallet is drawn **only by the slice of each turn that exceeds the free allowance available
> at that moment**, computed from the `RETURNING` of the atomic weekly upsert (race-safe,
> single transaction). Crucially, **wallet minutes bypass the daily cap** (you bought them —
> the daily cap is a free-tier anti-binge ceiling, not a wallet ceiling). The 150 % fuse is
> NOT raised by wallet/recruiter/supporter (R1-M7) — it stays anchored to the base tier cap.

Unified remaining — **ONE formula, used identically by the open gate, the per-turn gate, and the
meter** (R2-M1 — the earlier draft shipped two contradictory recruiter formulas + an uncomputable
`recruiter_used_today` counter; deleted. Recruiter is added to the **daily side only**, never the
weekly side, in BOTH `voice_balance_check` and `voice_usage_record_v2`):
```
daily_cap_eff    = daily_cap + recruiter_bonus_daily_seconds                       -- recruiter: daily-only perk
                                                                                   -- (paid tiers: daily_cap ≥ monthly ⇒ uncapped days)
free_avail_now   = max(0, min(daily_cap_eff − daily_used,
                              weekly_cap − weekly_used,
                              monthly_cap − monthly_used))                          -- §8: monthly term REQUIRED (paid allowance)
wallet_remaining = max(0, wallet_active_seconds − wallet_spent_seconds)            -- both O(1) columns (R2-M2)
effective_remaining = free_avail_now + wallet_remaining
```
Paid tiers (Evangelist/Boardroom) set `daily_cap = monthly_cap` (uncapped days), `weekly_cap = NULL`,
so their **monthly allowance is the only binding free-pool cap**; the wallet draws once it's spent.
`monthly_used` is calendar-month for free, **billing-period for paid** (§8). The metering unit is
**avatar-talk seconds** (the existing `voice_usage_*` counter — assistant/Fish audio), so this is a
cap-VALUE change, not a meter change.
- **R2-M2 — `wallet_active_seconds` is a materialized `bigint` column on `profiles`** (incremented by
  `minute_grant_insert`), NOT a per-turn `SUM(minute_grants)`. Since all grants are non-expiring, the
  column is exact and the per-turn gate stays O(1) (no unbounded aggregate on the load-bearing turn
  path). `wallet_remaining = wallet_active_seconds − wallet_spent_seconds`, both single-column reads.

> **R2-C1 — the 150 % System-A fuse must scale with the user's LEGITIMATE entitlement, or it hard-kills
> every wallet/supporter user at 150 % of the BASE cap (free = 450 s ≈ 7.5 min) regardless of balance.**
> System A (`daily_quotas.daily_limit_s`, fuse at `seconds_used >= daily_limit_s*3/2`,
> [voice_check_quota:59](../../supabase/migrations/20260421000003_voice_quota_rpc.sql#L59)) is fed
> independently per turn by `accumulateSeconds()` — the wallet "bypasses the daily cap" only in System
> B; System A would still fire. **Resolution:** the fuse stops being a *tier-cap enforcer* (System B's
> soft gate now owns that at 100 %) and becomes a *runaway-COGS backstop*. At session-open (and
> rollover) the route sets today's `daily_quotas.daily_limit_s` to
> `min(daily_cap_eff + wallet_remaining, ABSOLUTE_DAILY_COGS_CEILING_SECONDS)` (env, default 14400 s =
> 4 h). So the fuse fires at 150 % of the user's *actual* entitlement, hard-bounded by the absolute
> ceiling — a runaway bug still trips it, but a legitimate supporter/wallet user is never cut off
> before their balance is spent. The wallet is itself anti-fraud-capped (lifetime referral cap §6.3),
> so a sock-puppet-inflated wallet can't raise the fuse past the absolute ceiling. This **supersedes
> the R1-M7 "fuse anchored to base cap" decision** — R1-M7 was correct that the recruiter bump must
> not *uncap* the fuse, but anchoring to the pure base cap broke legitimate paid users. The absolute
> ceiling is the right backstop; recruiter/supporter/wallet raise the anchor only up to it.
> **Implementation:** an `admin`-client UPDATE of `daily_quotas.daily_limit_s` for today's row right
> after `session_open`/`session_rollover` (the latch trigger's `NEW.seconds_used > OLD.seconds_used`
> guard from [20260510000001:132](../../supabase/migrations/20260510000001_unify_voice_caps_to_profile.sql#L132)
> means raising the limit can't retro-latch). Take `GREATEST(existing, new)` so a same-day grant only
> ever raises it.

### Schema — migration `20260615000001_minute_grants.sql`

- [ ] `CREATE TYPE minute_grant_type AS ENUM ('signup_bonus','share_tap','referral_verified','paid_topup','admin_adjustment');`
      (R1-S2: dropped `weekly_refill` — Option A never mints it and a dead enum value invites
      misuse. `admin_adjustment` for manual ops corrections.)
- [ ] `CREATE TABLE public.minute_grants (`
      `id bigserial PK,`
      `user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,`
      `grant_type minute_grant_type NOT NULL,`
      `seconds int NOT NULL CHECK (seconds > 0 AND seconds <= 2678400),`  -- ≤31 days, sanity ceiling
      `granted_at timestamptz NOT NULL DEFAULT now(),`
      `expires_at timestamptz,`                                           -- NULL = never expires
      `source_kind text NOT NULL CHECK (length(source_kind) <= 32),`      -- 'referral_token'|'stripe_event'|'share_token'|'signup'|'admin'
      `source_key  text CHECK (source_key IS NULL OR length(source_key) <= 128),`  -- token_hash / evt_… / user_id
      `metadata jsonb CHECK (metadata IS NULL OR octet_length(metadata::text) <= 2048)`
      `);`
- [ ] **Idempotency:** `CREATE UNIQUE INDEX minute_grants_dedup ON minute_grants (grant_type, source_kind, source_key) WHERE source_key IS NOT NULL;`
      (a Stripe `invoice.id`, a referral `token_hash`, or a `signup:user_id` can each grant once.)
      **R2-S1:** `admin_adjustment` rows with NULL `source_key` are intentionally NOT deduped (manual
      ops) — document that an ops double-entry won't be caught by the index; the admin RPC should log.
- [ ] Indexes: `(user_id, expires_at)` for active-balance scans; `(user_id, grant_type, granted_at DESC)` for caps/velocity; `(granted_at DESC)` for reconciliation.
- [ ] RLS enabled, **zero policies** (service-role only — all writes via RPC).
- [ ] **GRANTs:** `GRANT ALL ON TABLE public.minute_grants TO service_role;`
      `GRANT USAGE, SELECT ON SEQUENCE public.minute_grants_id_seq TO service_role;`
      (CLAUDE.md hard rule — new tables get explicit service_role grants; Supabase dropped
      default grants 2026-10-30.) No `authenticated` read (balance is surfaced via RPC/route).
- [ ] Append-only discipline: reuse the `raise_append_only()` pattern — block UPDATE/DELETE
      (allow only the FK `ON DELETE CASCADE`). Grants are immutable; corrections are new
      `admin_adjustment` rows (can be negative? — no, `seconds > 0`; a *clawback* is modeled
      as consumption, see edge cases). **AUDIT Q:** do we need negative adjustments? Leaning no
      for v1 (clawback = set `expires_at = now()` is impossible on append-only; instead an
      admin RPC inserts a compensating entry into the consumption counter). Flagged.

### Wallet-spend counter

- [ ] `ALTER TABLE public.profiles ADD COLUMN wallet_active_seconds bigint NOT NULL DEFAULT 0 CHECK (wallet_active_seconds >= 0);`
      (R2-M2) Materialized Σ of all (non-expiring) grant seconds, incremented atomically by
      `minute_grant_insert`. Keeps the per-turn gate O(1) instead of a `SUM(minute_grants)` on the hot
      path. A reconcile invariant (Phase 7) asserts it equals `SUM(seconds)` from `minute_grants`.
- [ ] `ALTER TABLE public.profiles ADD COLUMN wallet_spent_seconds bigint NOT NULL DEFAULT 0 CHECK (wallet_spent_seconds >= 0);`
      Monotonic lifetime counter of seconds drawn from the **wallet** (usage beyond the free allowance).
      `wallet_remaining = max(0, wallet_active_seconds − wallet_spent_seconds)`.
- [ ] `ALTER TABLE public.profiles ADD COLUMN recruiter_bonus_daily_seconds int NOT NULL DEFAULT 0 CHECK (recruiter_bonus_daily_seconds BETWEEN 0 AND 7200);`
      Permanent daily-cap bump from recruited signups. **R3-#3: the column CHECK is a generous SAFETY
      WALL (7200 s = 2 h, never reached in normal ops); the ACTUAL cap is env-driven
      `RECRUITER_BONUS_CEILING_SECONDS` (default 1800), read by the RPC's `LEAST(env, …)`.** The
      previous draft hardcoded both the CHECK and the RPC to 1800, making the env a dead knob — now the
      env is the single source of truth and the CHECK only stops a runaway bug. (Resolves R2-S2.)
- [ ] *(No `supporter_until` column — the final model flips the `tier` enum via the Stripe webhook
      instead of a flag; see §8. Subscription state lives on `stripe_customers`.)*

> **Why this is now exactly correct (R1-C3 resolution).** With **all wallet grants
> non-expiring**, `Σ(active grants)` is monotonic-up and `wallet_spent_seconds` is
> monotonic-up, so `wallet_remaining = Σ(grants) − wallet_spent` is exact — there is no
> expiry/counter divergence to approximate. The weekly reset does **not** corrupt it:
> `wallet_spent` only ever increments by *real overflow beyond the free allowance*, which is
> precisely what the wallet paid for; next week's fresh free allowance does not touch
> `wallet_spent`. The auditor's "weekly reset undercount" concern only arises if grants
> expire — which we've eliminated for v1. Share-tap grants are therefore **non-expiring too**
> (R1-S4). If product later wants expiring promo grants, that requires the Option-B FIFO
> draw-down model — out of v1 scope, noted at the `CREATE TYPE` site.

### Balance RPC — `voice_balance_check(p_user_id)` (new, in the same migration)

- [ ] SECURITY DEFINER, `SET search_path = public, pg_temp`, service-role + self (`auth.uid()`)
      guard mirroring `voice_usage_ticket_check`.
- [ ] Returns: `allowance_remaining int, wallet_remaining int, recruiter_bonus int,
      effective_remaining int, weekly_used numeric, weekly_cap int, daily_used numeric,
      daily_cap int, wallet_active_seconds bigint, wallet_spent bigint, supporter_active bool`.
- [ ] Compute: weekly/daily used from existing counters; `wallet_active = Σ seconds FROM
      minute_grants WHERE user_id = p AND (expires_at IS NULL OR expires_at > now())`;
      `wallet_remaining = max(0, wallet_active − wallet_spent_seconds)`;
      `effective_remaining = clamp_by_daily_monthly(allowance_remaining + wallet_remaining)`.
- [ ] **REVOKE** EXECUTE from public/anon/authenticated; **GRANT** to service_role (+ authenticated
      for self-reads if the meter route calls it as the user — decide per §4; default service-role only).

### Per-turn wallet draw — extend `voice_usage_record` → `_v2`

- [ ] **R4-C3 — add a `voice_usage_monthly` counter so the MONTHLY cap is O(1) per turn AND
      billing-period-aware.** `voice_usage_ticket_check` computes monthly as a calendar `SUM(voice_usage_daily)`
      — fine once per open, but the per-turn path can't afford a SUM (R2-M2) and calendar-month ≠ the
      paid billing period. New table `voice_usage_monthly (user_id, period_start date, seconds_used
      numeric, updated_at, PK(user_id, period_start))`, service-role only, explicit grants. The
      `period_start` is resolved by the shared helper below, so the monthly counter is keyed to the
      free user's calendar month OR the paid user's billing anniversary — uniformly.
- [ ] **R4-C4/M6 — ONE shared boundary helper, called by EVERY monthly reader** (`voice_usage_record_v2`,
      `voice_balance_check`, `voice_check_quota_v2`, `voice_usage_ticket_check`, the §9 reconcile):
      `monthly_window_start(p_user_id) RETURNS date` = `COALESCE( (SELECT current_period_start::date FROM
      stripe_customers WHERE user_id=p AND status='active'), date_trunc('month', (now() AT TIME ZONE tz))::date )`.
      Active-sub → billing anniversary; free/NULL/lagging-webhook → calendar month. This is the single
      definition that stops the four RPCs from drifting (the C4 double-count + M6 NULL-window bugs).
- [ ] `20260615000002_voice_usage_record_v2.sql`: race-safe wallet draw-down across daily + weekly +
      **monthly**. All three counters upsert with `RETURNING`; overflow is the slice of this turn beyond
      the free pool, clamped by whichever of daily/weekly/monthly binds first:
      ```
      -- inside the exactly-once voice_usage_turns claim, one transaction:
      v_mstart      := monthly_window_start(p_user_id);                      -- resolved ONCE per turn
      INSERT … voice_usage_daily   … RETURNING seconds_used INTO new_daily;  -- atomic, row-locked
      INSERT … voice_usage_weekly  … RETURNING seconds_used INTO new_weekly;
      INSERT … voice_usage_monthly (…, period_start=v_mstart, …) RETURNING seconds_used INTO new_monthly;
      daily_before  := new_daily   - p_seconds;   weekly_before := new_weekly - p_seconds;
      monthly_before:= new_monthly - p_seconds;                              -- all from RETURNING (race-safe)
      daily_cap_eff := daily_cap + recruiter_bonus_daily_seconds;
      free_avail    := GREATEST(0, LEAST(
                          daily_cap_eff               - daily_before,
                          COALESCE(weekly_cap,  'infinity') - weekly_before,
                          COALESCE(monthly_cap, 'infinity') - monthly_before)); -- monthly binds for paid tiers
      overflow      := GREATEST(0, p_seconds - free_avail);
      IF overflow > 0 THEN
        UPDATE profiles SET wallet_spent_seconds = wallet_spent_seconds + overflow WHERE id = p_user_id;
      END IF;
      ```
      Computing `*_before` from the `RETURNING` of each row-locked upsert is what makes it race-safe
      (R1-C3.2). Whole block inside the exactly-once `voice_usage_turns` claim → a proxy retry never
      double-draws. **This makes paid-user wallet-draw work** (their referral/share minutes extend the
      monthly allowance) instead of the auditor's "paid users can't draw wallet" fallback.
- [ ] **Caller update (lockstep):** the proxy's `recordVoiceUsage` calls `voice_usage_record`
      ([index.js:906](../../server/voice-proxy/index.js#L906)) — bump it to `_v2` (which needs the
      same args; `p_user_id` already passed). Keep a thin back-compat wrapper only if a test needs it.
- [ ] **Schema-change blast radius (CLAUDE.md):** changes a function body + adds columns → grep
      EVERY caller + EVERY pgTAP test referencing `voice_usage_record` / cap columns; run the **full**
      `npm run db:test`, not just the new file.

### Unified session-open gate + `max_duration_s` (R1-C1 / C2 / M3 — pulled into Phase 1)

The wallet is dead weight unless these three read `effective_remaining`:

- [ ] **Open 429 gate** ([route.ts:398-464](../../src/app/api/sessions/open/route.ts)): replace the
      bare `voice_usage_ticket_check` remaining with `voice_balance_check.effective_remaining`. A user
      with `free_avail = 0` but `wallet_remaining > 0` must pass open (today they're 429'd). Keep the
      structured 429 body (now `remaining_seconds = effective_remaining`, plus a `wallet_remaining`
      field so the client can say "using your earned minutes"). Match the FLOOR/clamp semantics of the
      existing RPC exactly (R1-S7) so open-gate and meter never disagree by a second.
- [ ] **`max_duration_s` — R2-C2: a hardcoded `Math.min(…, 600)` clamp caps EVERY session at 10 min**
      ([route.ts:721](../../src/app/api/sessions/open/route.ts#L721) AND
      [rollover/route.ts:338](../../src/app/api/sessions/rollover/route.ts#L338)). Swapping the source to
      `effective_remaining` is not enough — a 3600 s wallet user still gets a 600 s session. **Remove the
      `600` literal** (the L713 "≤7-of-10 free credits" rationale is exactly wrong once minutes are
      purchasable). Set `max_duration_s = min(GEMINI_MAX_SESSION_S, effective_remaining)` on the fresh
      path, the **takeover path** (L512 — swap `remaining_seconds` → `effective_remaining`), and rollover.
- [ ] **R2-C3 — `/api/sessions/rollover/route.ts` was entirely unthreaded.** It reads
      `daily_limit_remaining_s` from the RPC and feeds `max_duration_s` (System-A only,
      [rollover/route.ts:287, 637](../../src/app/api/sessions/rollover/route.ts#L287)). Add it to this
      Phase-1 checklist: clamp `max_duration_s` to `effective_remaining` exactly like open, and set the
      fuse anchor (below) on the rolled session too — else a 15-min rollover silently reverts the user
      to System-A limits and drops earned minutes mid-conversation.
- [ ] **R4-C1 — patch the LIVE definitions, not the superseded one.** `session_open`/`session_rollover`
      were re-`CREATE OR REPLACE`d twice since 0511; a migration that replaces the 0511 body is silently
      clobbered on `db:reset`. The **live** bodies (verified 2026-06-16 by grep) are:
      `session_open` → [20260522000100_sessions_retrieval_version_snapshot.sql:152-159](../../supabase/migrations/20260522000100_sessions_retrieval_version_snapshot.sql#L152);
      `session_rollover` → [20260522000104_session_rollover_restore_close_old_session.sql:237-241,287](../../supabase/migrations/20260522000104_session_rollover_restore_close_old_session.sql).
      Both still carry the **stale hardcoded CASE (600/3600/14400)**. Re-grep `CREATE OR REPLACE FUNCTION
      public.session_open` / `session_rollover` at build time and patch the HIGHEST-timestamp body. Fix
      to read `effective_remaining` (the unified balance) and clamp the new session there. (`tier_default_voice_caps`
      is unsuperseded in 20260510000001 — `CREATE OR REPLACE` that one; re-grep to confirm no intervening redefinition.)
- [ ] **R2-C1 fuse anchor (open + rollover):** after `session_open`/`session_rollover`, UPDATE today's
      `daily_quotas.daily_limit_s = GREATEST(existing, min(daily_cap_eff + wallet_remaining,
      ABSOLUTE_DAILY_COGS_CEILING_SECONDS))` via the admin client, so the 150 % fuse scales with the
      session's real entitlement (bounded by the absolute COGS ceiling). See the R2-C1 block above.

### Files (Phase 1)

- [ ] `supabase/migrations/20260615000001_minute_grants.sql`
- [ ] `supabase/migrations/20260615000002_voice_usage_record_v2.sql`
- [ ] `src/lib/minutes/grant.ts` — typed server helper `grantMinutes({userId, type, seconds, expiresAt?, sourceKind, sourceKey?, metadata?})` calling an RPC `minute_grant_insert` (SECURITY DEFINER, idempotent via the dedup index, enforces per-type caps — see Phase 4). Returns `{granted: boolean, reason?}`.
- [ ] `src/lib/minutes/balance.ts` — `getBalance(userId)` wrapper over `voice_balance_check`.

### Tests (Phase 1)

- [ ] pgTAP `minute_grants.test.sql`: insert grants; dedup index rejects duplicate
      `(type, source_kind, source_key)`; append-only blocks UPDATE/DELETE; RLS denies anon/auth;
      `voice_balance_check` returns allowance+wallet; expired grant excluded; `wallet_remaining`
      never negative.
- [ ] pgTAP `voice_usage_record_v2.test.sql`: turn fully within allowance → `wallet_spent` unchanged;
      turn straddling the cap → only the overflow slice draws wallet; exactly-once on retry
      (duplicate turn_number → no double draw); free user with NULL weekly cap → no wallet draw.
- [ ] vitest `grant.test.ts` / `balance.test.ts` (mock supabase).

### Edge cases (Phase 1)

- Premium/boardroom have `weekly_cap = NULL` → no wallet draw via the weekly path (wallet is a
  free-tier + topup construct). Documented; supporter daily cap (Phase 6) is their hard stop.
- Concurrency: two turns flushing near-simultaneously both read `weekly_used_before` — the
  `voice_usage_weekly` upsert is atomic, but the `overflow` computation must read the **post-upsert**
  value via `RETURNING` (compute overflow from the returned new total, not a pre-read), else a race
  double-counts overflow. **Compute overflow from the `RETURNING` of the weekly upsert.** (Audit.)
- A user whose wallet grants all expire mid-week falls back to allowance-only — moot under v1
  (grants are non-expiring), but `effective_remaining` recomputes correctly regardless.
- **R2-S3 — premium usage "poisons" the weekly counter.** `voice_usage_weekly` increments even while
  premium (premium has no weekly cap to gate it). A free→premium→free flip mid-week returns the user
  with `weekly_used` possibly ≫ 900, so `free_avail = 0` and turn 1 draws the wallet immediately. This
  is defensible (they genuinely used > 15 min this week) but surprising; document it. Tier flips are
  admin-only and rare in v1, so low impact.
- **Tier-switch fuse anchor:** when admin flips tier, `admin_set_profile_tier` re-mirrors
  `daily_limit_s` to the new base cap; the next session-open re-applies the `GREATEST(existing, …)`
  fuse-anchor write, so wallet headroom is restored. No stale low anchor persists past one open.

---

## 4. Phase 2 — Answer-end soft gate (item 1)

Distinct from both the session-open 429 (blocks *opening* when already at 0) and the 150 % fuse.
This handles **mid-session exhaustion**: a user who opened with minutes left and burned them to 0
during the session. Current answer **always finishes**; the **next** `turn_start` is denied
**gracefully** (control message, WS stays open), client shows upsell.

### Proxy

- [ ] `voice_check_quota` → `_v2` (sibling RPC) that ALSO returns `remaining_seconds int` +
      `tier_exhausted bool`. **R1-M2: `tier_exhausted` MUST be the SAME `effective_remaining <= 0`
      the open-gate uses** — not System-A daily `seconds_used >= daily_limit_s`. So `_v2` joins
      session→user and computes the unified balance (daily + weekly counters + `wallet_active_seconds
      − wallet_spent_seconds` + recruiter), exactly like `voice_balance_check`. **R3-#5: reads the
      materialized `wallet_active_seconds` COLUMN, NOT `SUM(minute_grants)`** (R2-M2 — hot turn path,
      O(1)). Keep the 150 % fields untouched. **tier_exhausted = 100 % soft signal;
      `over_150_pct`/`kill_switch_fired_at` = hard signal.** Net per-turn cost: 3 single-row reads
      (daily row, weekly row, profile counters); the proxy already caches the last healthy snapshot
      per session ([quotaCache](../../server/voice-proxy/index.js#L860)).
- [ ] `server/voice-proxy/quota-gate.js` `decideQuotaGate`: add a **soft** branch — when
      `tier_exhausted && !(fired || over150)` → `{ ok:false, soft:true, reason:'tier_exhausted' }`.
      Hard path (fired/over150/fatal) unchanged and still **trumps** soft.
- [ ] `index.js` `turn_start` handler ([~L3088](../../server/voice-proxy/index.js#L3088)): if
      `gate.soft` → send `ws.send({type:'tier_exhausted', remaining_seconds, op:'turn_start'})`,
      **do NOT** `teardown()` / `closeWs()` immediately, **do NOT** increment `turnNumber`.
- [ ] **R1-C5 — the SERVER owns the kill, never a client timer.** Keeping the WS open holds an open
      Gemini WS + a **billing Simli WebRTC room**; an iOS/PWA backgrounded tab freezes JS timers, so
      a client-only auto-end leaks idle Simli minutes with no user present (and no seconds accumulate,
      so the 150 % fuse can't catch it). On `tier_exhausted`, start a **server-side idle timer**
      (`SOFT_GATE_IDLE_KILL_MS`, default 25 s); if no acknowledged user action (a fresh `turn_start`
      that now passes because they bought minutes, or an explicit close) arrives, the proxy calls
      `teardown()` + `closeWs(4015, 'tier_exhausted')`.
- [ ] **R2-C4 — close code is `4015`, NOT `4013`.** `4013` is already shipped
      (`brain_unset_with_${ttsProvider}`, [index.js:1516](../../server/voice-proxy/index.js#L1516)) and
      `4014` is taken. Use **`4015 tier_exhausted`** and update the stale close-code header table
      ([index.js:11-24](../../server/voice-proxy/index.js#L11)) to add 4013/4014/4015 (R2-S4).
- [ ] **R2-M6 — clear the idle timer SYNCHRONOUSLY at the first line of the `turn_start` branch, before
      the awaited `checkQuotaOk`** ([index.js:3088](../../server/voice-proxy/index.js#L3088)). If cleared
      only after the awaited gate, the idle kill can fire *during* the await and tear down a session the
      user just rescued by buying minutes. Re-arm only if the gate still returns soft. Safe against the
      js-genai 1000-close lazy-reopen because `teardown` has a `closed` guard, but the synchronous clear
      is what actually closes the race.

### Client

- [ ] `proxy-client.ts`: add `onTierExhausted?(remaining)` handler for `type:'tier_exhausted'`
      ([parser ~L156](../../src/lib/voice/proxy-client.ts#L156)).
- [ ] `use-session-pipe.ts`: surface a reducer flag `tierExhausted` (don't reuse `errorMessage`/
      `closed`; the session is NOT errored). Stop mic, hold phase.
- [ ] `session-client.tsx`: when `pipe.state.tierExhausted`, render an **upsell overlay** —
      "You're out of minutes for this week" + **Get more minutes** (`/upgrade?source=in_session`)
      + **Invite a friend (+15 min)** (referral share) + a graceful **End** that calls
      `handleEndSession('user_ended')`. The client does NOT need to enforce a kill timer (the server
      owns it, R1-C5) — but it should stop the mic and show the overlay promptly.
- [ ] **R3-#1 — the "buy → keep talking" payoff is capped by the OPEN-time `max_duration_s` clamp,
      and clearing the soft gate is NOT enough.** `max_duration_s` was set at open to
      `min(GEMINI_MAX, effective_remaining)` (§3); a user who opened with 2 min has a ~120 s client
      ceiling that ends the session even after a mid-session `paid_topup` clears `tier_exhausted`. So
      the naive loop is really "buy → quick re-open," not a seamless same-session continue — and the
      headline money-moment feels broken. **Fix (recommended): on a grant that raises the balance
      mid-session, push an updated ceiling to the client** — the proxy, on the first `turn_start` that
      passes after having been soft-gated (or on a balance-change signal), sends
      `{type:'minutes_extended', max_duration_s}` (re-clamped to the NEW `effective_remaining`,
      bounded by `GEMINI_MAX`), and the client extends its local end timer + re-applies the fuse-anchor
      write. Also re-runs at the Gemini 15-min rollover (which already re-clamps). **v1 fallback if we
      defer the extend-message:** set the UX expectation honestly ("Minutes added! Tap to start a fresh
      session") rather than implying a seamless continue. **Gate decision: seamless extend (more proxy
      wiring) vs re-open UX (cheaper).**
- [ ] If the user buys minutes and taps again, the next `turn_start` passes (balance re-read per turn)
      and the overlay clears. The proxy's `4015` close flips the client to a clean "session ended"
      (not an error).
- [ ] Reuse `AskErrorPill` copy tone; new overlay component `InSessionUpsell`. `friendlyErrorLabel`
      maps `tier_exhausted` → "You're out of minutes" (not the generic "Session ended").

### Tests (Phase 2)

- [ ] `quota-gate.test.js`: `tier_exhausted` (no fire) → `{ok:false, soft:true}`; fire/over150 still
      hard; fatal still fatal-and-trumps.
- [ ] pgTAP for `voice_check_quota_v2` exhausted vs not.
- [ ] vitest: `proxy-client` dispatches `onTierExhausted`; reducer sets `tierExhausted` without
      entering `closed`.

### Edge cases

- Exhaustion exactly at an answer boundary: the soft gate is checked at **turn_start**, so the
  in-flight answer (already past turn_start) completes; the *next* tap is gated. Correct.
- A user with a fresh `paid_topup` grant lands mid-session: balance recomputes at the next
  turn_start → `tier_exhausted=false` → they continue. (No mid-session re-mint needed; the soft
  gate re-reads each turn.) This is the upsell payoff loop.
- 150 % fuse still fires hard even if the soft gate somehow misreads — defense in depth.

---

## 5. Phase 3 — Proactive minutes meter (item 2)

- [ ] Surface the persistent "**X min left this week**" meter from `effective_remaining`.
      Source of truth = `voice_balance_check`. Expose via either (a) the existing
      `/api/sessions/open` 429 payload (already returns remaining) for the cap-hit path, plus
      (b) a tiny **`GET /api/minutes/balance`** route (auth'd, `getCallerUserId`, calls
      `voice_balance_check` as service-role for that uid) for the always-on meter.
- [ ] UI: a small pill in the feed/long-form/session chrome — "12 min left this week · resets in 3d"
      using the same local-midnight/weekly math as `AskErrorPill`. Component
      `MinutesMeter` in `src/lib/feed/`. Wire into feed `hook-panel.tsx` and long-form player.
- [ ] Urgency copy: "resets in 24h" when within a day of the weekly boundary; "X min left" otherwise.
      When `wallet_remaining > 0`, show "12 min left (incl. earned)".

### Tests

- [ ] route test for `/api/minutes/balance` (auth required, shape, capped values coerced).
- [ ] vitest for the reset/urgency copy formatter (pure fn, like `ask-error-copy`).

### Edge cases

- Don't over-poll: fetch balance on feed mount + after a session ends (PostHog `session_close`),
  not per-render. Cache 30 s client-side.
- Roaming-timezone drift on "resets in": same accepted limitation already noted in `AskErrorPill`.

---

## 6. Phase 4 — Referral engine (item 3)  *credit on outcome, not clicks*

All grants go through `grantMinutes()` → `minute_grant_insert` RPC (idempotent + per-type caps).

### 6.1 +1 min / share-tap (cap 2/day)

- [ ] On `recording_referral_mint` success (a token actually minted — [route that calls it]),
      grant `share_tap` +60 s, **deduped on `source_key = token_hash`** (one grant per token).
- [ ] **Cap 2/day — R2-M7: must be an ATOMIC counter-row UPSERT, not `COUNT`-then-`INSERT`** (two
      concurrent share-taps both read count=1 and both insert → cap exceeded). Mirror the proven
      `recording_referral_mint` pattern: `INSERT INTO <daily_counter> … ON CONFLICT DO UPDATE SET
      count = count + 1 WHERE count < cap RETURNING count` ([20260506000002:58-69](../../supabase/migrations/20260506000002_recording_referral_rpcs.sql#L58)).
      The same atomic-counter shape applies to the lifetime + velocity caps (§6.3). **Credit on the
      share action, not the redemption**
      — a tap is a real distribution action with a 2/day ceiling, low fraud value.
      (Brief says "+1 min/share-tap (cap 2/day)". Note: this is the one grant that credits on a *tap*
      rather than a conversion — bounded to 2 min/day total, acceptable.)
- [ ] `expires_at = now() + 30 days` on share_tap grants (earned-not-bought minutes can expire to
      keep the wallet honest; flagged as a product choice — could be NULL).

### 6.2 +15 min verified signup (referrer) + 15-min welcome (new user)

- [ ] **R1-M4 — do the credit + ALL grants + recruiter bump in ONE SECURITY DEFINER RPC, one
      transaction** (`recording_referral_credit_first_session_v2`). The current RPC + a separate
      grant RPC across the `after()` boundary would let a partial failure leave a credited
      redemption with no grant (user invited a friend, got nothing) and the route only Sentry-logs
      ([route.ts:1327](../../src/app/api/sessions/open/route.ts)). One RPC returns a structured result
      `{credited, referrer_granted, welcome_granted, recruiter_bumped, reason}` so the route emits
      accurate PostHog (today it only knows a `credited` boolean). Grep + update the route caller in
      lockstep.
- [ ] **R1-C4 — self-referral guard lives in the RPC (it does NOT exist today** — verified:
      `recording_referral_credit_first_session` never compares `referral_tokens.user_id` to
      `p_new_user`). If `referral_tokens.user_id = p_new_user` → credit nothing, grant nothing,
      return `reason='self_referral'`.
- [ ] **R2-M4 — the sock-puppet guard needs the MINTER's fingerprint, which isn't stored today.** The
      `device_fp`/`ip_prefix` on `referral_redemptions` is the NEW user's, so distinctness can only
      compare new-users against each other — it misses a referrer self-referring once per fresh token
      behind incognito/VPN. **Fix:** persist the minting user's `device_fp`/`ip_prefix` at
      `recording_referral_mint` time, and reject the recruiter bump when the new user's fp/ip matches the
      **token owner's mint** fp/ip. Treat device-distinctness as *review-only* (consistent with the
      existing "not enforced" stance, [20260506000001:60](../../supabase/migrations/20260506000001_recording_referrals.sql#L60)); the
      real backstops are the lifetime + velocity caps (§6.3), tied to the **referrer**. On a **fresh**
      credit (not self-referral):
  - [ ] grant **referrer** (`referral_tokens.user_id`) `referral_verified` +900 s,
        deduped on `source_key = token_hash` (one verified-signup grant per token; a token can only
        convert one first_session per the redemption unique constraint).
  - [ ] grant **new user** (`p_new_user`) `signup_bonus` +900 s welcome, deduped on
        `source_key = 'signup:' || new_user_id` (one welcome per user, ever).
- [ ] **Universal welcome:** every new signup (referred or not) gets the `signup_bonus` +900 s once,
      at onboarding completion. Add the grant call to `saveOnboarding`
      ([onboarding/actions.ts:37](../../src/app/onboarding/actions.ts#L37)), deduped on `signup:user_id`.
      **R2-M3 — `saveOnboarding` uses the authenticated `supabaseServer()` client; `minute_grant_insert`
      is service-role-only and will 403.** Call the grant via `supabaseAdmin()` (same pattern as
      `creditFirstSessionFireForget`), not the user client, or the welcome silently drops on every signup.
- [ ] **Recruiter perk:** on each fresh verified signup, `UPDATE profiles SET
      recruiter_bonus_daily_seconds = LEAST(<RECRUITER_BONUS_CEILING_SECONDS>,
      recruiter_bonus_daily_seconds + <RECRUITER_BONUS_PER_SIGNUP_SECONDS>)` for the referrer
      (R3-#3: both bounds env-driven — default +60 s/recruit, ceiling 1800 s). Done in the same RPC as
      6.2 so it's atomic with the grant. (Brief: "+1 or +3" → recommend **+60 s**; tunable.)

### 6.3 Anti-fraud (hard constraint)

- [ ] **Lifetime referral-minute cap per account:** inside `minute_grant_insert`, reject
      `referral_verified` + `share_tap` once `Σ those grants for the user ≥ REFERRAL_LIFETIME_CAP_SECONDS`
      (default e.g. 18000 s = 300 min). Returns `{granted:false, reason:'lifetime_cap'}` (caller logs,
      doesn't error).
- [ ] **Velocity:** reject > N `referral_verified` grants per rolling 24 h (default 10). Same RPC.
- [ ] Reuse existing `device_fp` / `ip_prefix` already captured on `referral_redemptions` for fraud
      *review* (not auto-enforced — same "avoids dorm-room false positives" stance as today).
- [ ] Every grant is a visible row — fraud is auditable after the fact (admin viewer, Phase 7).

### Files (Phase 4)

- [ ] migration `20260615000003_minute_grant_insert_and_referral_grants.sql` —
      `minute_grant_insert` RPC (idempotent, per-type caps, lifetime/velocity guards) +
      extend `recording_referral_credit_first_session` to call it for referrer+new-user+recruiter-bump
      (or a new `recording_referral_credit_first_session_v2` that wraps it — **grep the route caller,
      update in lockstep**).
- [ ] `src/lib/minutes/grant.ts` (from Phase 1) gains typed wrappers `grantShareTap`,
      `grantSignupBonus`.
- [ ] wire `grantSignupBonus` into the onboarding-complete path (find via grep:
      `goals`/`obstacles` onboarding action).

### Tests (Phase 4)

- [ ] pgTAP: share_tap dedup on token_hash; 2/day cap; referral_verified credits referrer once;
      welcome once per user; recruiter bump ceiling; lifetime cap; velocity cap; new-user-self-referral
      blocked (referrer == new_user → no grant).
- [ ] vitest for the route wiring (fresh credit grants; duplicate credit no-ops).

### Edge cases

- **Self-referral:** referrer `user_id == p_new_user` → skip both grants (guard in RPC).
- **Token expired** between landing and first_session: `credit_first_session` already returns false →
  no grant. Correct.
- **New user welcome before referral exists:** universal welcome dedup key `signup:uid` ensures the
  referred-user path and the universal path never double-grant.
- **R1-M7 — recruiter bonus raises USABLE allowance, NOT the 150 % fuse.** `recruiter_bonus_daily_seconds`
  is added to the free pool **only inside `voice_balance_check` / `voice_check_quota_v2`
  `effective_remaining`** (the usable number). It is **NOT** written into `daily_quotas.daily_limit_s`,
  so `sessions_enforce_tier_and_kill_switch` and the `seconds_used >= daily_limit_s * 3/2` fuse stay
  anchored to the **base tier cap** — the only hard COGS backstop on free accounts, and exactly the
  surface the recruiter perk (+ C4 sock-puppets) is most exposed to. Net: the recruiter bump does
  **not** touch the load-bearing trigger (smaller blast radius than the original plan).

---

## 7. Phase 5 — Weekly bucket + email nudges (item 4)

The weekly bucket + reset + "never exceed 15" **already ship** (§0.1). This phase is **emails +
copy**, gated on a verified Resend domain.

- [ ] **Prerequisite gate:** `RESEND_FROM_EMAIL` must be a **verified custom domain**, not
      `@resend.dev`. `send-email.ts` already returns `sent_sandbox` and warns — the cron must treat
      `skipped`/`sent_sandbox`/`failed` as "not delivered" and not mark the nudge as sent. **Do not
      ship Phase 5 until the domain is verified** (same blocker noted in the creator-journey plan).
- [ ] **Two nudges, cron-driven (CRON_SECRET-guarded, reuse [cron pattern](../../src/app/api/cron/cleanup-verifications/route.ts)):**
  - [ ] `/api/cron/minutes-expiring` (daily, e.g. `0 16 * * *`): email users whose **weekly allowance
        is nearly used AND the week resets in <24 h**, or who have **wallet grants expiring in <24 h** —
        "Your X minutes reset/expire in 24h." Target: users with recent activity (had a session in the
        last N days) to avoid spamming dormant accounts.
  - [ ] `/api/cron/minutes-refreshed` (weekly, Mon 00:00 user-TZ-ish — run hourly and filter by TZ, or
        a single UTC run for v1): "Your 15 minutes are back." Only to users who **hit their cap** the
        prior week (engaged, capped → highest re-engagement value).
- [ ] **Idempotency / no double-send:** `CREATE TABLE minute_nudges_sent (user_id, nudge_kind text,
      period_key text, sent_at, PRIMARY KEY (user_id, nudge_kind, period_key))` — `period_key` =
      iso_week or date bucket. Cron inserts-on-conflict-do-nothing BEFORE sending; only sends if it
      claimed the row (exactly-once like `voice_usage_turns`). Service-role-only, explicit grants.
- [ ] `vercel.json` crons += the two nudge paths **and the GC crons** (R2-S7): prune
      `minute_nudges_sent` (> 90 d) and `stripe_events` (> 30 d) so neither table grows unbounded.
      All are GET handlers, CRON_SECRET-guarded. Email templates in `src/lib/email/templates/`.
- [ ] Respect a future unsubscribe flag — add `profiles.email_nudges_opt_out boolean DEFAULT false`
      and honor it (CAN-SPAM hygiene even for transactional-ish nudges; include an unsubscribe link).

### Tests

- [ ] route auth (401 without bearer), idempotent claim (second run same period → 0 sends),
      opt-out honored, sandbox/failed not marked sent.

### Edge cases

- Timezone: v1 sends the weekly "back" email on a single UTC schedule; acceptable. "Expiring in 24h"
  is computed per-user from `expires_at` / weekly boundary so it's TZ-correct enough.
- Volume: at seed scale this is tiny; the activity filter + idempotency table keep it bounded.

---

## 8. Phase 6 — Self-serve paid tiers (Evangelist + Boardroom)  *net-new Stripe*

**FINAL MODEL (locked 2026-06-16).** Two self-serve subscriptions, both shown on the payment-plans
page, both **repurposing the EXISTING `profile_tier` enum** (`premium` = "Evangelist", `boardroom`).
**No `supporter_until` flag, no new enum value** — a paid sub flips the user's `tier` (via the webhook,
service-role), the tier's **monthly avatar-talk allowance** is the entitlement, and lapse reverts to
`free`. This reuses the whole tier→caps machine (`tier_default_voice_caps`, the sessions trigger,
`voice_monthly_cap_seconds`) instead of bolting on a parallel flag.

| Display tier | enum | Price | Avatar-talk cap/mo | Advertised | COGS @ $0.028/min | Net after Stripe |
|---|---|---|---|---|---|---|
| **Evangelist** | `premium` | **$3.36/mo** | **110 min** | "~200 min conversation" | $3.08 | **≈ break-even (+$0.06)** |
| **Boardroom** | `boardroom` | **$27/mo** | **800 min** | "1000 min conversation" | $22.40 | **+$3.52** |

Both are **uncapped-days** (daily cap set ≥ monthly so the monthly allowance is the only binding cap),
no weekly cap. Referral/share **wallet** minutes stack on top of the monthly allowance.

**Web-verified (Prime Directive — §11):** Stripe webhook in Next.js App Router reads the **raw body**
via `await req.text()` (never `req.json()`), verifies `stripe-signature` with
`constructEvent(rawBody, sig, secret)`, **dedups on `event.id`** (retries ≤ ~72 h → keep ≥ 3 days).
User↔payment mapping = **`client_reference_id`** (our user UUID) on the Checkout Session; renewals fire
**`invoice.paid`** keyed by the stored Customer. **Stripe fees:** $3.36 falls under the **micropayments
rate (5 % + $0.05 ≈ $0.22)** *if enabled by Stripe* — else standard 2.9 %+$0.30 ≈ $0.40 (which makes
Evangelist a small loss; **confirm micropayments pricing before launch**). $27 uses the standard rate
($1.08).

### Tier-cap changes (single source of truth = `tier_default_voice_caps`)

- [ ] Update `tier_default_voice_caps(tier)` (migration) to the avatar-talk **monthly** model. The cap
      columns already mean "avatar-talk (assistant-audio) seconds" — the existing meter (`voice_usage_*`)
      counts assistant/Fish audio seconds, so **avatar-talk metering needs NO mechanism change** (R3 /
      Vuk lock): only the cap VALUES move.
  - `free`      → daily = **300 s** (5 min/day sub-cap, keeps the daily nudge), weekly = NULL,
    monthly = **2400 s** (40 min/mo). *(Free keeps a daily sub-cap; paid tiers don't.)*
  - `premium`   → daily = monthly (uncapped days), weekly = NULL, monthly = **6600 s** (110 min).
  - `boardroom` → daily = monthly (uncapped days), weekly = NULL, monthly = **48000 s** (800 min).
  - All env-overridable (`TIER_*_MONTHLY_SECONDS`) so the numbers tune without a migration. The helper
    still RAISES on an unknown enum variant (R2-S8) — no new variant added, so safe.
- [ ] **`effective_remaining` (and `voice_usage_record_v2` overflow) MUST include the monthly cap**
      (R3 follow-on): `free_avail = max(0, min(daily−daily_used, weekly−weekly_used,
      monthly−monthly_used))`. Without the monthly term, premium/boardroom wallets would never draw
      after the monthly allowance is spent (their daily/weekly are unbounded). Monthly-used:
      **calendar month for free**, **billing-period (`stripe_customers.current_period_start`) for paid**
      (avoids the signup-month double-dip — thin margins). `voice_usage_ticket_check` already computes a
      calendar-month SUM; extend it to read the billing-period start for subscribed users.

### Schema — migration `20260616000004_stripe_paid_tiers.sql`

- [ ] `CREATE TABLE stripe_events (event_id text PRIMARY KEY, type text NOT NULL, received_at
      timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, payload jsonb CHECK (payload IS NULL
      OR octet_length(payload::text) <= 16384))` — webhook dedup + audit. RLS + zero policies +
      `GRANT ALL … TO service_role`. Retain ≥ 3 days; GC cron prunes > 30 days.
- [ ] `CREATE TABLE stripe_customers (user_id uuid PK REFERENCES profiles(id) ON DELETE CASCADE,
      stripe_customer_id text UNIQUE NOT NULL, subscription_id text, price_id text, tier profile_tier,
      status text, current_period_start timestamptz, current_period_end timestamptz, updated_at
      timestamptz)`. **`price_id` + `tier` columns** map each of the two SKUs to its tier (R2-S6 footer:
      RLS + zero policies + service_role grant). `current_period_start` drives the paid monthly-allowance
      boundary.
- [ ] **No `supporter_until` column** (dropped from Phase 1 — superseded by tier flip).
- [ ] Service-role **`set_profile_tier_from_subscription(user, tier)`** RPC: the webhook's path to flip
      tier without admin auth. Writes `tier` + tier-default caps (reuses `tier_default_voice_caps`).
      Does NOT raise on an active session (tier is snapshotted at session-open, so a live session is
      unaffected — unlike `admin_set_profile_tier` which blocks; the sub flip must not block). REVOKE
      public/anon/authenticated; GRANT service_role only.

### Routes

- [ ] `POST /api/stripe/checkout` — auth'd (`getCallerUserId`), body picks `tier` (evangelist|boardroom),
      creates a Checkout Session (mode `subscription`, the matching `price_id`, `client_reference_id =
      userId`, reuse/create Customer, `success_url`/`cancel_url`), returns `{url}`. Client redirects.
- [ ] `POST /api/stripe/webhook` — raw body, `constructEvent`, insert `stripe_events` (dedup on
      `event_id` → 200 no-op), then dispatch:
  - `checkout.session.completed` → **map + flip**: upsert `stripe_customers` (`client_reference_id` →
    user, store `customer`/`subscription`/`price_id`/`tier`/`current_period_start`/`_end`), then
    `set_profile_tier_from_subscription(user, tier_for_price_id)`. (No wallet grant — the monthly
    allowance IS the entitlement.)
  - `invoice.paid` / `invoice.payment_succeeded` → renewal: refresh `current_period_start`/`_end` from
    the **subscription line item's `period`** (`invoice.lines.data[].period`, NOT invoice-level —
    R2-M5), re-affirm tier. No per-invoice wallet grant (allowance is monthly-cap-based, resets with
    the billing period automatically). Dedup any side-effect on `invoice.id`.
  - `customer.subscription.updated` (downgrade/upgrade between the two tiers) → re-flip tier to the new
    `price_id`'s tier.
  - `customer.subscription.deleted` / final lapse → `set_profile_tier_from_subscription(user, 'free')`.
    **Earned wallet minutes persist** (they're bought/earned, not the allowance).
  - Return 200 fast; idempotent; never trust the client. Missing user-mapping → store event, 200,
    reconcile on retry — no 500/retry-storm.
- [ ] **Lapse safety net (cron):** a daily `GET /api/cron/subscription-reconcile` flips any
      `tier IN (premium, boardroom)` whose `stripe_customers.current_period_end < now()` AND status not
      active → `free` (covers a missed `subscription.deleted` webhook). CRON_SECRET-guarded.
- [ ] Envs: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_EVANGELIST`,
      `STRIPE_PRICE_BOARDROOM`. Webhook route `runtime='nodejs'`, fail-closed if secrets missing.
- [ ] `src/lib/stripe/client.ts` (server-only SDK init), `src/lib/stripe/grant-from-event.ts`
      (pure dispatch — maps `price_id` → tier, unit-testable).

### Copy (value-led)

- [ ] **Evangelist:** "$3.36/mo — that's literally what it costs us to run your conversations. No
      markup, just keeping the lights on. ~200 min of real talk + download your conversations + no
      daily limit." (The odd number IS the message — radical transparency.)
- [ ] **Boardroom:** "$27/mo — 1000 min, the works." `/upgrade` page renders both cards;
      `source=in_session|cap_hit|meter` tracked.

### Tests

- [ ] webhook: signature-invalid → 400; duplicate `event.id` → 200 no-op, no double tier-flip;
      `checkout.session.completed` (evangelist price) → `stripe_customers` upsert + tier→premium;
      (boardroom price) → tier→boardroom; `subscription.deleted` → tier→free, wallet untouched;
      `invoice.paid` refreshes period; missing user-mapping → logged, 200. Use
      `stripe.webhooks.generateTestHeaderString` + fixture payloads.
- [ ] `grant-from-event.test.ts` — `price_id` → tier mapping; unknown price → ignored + Sentry.
- [ ] pgTAP: `stripe_events` PK dedup; `stripe_customers` upsert; `set_profile_tier_from_subscription`
      flips tier + caps + does NOT block on active session; monthly allowance read per billing period.

### Edge cases

- Webhook before the profile row exists → store event, 200, reconcile on retry. Don't 500.
- Double-charge / replay → `event.id` dedup = exactly-once tier flip.
- Refund/chargeback (`charge.refunded`, dispute) → v1: log + admin downgrades manually; no auto-claw.
- `past_due` → `current_period_end` already set; the reconcile cron lapses it to free if unrenewed.
- Tier upgrade evangelist→boardroom mid-period → `subscription.updated` re-flips; the new monthly cap
  applies on the next session-open (tier snapshot). Proration is Stripe's concern, not ours.
- **Creator subscriptions ($97/mo, the funding engine) are OUT OF SCOPE here** — a separate Stripe
  product + creator-facing flow in the creator-studio/journey workstream. Noted as the economic
  backstop (1 creator ≈ funds ~86 maxing free users), not built in this plan.

---

## 9. Phase 7 — COGS reconciliation (hard constraint)

"Ledger must reconcile against cogs_log." Grants/allowances are money. **Real all-in COGS (verified
2026-06-16 from code + web) ≈ $0.028 per minute of avatar talk** (Fish TTS $0.013 + Simli Trinity-1
~$0.010 + decoupled brain ~$0.005; Gemini audio-out is neutered to ~$0 via the `maxOutputTokens=24`
cap — [gemini-bridge.js:369](../../server/voice-proxy/gemini-bridge.js#L369)). Free user maxes at
40 avatar-talk-min/mo ⇒ **~$1.12/mo** ceiling.

- [ ] **Admin viewer:** `/admin/minutes` (admin-guarded) — per-user + global: Σ grants by type,
      wallet_spent, allowance used, supporter status, and the **$ implied** (granted-minutes ×
      blended COGS rate) vs **actual** voice COGS from `cogs_log`. Read-only.
- [ ] **R3-#5 — the blended COGS rate is a PINNED env, not a magic number:** `MINUTES_BLENDED_COGS_USD_PER_MIN`
      + `MINUTES_BLENDED_COGS_QUOTED_AT` (seeded from the verified **~$0.028/avatar-talk-min** all-in,
      2026-06-16), following the `*_QUOTED_AT` convention used everywhere else COGS is money
      (CLAUDE.md). The viewer + reconcile script read it; updating the rate is a config flip with an
      audit trail, never a hardcoded literal.
- [ ] **Reconcile script:** `scripts/minutes-reconcile.mjs` (sibling to the existing
      `scripts/session-cogs-breakdown.mjs`) — for a date range: total granted seconds, total consumed
      seconds (voice_usage), total billed COGS $ (cogs_log voice legs), and flag drift
      (granted ≫ consumed ≫ billed mismatches, negative wallet, orphaned grants).
- [ ] **Invariant checks** (could be a periodic cron alert later): `wallet_spent_seconds ≤
      Σ ever-granted seconds` per user; no `effective_remaining < 0`; `profiles.tier` consistent with
      `stripe_customers.tier`/`status` (a `premium`/`boardroom` user with no active sub = a missed
      lapse → the reconcile cron catches it, §8).

### Tests

- [ ] script smoke test on seeded data; admin route auth + shape.

---

## 10. Cross-cutting: env flags, rollout order, RLS/grants checklist

- [ ] **Flags:** `GROWTH_LEDGER_ENABLED`, `GROWTH_SOFT_GATE_ENABLED`, `GROWTH_METER_ENABLED`,
      `GROWTH_REFERRAL_MINUTES_ENABLED`, `GROWTH_NUDGES_ENABLED`, `GROWTH_PAID_TIERS_ENABLED`.
      Strict `=== '1'` parse (CLAUDE.md voice-flag convention). Proxy-side flags are Fly secrets;
      Next-side are Vercel envs. Co-flip where a flag is read on both sides (document each).
- [ ] **Tunables (env, pinned, with `_QUOTED_AT` where they're money):**
      `TIER_FREE_MONTHLY_SECONDS` (2400 = 40 min), `TIER_FREE_DAILY_SECONDS` (300 = 5 min/day sub-cap),
      `TIER_PREMIUM_MONTHLY_SECONDS` (6600 = 110 min, Evangelist),
      `TIER_BOARDROOM_MONTHLY_SECONDS` (48000 = 800 min),
      `REFERRAL_VERIFIED_SECONDS` (900), `SHARE_TAP_SECONDS` (60), `SHARE_TAP_DAILY_CAP` (2),
      `RECRUITER_BONUS_PER_SIGNUP_SECONDS` (60), `RECRUITER_BONUS_CEILING_SECONDS` (1800, LIVE cap R3-#3;
      column CHECK is a 7200 wall), `SIGNUP_BONUS_SECONDS` (900), `REFERRAL_LIFETIME_CAP_SECONDS` (18000),
      `REFERRAL_VELOCITY_PER_DAY` (10), `SOFT_GATE_IDLE_KILL_MS` (25000, R1-C5),
      `ABSOLUTE_DAILY_COGS_CEILING_SECONDS` (14400, R2-C1),
      `MINUTES_BLENDED_COGS_USD_PER_MIN` + `_QUOTED_AT` (**0.028/avatar-talk-min**, verified 2026-06-16),
      `STRIPE_PRICE_EVANGELIST` + `STRIPE_PRICE_BOARDROOM` (the two self-serve sub price-ids, §8).
- [ ] **Every new table** ends with explicit `GRANT … TO service_role` (+ sequence grants); RLS enabled;
      service-role-only tables get **zero** policies (CLAUDE.md hard rule).
- [ ] **Every new SECURITY DEFINER fn** ends with REVOKE-from-public/anon/authenticated + GRANT-to-service_role
      (+ self-read where intended) — the secdef grant-leak rule from the 2026-06-01 incident.
- [ ] **R1-M1 — profiles column allowlist.** Table-wide UPDATE for `authenticated` is ALREADY revoked
      ([20260525000010:22-24](../../supabase/migrations/20260525000010_security_audit_fixes.sql)) with an
      explicit grant on `(display_name,bio,handle,goals,obstacles,timezone,onboarded_at)`. So the new
      trust-bearing columns (`wallet_active_seconds`, `wallet_spent_seconds`,
      `recruiter_bonus_daily_seconds`) are **safe by default** — do NOT add them to the grant. `tier` is
      already admin/webhook-only. The ONE column a user legitimately edits,
      `email_nudges_opt_out` (§7), MUST be explicitly added to the column grant or the opt-out path 403s.
- [ ] **R1-S3 — `voice_balance_check` grant is pinned: service-role only** (REVOKE public/anon/
      authenticated). The always-on meter route (§5) calls it server-side as service-role for the
      caller's own `getCallerUserId()`. We do NOT grant `authenticated` (avoids a caller-supplied-id
      balance-disclosure oracle — the exact shape of the 2026-06-01 leak). If a direct client call is
      ever wanted, it needs the `auth.uid() = p_user_id` self-guard + a test first.
- [ ] **R1-S6 — Vercel cron sends GET.** All new cron routes are `GET` handlers (match
      `cleanup-verifications`), Bearer-`CRON_SECRET` (≥ 32 chars, import-time fail-closed),
      constant-time compare. Not POST.
- [ ] **Full `npm run db:test`** after each migration phase (not just the new file) — schema-change
      blast-radius discipline. `db:reset` THEN `db:test` (local Docker, Vuk-authorized standing).
- [ ] **`npm run build`** (Vercel's gate) before any push to main.
- [ ] Migration order is strictly 20260615000001 → …0002 → …0003 → 20260616000004 (deps: balance RPC
      needs the table + wallet cols; record_v2 needs wallet_spent col; referral grants need
      minute_grant_insert; paid-tiers migration needs the updated `tier_default_voice_caps` +
      `stripe_customers` + `set_profile_tier_from_subscription`).

## 11. Web-verified stack facts (Prime Directive — sources)

- **Stripe webhook in Next.js App Router:** raw body via `await req.text()` (NOT `req.json()`),
  verify `stripe-signature` with `stripe.webhooks.constructEvent()` (HMAC-SHA256 + timestamp →
  replay-safe). Sources: Stripe docs *Resolve webhook signature verification errors*; Next.js
  discussion #48885; Kitson Broadhurst / SimRunBot gists (App Router patterns).
- **Idempotency:** dedup on Stripe `event.id` (`evt_…`) via a PK table; Stripe retries on backoff up to
  ~72 h → retain dedup rows ≥ 3 days. Dedup ≠ idempotent handler logic — make the grant itself
  idempotent (we do, via `minute_grants` dedup index). Sources: Hookdeck dedup guide; DEV "How I Handle
  Stripe Webhooks in Production"; digitalapplied 2026 reliability reference.
- **User mapping:** `client_reference_id` on the Checkout Session = our user UUID; completed session
  carries Customer + Subscription; renewals via `invoice.paid`/`invoice.payment_succeeded` keyed by the
  stored Customer. Sources: Stripe Checkout Sessions API ref; cjav.dev / Tomas Zezula payment-link
  data-passing.
- **Resend:** existing `send-email.ts` already distinguishes `sent_sandbox` — a verified custom domain
  is a hard prerequisite for Phase 5 (sandbox only reaches the account owner).

## 12. Decisions — LOCKED 2026-06-16

All resolved with Vuk; no open gates remain (the build proceeds once the post-lock audit is applied).

1. **Ledger model:** ✅ Option A — hybrid allowance + non-expiring wallet.
2. **Recruiter perk:** ✅ profile cap-bump column (`recruiter_bonus_daily_seconds`).
3. **Paid tier shape:** ✅ **repurpose the EXISTING `premium`/`boardroom` enum** via Stripe-webhook tier
   flip — NOT a `supporter_until` flag, NOT a new enum value. (§8)
4. **Checkout:** ✅ server-created Checkout Session (redirect); seamless-buy deferred (§4/#7).
5. **Free tier:** ✅ **40 avatar-talk-min/month + a 5-min/day sub-cap** (keeps the daily nudge). Metered
   in avatar-talk seconds (already the meter). Advertised "~80 min chatting" (verify ratio from data).
6. **Paid tiers:** ✅ **two self-serve subs, both on the payment-plans page** — Evangelist (`premium`)
   $3.36/mo / 110 avatar-talk-min ("priced at cost", break-even); Boardroom (`boardroom`) $27/mo /
   800 avatar-talk-min (+$3.52 margin). (§8)
7. **Mid-session payoff UX:** ✅ **redirect + re-open for buy** (memory makes it continuous); **seamless
   for the share-to-earn** path; embedded-checkout seamless-buy = post-native fast-follow. (§4)
8. **Share-tap grants:** ✅ non-expiring (all wallet grants are).

**Open items that are CONFIG, not blockers** (tune from `cogs_log` + provider quotes; no code change):
the exact avatar-talk ratio (validates the "80 min"/"200 min" ad copy), Fish volume rate, Simli's exact
<1¢, and whether Stripe enables micropayment pricing for the $3.36 charge.

## 13. Risks / watch-items (post-audit)

- Per-turn `wallet_spent` overflow race — **mitigated** by computing `*_before` from the row-locked
  upsert `RETURNING` inside one txn (R1-C3.2); re-verify in TDD with a concurrent-turn test.
- Fuse reconciliation (R2-C1, supersedes R1-M7): the 150 % fuse anchor is set per-open to
  `min(daily_cap_eff + wallet_remaining, ABSOLUTE_DAILY_COGS_CEILING)` — scales with legitimate
  entitlement, hard-bounded by the absolute ceiling; the wallet's own lifetime cap prevents a
  sock-puppet from inflating it past the ceiling.
- Soft gate: **server-owned** idle kill (R1-C5), not a client timer — must teardown to release Simli.
- Stripe: entitlement on `invoice.paid` only (R1-M5/M6); webhook-before-profile-ready → 200 + reconcile;
  refund/chargeback not auto-clawed in v1 (admin-handled).
- Email domain not verified → Phase 5 blocked; cron must not mark sandbox/failed as sent.
- Grant idempotency keys (`token_hash`, `invoice.id`, `signup:uid`) unique per `(grant_type, source_kind,
  source_key)` or a collision silently suppresses a legit grant.
- Full-suite pgTAP discipline: signature changes to `voice_usage_record` / `voice_check_quota` /
  `session_open` / `session_rollover` cascade into existing tests + the proxy caller — grep + full run.

## 14. Audit Round 1 — resolution log (auditor subagent, applied)

**CRITICAL**
- **C1** Wallet invisible at open → 429'd despite balance. **Fix:** unified `voice_balance_check`
  feeds the open 429 gate; Phase 1 re-scoped to include the gate rework (§3 "Unified gate").
- **C2** `max_duration_s` was System-A daily-only. **Fix:** `min(GEMINI_MAX, effective_remaining)` on
  fresh + takeover paths (§3).
- **C3** `wallet_spent` vs weekly reset / expiry corruption. **Fix:** all wallet grants **non-expiring**
  → `Σgrants − wallet_spent` is exact; overflow computed from row-locked `RETURNING` in one txn;
  `free_avail = min(daily, weekly)`; wallet bypasses the daily cap (§3 model block).
- **C4** Self-referral printer (guard didn't exist). **Fix:** self-referral guard + device_fp/ip
  distinctness on the recruiter bump + caps tied to referrer, all inside the new atomic RPC (§6.2).
- **C5** Soft gate leaked Simli minutes via frozen client timer. **Fix:** server-owned idle kill →
  `teardown()` + `closeWs(4015)` after `SOFT_GATE_IDLE_KILL_MS` (§4). [close code corrected 4013→4015 in R2-C4]

**MEDIUM**
- **M1** New trust columns safe-by-default (table UPDATE already revoked); `email_nudges_opt_out` needs
  an explicit column grant (§10).
- **M2** `tier_exhausted` must equal the open-gate `effective_remaining`, not System-A daily (§4).
- **M3** `session_rollover` (and `session_open` NULL-fallback) use a stale hardcoded tier CASE — fix to
  read the unified balance in the same migration (§3).
- **M4** Referral credit + grants + recruiter bump in ONE SECDEF txn returning a structured result (§6.2).
- **M5** `current_period_end` not on `checkout.session.completed` → set entitlement from `invoice.paid`
  (retrieve subscription if needed) (§8).
- **M6** Double `paid_topup` (both events) → grant on `invoice.paid` only, dedup on `invoice.id` (§8).
- **M7** Recruiter/supporter raise USABLE allowance, not the 150 % fuse anchor (§6, §8).

**SMALL** — S1 (different per-turn vs grant ceilings: documented), S2 (dropped `weekly_refill` enum),
S3 (`voice_balance_check` service-role only), S4 (share-tap non-expiring), S5 (`stripe_events.payload`
octet cap), S6 (cron GET handlers), S7 (match FLOOR/clamp semantics in the gate), S8 (no new tier into
`tier_default_voice_caps`). All folded into §3/§7/§8/§10.

## 15. Audit Round 2 — resolution log (independent auditor pass, applied)

R2 verified R1's self-referral / column-allowlist / Stripe-dedup / soft-gate-concept fixes as sound,
and found the R1-C1/C2 "wallet reachable" fix was **incomplete on three fronts** plus a close-code
collision. All applied:

**CRITICAL**
- **R2-C1** 150 % System-A fuse fires at 150 % of BASE cap (free = 450 s) → kills every wallet/supporter
  user regardless of balance. **Fix:** fuse becomes a runaway-COGS backstop, not a tier enforcer —
  set `daily_quotas.daily_limit_s = min(daily_cap_eff + wallet_remaining, ABSOLUTE_DAILY_COGS_CEILING)`
  at open/rollover. Supersedes R1-M7's "anchor to base cap." (§3 R2-C1 block)
- **R2-C2** Hardcoded `Math.min(…, 600)` clamp caps EVERY session at 10 min on open AND rollover.
  **Fix:** remove the `600` literal; `max_duration_s = min(GEMINI_MAX, effective_remaining)`. (§3)
- **R2-C3** `/api/sessions/rollover/route.ts` entirely unthreaded — rollover reverts to System-A limits
  + a stale hardcoded CASE. **Fix:** add the route to Phase-1 gate rework; clamp + fuse-anchor it. (§3)
- **R2-C4** Close code `4013` already in use (`brain_unset_with_…`). **Fix:** use `4015`; fix the stale
  close-code header table. (§4)

**MEDIUM**
- **R2-M1** Two contradictory recruiter formulas + an uncomputable counter. **Fix:** one formula,
  recruiter on the daily side only, applied identically in balance + per-turn. (§3)
- **R2-M2** Per-turn `SUM(minute_grants)` is an unbounded hot-path aggregate. **Fix:** materialized
  `profiles.wallet_active_seconds` (O(1)). (§3)
- **R2-M3** `grantSignupBonus` from `saveOnboarding` (authenticated client) 403s the service-role grant
  RPC. **Fix:** call via `supabaseAdmin()`. (§6.2)
- **R2-M4** Sock-puppet guard can't see the referrer's own device. **Fix:** persist minter fp/ip at mint
  time; lifetime/velocity caps are the real backstop. (§6.2)
- **R2-M5** `current_period_end` must come from the line-item `period.end`, not invoice-level. **Fix:**
  pin `invoice.lines.data[].period.end` + a test. (§8)
- **R2-M6** Idle timer must clear SYNCHRONOUSLY before the awaited gate, else it kills a just-rescued
  session. **Fix:** clear at the first line of `turn_start`. (§4)
- **R2-M7** Per-day/lifetime caps as `COUNT`-then-`INSERT` race. **Fix:** atomic counter-row UPSERT with
  `WHERE count < cap`. (§6.1/§6.3)

**SMALL** — S1 (admin_adjustment NULL dedup documented), S2 (recruiter ceiling CHECK vs env drift noted),
S3 (premium-poisons-weekly edge case documented), S4 (close-code table), S5 (rename lockstep + full
db:test), S6 (`stripe_customers` RLS footer), S7 (GC crons added to vercel.json). Folded into §3/§6/§7/§8.

> **Status after R2:** the central wallet-reachability gap is now closed on all three fronts (fuse,
> clamp, rollover) and the close-code collision fixed. R2 recommended a **Phase-1-specific re-audit**
> before code — surfaced as an option at the approval gate (it is NOT auto-run; per standing guidance
> the next audit round is Vuk's call).

## 16. Round 3 — external review pass (applied)

A third independent pass confirmed the live-system read is accurate and the design is build-ready
pending gate picks, and surfaced 5 items — 3 quick fixes + 2 decisions-disguised-as-resolved:

- **R3-#1 (real gap)** In-session "buy → keep talking" is capped by the OPEN-time `max_duration_s`
  clamp; clearing the soft gate isn't enough. **Fix:** proxy pushes `{type:'minutes_extended',
  max_duration_s}` on a mid-session grant (seamless), or set the "tap to start fresh" expectation.
  Now a gate decision (§12.7). (§4)
- **R3-#2 (decision)** Two-SKU support ($1 +60 min / $2 cap-lift) was collapsed to one SKU; supporter
  ceiling 3600 s assumed. Surfaced as gate decision §12.6 + §8 SKU block. (§8)
- **R3-#3 (fix)** `RECRUITER_BONUS_CEILING_SECONDS` was a dead knob (column CHECK + RPC both hardcoded
  1800). **Fix:** column CHECK → 7200 safety wall, RPC reads the env as the live cap. (§3, §6.2)
- **R3-#4 (decision)** Decision §12.5's "keep 5/day + 15/week" lean contradicted the brief/brainstorm
  weekly-bucket intent; the "daily anchors the fuse" rationale is moot post-R2-C1. Re-leaned to
  pure-15/week as the honest default. (§12.5)
- **R3-#5 (fix)** §4's `voice_check_quota_v2` still described a per-turn `SUM(minute_grants)` — corrected
  to read the materialized `wallet_active_seconds` column (R2-M2, hot path). Phase 7 blended COGS rate
  pinned as `MINUTES_BLENDED_COGS_USD_PER_MIN` + `_QUOTED_AT`, not a magic number. (§4, §9)

## 17. Round 4 — paid-tier model audit (applied)

Single authorized pass after the Evangelist/Boardroom restructure. It **verified the load-bearing claim**
(the cap meters **avatar-talk seconds** — `recordVoiceUsage` records `assistantSeconds` = Fish/Cartesia
audio, never input; [index.js:906](../../server/voice-proxy/index.js#L906); the "inputSeconds+audioSeconds"
comment is System A, a *separate* fuse meter). But it found 5 critical + 6 medium holes in the new model.

**CRITICAL (applied)**
- **R4-C1** Plan patched a **superseded** migration. Live `session_open` = `20260522000100`,
  `session_rollover` = `20260522000104` (both still hold the stale 600/3600/14400 CASE); `tier_default_voice_caps`
  = unsuperseded `20260510000001`. **Fix:** patch the highest-timestamp bodies (re-grep at build); §3 updated.
- **R4-C2/C3** The monthly term was in prose but the per-turn overflow used only daily+weekly, and a
  billing-period `monthly_before` is uncomputable without a counter. **Fix:** new `voice_usage_monthly`
  counter (period-keyed) + monthly added to the `LEAST()` in both `voice_balance_check` and
  `voice_usage_record_v2`. This makes paid-user wallet-draw actually work. (§3)
- **R4-C4/M6** Four RPCs each compute "monthly" independently → drift + a NULL-period unbounded window.
  **Fix:** ONE shared `monthly_window_start(user_id)` SQL helper (`COALESCE(active-sub period_start,
  calendar month)`), called by every monthly reader. (§3)
- **R4-C5** Mid-session lapse (`subscription.deleted`) lowers the cap columns while the live session's
  System-A fuse anchor stays at the open-time (higher) entitlement → user keeps an allowance they no
  longer pay for until rollover (and rollover re-hands it via the stale CASE, R4-C1). **Fix:**
  `set_profile_tier_from_subscription` must **NOT lower caps for a user with `ended_at IS NULL`** — flip
  `tier` (billing/routing) but defer the cap-column write until session end (or let the corrected
  monthly check kill at rollover). Symmetrically, an **upgrade** mid-session only takes effect on
  re-open (open-time clamp) — document "re-open to use your new minutes" for paid upgrades too (mirrors
  R3-#1 buy flow).

**MEDIUM (applied)**
- **R4-M1** Boardroom `daily=48000` → fuse anchor `min(48000+wallet, 14400)=14400`; the 4 h ceiling
  (sized for free) false-positive-kills a legit boardroom long day. **Fix:** make
  `ABSOLUTE_DAILY_COGS_CEILING_SECONDS` **tier-scaled** (`ABSOLUTE_DAILY_COGS_CEILING_SECONDS[tier]`),
  e.g. free 14400 / premium 14400 / boardroom 28800; document as a product decision, not a silent default.
- **R4-M2** Evangelist is **break-even ONLY under Stripe micropayments pricing (5%+$0.05), which is an
  account-level enablement, not default.** At standard rate it's a **−$0.12/user/mo loss**, and a 10 %
  COGS miss makes even the micro case negative. **Fix:** gate the Evangelist SKU launch (and the "at
  cost / no markup" copy — else it's literally false) on **written confirmation micropayments pricing is
  active**; treat $0.028/min as provisional until `cogs_log` + Fish/Simli quotes land. (§8)
- **R4-M3** Paid-tier consumption has **no `minute_grants` row** to reconcile against (the monthly
  allowance is the entitlement, not a grant) → invisible to the §9 "ledger reconciles vs cogs_log"
  constraint. **Fix:** §9 reconcile treats the monthly allowance as an implicit grant (tier cap ×
  active-sub-months) or a separate paid reconciliation path (consumption vs `stripe_customers` period × cap).
- **R4-M4** `resolveAvatarProvider` reads `AVATAR_PROVIDER_PREMIUM`/`_BOARDROOM`; if unset in prod
  (only `_FREE` is in active use), a user who **pays** gets `avatar=null` → 503 (FORCE_AVATAR_REQUIRED)
  or silent voice-only. **Fix:** set `AVATAR_PROVIDER_PREMIUM=simli` + `AVATAR_PROVIDER_BOARDROOM=simli`
  in Vercel prod **before launch** + a boot/test assertion that every webhook-producible tier has a
  non-null avatar env. (Pre-launch checklist item.)
- **R4-M5** With `daily=monthly`, a paid user out of MONTHLY minutes gets the `daily_cap_hit` 429 + the
  free-tier "resets in 24h" copy (false — resets in ~27 days). **Fix:** thread a `cap_period`
  discriminator (`daily|weekly|monthly`) through the 429 body + the `tier_exhausted` control message so
  the client renders period-correct reset copy. (§2/§4/§8)

**SMALL (applied)** — `set_profile_tier_from_subscription` writes an `admin_audit_log`/`tier_change_log`
row (webhook flips were invisible to the audit trail); the reconcile cron also catches an **orphaned**
paid `profiles.tier` with no `stripe_customers` row (not just expired ones); Stripe audit rows go to a
`metadata` table, NOT `cogs_log` (no `stripe` in `cogs_service`); re-grep `tier_default_voice_caps` before
`CREATE OR REPLACE` to confirm no intervening redefinition.

> **Status after R4:** the metering denomination (the pricing model's foundation) is **verified correct**.
> The paid-tier mechanics needed real fixes — all applied above. Net new build artifacts vs pre-R4: a
> `voice_usage_monthly` counter, a `monthly_window_start()` helper, tier-scaled COGS ceiling, a
> `cap_period` discriminator, the lapse-during-session cap deferral, and two pre-launch env/Stripe gates
> (avatar envs, micropayments pricing). No architectural change — the model holds.
