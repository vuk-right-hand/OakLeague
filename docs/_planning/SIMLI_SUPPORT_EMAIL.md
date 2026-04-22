---
Draft — Simli support email (Trinity-tier written pricing at 100K/mo commit)
Purpose: lock the free-tier ceiling rate in SPIKE_B_PLAN.md before Phase 4.
Send to: support@simli.com (cc: sales@simli.com if separate)
From: vukpjescic@gmail.com — founder, OakLeague
Subject: Trinity-1 tier — written pricing at 100K audio-min/mo commit
---

Hi Simli team,

I'm Vuk, founder of OakLeague (oakleague.com, YC S26 applying May 6). We're
building interactive video mentorship — vertical 9:16 hook videos from creators
that tap-to-convert into a real-time conversational AI avatar of the creator
(voice answers in the creator's voice, lipsync-accurate avatar face). Our PWA
v1 ships in ~2 weeks.

We've benchmarked Simli Trinity-1 vs. Tavus Phoenix-4 and our architecture is
tiered: **Simli powers the free tier across ~95% of user minutes**; Tavus
handles premium/boardroom. We're in Phase 0 of a 3-day technical spike
(Apr 22–24) to validate both providers on mobile (iOS PWA + Android) before
we commit.

Two questions before we finalize the economics in our funding deck:

1. **Trinity-1 per-minute pricing at 100K audio-minutes/mo committed usage.**
   Your public pricing page shows pay-as-you-go and a self-serve tier; we need a
   written quote (or contract) for the 100K-min/mo committed volume so we can
   model unit economics at the 10K-DAU target. Ideally also a projection for
   300K–600K min/mo as we scale to YC Demo Day traffic.

2. **Trinity-1 activation.** Is `is_trinity_avatar` a
   - (a) session-level param (set per `startAudioToVideoSession` call),
   - (b) replica-level param (set at replica-training time; model must be retrained to switch), or
   - (c) account-level param (flag on our account)?

   This determines whether we can A/B Trinity vs. your default in a single
   session pair tomorrow, or whether we need to kick off a second training run.
   The docs at docs.simli.com are ambiguous on this — a one-line answer saves
   us 24h.

Other context that may help:
- Replica training starts tonight (Apr 21) — 2-min 48kHz/24-bit source, best
  frame already selected.
- Transport: Simli JS SDK + WS control (START/SKIP/DONE), RTCPeerConnection
  for video.
- Audio: PCM16 LE mono 16kHz from Gemini 3.1 Flash Live; testing both 6000B
  (187ms @ 16k) and 1920B (60ms) chunk sizes.
- Target: sub-400ms end-to-end lipsync on mobile (Pixel 7 Pro LTE, iPhone 11
  installed PWA); iOS PWA stress-test includes lock-screen 30s + 2min,
  Control Center, notifications.
- v1 deadline: YC S26 app due 2026-05-06.

Happy to jump on a 15-min call this week if useful.

Thanks,
Vuk Pjescic
Founder, OakLeague
vukpjescic@gmail.com
