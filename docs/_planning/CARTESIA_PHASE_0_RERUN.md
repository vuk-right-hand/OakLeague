# Cartesia Phase 0 Re-run

Generated: 2026-05-04T17:43:47.348Z
Script: scripts/cartesia-phase0-rerun.mjs
Cartesia version: 2026-03-01

## Results

- **1. open ≤ 1500ms** — PASS: open=232ms
- **1. open + TTFB ≤ Phase-0 baselines** — PASS: open=232ms ttfb=216ms
- **2. inbound envelope is JSON (no binary frames)** — PASS: chunks=4
- **3. frame coherence (R3-M3): pcm_s16le, byte%2===0, mime echoes** — PASS: total_bytes=80248 even=true mime=pcm_s16le@24000
- **4. continue:false flushes within 15s without flush:true** — PASS: total=6063ms
- **5. multi-digit <sessionId>:<turnNumber> context_id accepted** — PASS: ctx_id="phase0-rerun-sess:42" len=20

## Gate

This file is checked into the repo as part of the Cartesia wire-up PR. The
PR cannot merge without every check above showing **PASS** (R3-M7).
