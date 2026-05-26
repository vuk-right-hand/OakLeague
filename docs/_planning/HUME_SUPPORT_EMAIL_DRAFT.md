# Hume Support Email — Draft

**To:** support@hume.ai (or in-app support channel from app.hume.ai)
**From:** Vuk Pjescic — vukpjescic@gmail.com (Creator-tier account, commercial license)
**Subject:** Programmatic audio-upload voice cloning API — does it exist or is it on the roadmap?

---

Hi Hume team,

I'm building OakLeague (interactive video mentorship — YC S26 application submitted) and we're piloting Octave 2 against our current TTS provider for a production switch. Voice quality on my test clone has been excellent — really impressive emotional range.

We're a Creator-tier account (commercial license, just upgraded today). The one operational gap blocking us from rolling Hume out to all our creators is **programmatic voice cloning from an audio sample**.

I've verified the following endpoints over the last 24 hours against `api.hume.ai`:

- `POST /v0/tts/voices` accepts only JSON `{generation_id, name}` (voice DESIGN from prompt) — confirmed by the Python SDK source, the CLI source (`hume voices create --last`), the public reference page, and live probing with both API-key and OAuth Bearer auth.
- `POST /v0/voices/...` paths route to an internal `octave_custom_voices` controller but return 401 with API key and 401 with OAuth Bearer (access token minted via `oauth2-cc/token`).
- `POST /v0/evi/custom_voices` exists but rejects multipart with 415 — JSON-only.
- The Hume Platform UI at app.hume.ai/voices clearly does audio-upload voice cloning, but the endpoint it uses appears to require session-cookie auth not exposed to API keys.

**My questions:**

1. **Programmatic audio-upload voice cloning.** Is there a Hume API endpoint — public, private-beta, or enterprise — that accepts an audio file upload and returns a custom voice id for use with `/v0/tts/stream/input` (Octave 2)? If so, what's the path and request shape? If not currently exposed, is it on the roadmap?

2. **Consent attestation pattern.** If you require explicit voice-owner consent for clones, we're happy to capture it in our own dashboard (we already authenticate creators) and pass you an attestation token at clone time — signed `{consenter_id, consent_timestamp, consent_record_id, signature}`. Creator email and PII stay on our side; you get an opaque pointer plus a hot line into our records if you ever need to audit. Alternatively, if you'd prefer direct capture, we're open to iframe-ing or OAuth-redirecting creators to a Hume-hosted consent step inside our flow. Whichever you prefer.

3. **Workspace seats / sub-user access.** If programmatic upload is not available, is there a Teams/Workspace pathway where we invite creators as scoped sub-users under OakLeague's Hume org? We'd need: (a) creators can upload one voice into our voice library, (b) they can't see other voices or billing, (c) they don't need their own paid Hume account. The published Scale/Business plans (3/5 seats) won't scale beyond a small pilot — what does an enterprise contract look like for unlimited scoped sub-users?

4. **Synthesis parameter surface.** Re-probing your Python SDK 2026-05-13 we found these per-utterance params on `/v0/tts/stream/input`: `voice`, `description`, `speed`, `trailing_silence`. Confirming: is that the full surface? Any other prosody knobs (pitch, emphasis, stability, etc.) we're missing? And — your docs note acting-instructions (`description`) is "coming soon" on Octave 2 — any rough timeline?

5. **Recommended onboarding path for 100s–1000s of creators.** If none of the above is workable, what's your recommendation for our use case? Manually uploading via app.hume.ai per creator is not viable beyond a few dozen.

We're holding our migration on these answers. The dollar-amount business case for Hume in our stack is real (we estimate ~$42K/mo at our projected scale vs our current TTS provider), but the per-creator manual UI step would block adoption beyond a small pilot.

Happy to share use-case details, integration screenshots, or a demo if helpful.

Thanks,
Vuk

---

## Internal notes for Vuk

- **Where to send:** Probably the in-app support widget on app.hume.ai (top-right "Help" or similar). Email channel may bounce or be slow. Some SaaS support orgs only ack in-app tickets.
- **Account context for them:** Account UUID visible in our probe: `fc03dd98-13ec-49ac-9ab4-36c4b43d8565` (came back in a 404 error body from a name-keyed DELETE probe). Don't paste this; let them look it up by your email.
- **What we want from their reply:**
  - "Yes — enterprise endpoint at X, here's the docs" → SCENARIO A unlocked, do the 1-day UI swap. Best case.
  - "Yes — Teams with scoped sub-users, here's the plan tier" → next best. Creators clone via app.hume.ai under our workspace, never make their own account. UX cost: ~2 min of Hume-branded UI per creator during onboarding.
  - "Yes — on roadmap, ETA Y" → ship Scenario B v1 (manual paste by admin), schedule the swap for Y.
  - "No / no plans" on Q1 + Q3 → ship Scenario B v1, treat Hume as a per-creator-override only (no global env flip in §8.7). Cap pilot at ~20 creators that Vuk uploads manually.
- **Expected response time:** 1–2 weeks for a real answer in B2B SaaS. If 4+ weeks no response → ping again or chase a sales contact.
