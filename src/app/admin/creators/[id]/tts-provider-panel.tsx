'use client';

// HUME_TTS_PLAN §12.5 — admin TTS provider + Hume dials panel.
//
// Three sub-panels:
//   1. TTS Provider — dropdown that flips creators.tts_provider (per-creator
//      override; NULL = inherit VOICE_TTS_PROVIDER env).
//   2. Hume voice — paste form for { id, name } pair. Cross-creator name
//      collision returns 409 'hume_voice_name_in_use' from the action.
//   3. Hume prosody dials — speed, trailing silence, voice description,
//      model version. All env-scoped.
//
// All mutations call SECURITY DEFINER RPCs that combine row-level locking
// on creators with the active-sessions guard (audit M3 fix).
//
// Env selector (audit M4 fix): the panel infers the editor's env from
// NEXT_PUBLIC_VERCEL_ENV. Production deploys write to prod columns,
// preview deploys write to preview columns, etc. A small env badge is
// rendered above each form so the admin sees exactly which env they're
// affecting.

import { useTransition, useState } from 'react';
import { setCreatorTtsProvider, setCreatorHumeVoice, setCreatorHumeProsody } from './actions';

// FISH_AUDIO_PHASE_1 §6 — 'fish' joins the dropdown alongside cartesia + hume.
// Fish has no prosody dials in Phase 1; only the top provider override
// applies to fish creators (Fish reference_id is pasted via direct DB
// admin script today — the admin clone-upload UI is a follow-up).
type Provider = 'inherit' | 'cartesia' | 'hume' | 'fish';
type Env = 'production' | 'preview' | 'development';

type Props = {
  creatorId: string;
  initialTtsProvider: 'cartesia' | 'hume' | 'fish' | null;
  // FISH_AUDIO_PHASE_1 wiring audit C2 — env-scoped fish voice id, used to
  // warn the admin if they select 'fish' without having pasted a
  // reference_id first (otherwise the next session-open 4014s with no
  // panel-side hint).
  initialFishVoiceId: string | null;
  initialHumeVoiceId: string | null;
  initialHumeVoiceName: string | null;
  initialHumeTtsSpeed: number | null;
  initialHumeTrailingSilence: number | null;
  initialHumeVoiceDescription: string | null;
  initialHumeModelVersion: '1' | '2' | 'default' | null;
};

// HUME_TTS_PLAN §6 audit M4 fix — derive env from NEXT_PUBLIC_VERCEL_ENV
// at client load time. This is exposed to the browser by Next/Vercel and
// matches whatever VERCEL_ENV the route side uses. Default to
// 'development' so a local-laptop admin doesn't accidentally write to
// prod columns.
function clientCurrentEnv(): Env {
  const v = process.env.NEXT_PUBLIC_VERCEL_ENV;
  if (v === 'production') return 'production';
  if (v === 'preview')    return 'preview';
  return 'development';
}
const ENV: Env = clientCurrentEnv();

function envBadgeMeta(env: Env): { label: string; color: string } {
  if (env === 'production') return { label: 'PROD',    color: 'salmon' };
  if (env === 'preview')    return { label: 'PREVIEW', color: 'gold' };
  return { label: 'DEV', color: 'lightgreen' };
}

function EnvBadge() {
  const { label, color } = envBadgeMeta(ENV);
  return (
    <span style={{
      marginLeft: 8,
      padding: '2px 6px',
      borderRadius: 3,
      backgroundColor: color,
      color: '#111',
      fontSize: 11,
      fontWeight: 700,
      verticalAlign: 'middle',
    }}>{label}</span>
  );
}

export function TtsProviderPanel(props: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, marginTop: 12 }}>
      <ProviderSubPanel
        creatorId={props.creatorId}
        initial={props.initialTtsProvider ?? 'inherit'}
        initialFishVoiceId={props.initialFishVoiceId}
      />
      <HumeVoiceSubPanel
        creatorId={props.creatorId}
        initialId={props.initialHumeVoiceId}
        initialName={props.initialHumeVoiceName}
      />
      <HumeProsodySubPanel
        creatorId={props.creatorId}
        initialSpeed={props.initialHumeTtsSpeed}
        initialSilence={props.initialHumeTrailingSilence}
        initialDescription={props.initialHumeVoiceDescription}
        initialModel={props.initialHumeModelVersion ?? '2'}
      />
    </div>
  );
}

function ProviderSubPanel({
  creatorId,
  initial,
  initialFishVoiceId,
}: {
  creatorId: string;
  initial: Provider;
  initialFishVoiceId: string | null;
}) {
  const [value, setValue] = useState<Provider>(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave() {
    setStatus(null);
    startTransition(async () => {
      const res = await setCreatorTtsProvider({ creatorId, value });
      if (res.ok) {
        setStatus('saved');
      } else {
        // Audit C4 — reset dropdown to the committed value on error.
        setValue(initial);
        setStatus(`error: ${res.error}`);
      }
    });
  }

  return (
    <div style={{ border: '1px solid #222', padding: 12, borderRadius: 6 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>TTS provider override</h3>
      <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        Inherit = follow the proxy&apos;s VOICE_TTS_PROVIDER env. Set to
        cartesia, hume, or fish to override per-creator. Rejected while
        sessions are in-flight. Fish reference_id is pasted via direct
        service-role SQL today (admin upload UI is a follow-up).
      </p>
      <select
        value={value}
        onChange={(e) => setValue(e.target.value as Provider)}
        disabled={pending}
        style={{ padding: 6, fontSize: 13 }}
      >
        <option value="inherit">inherit env (default)</option>
        <option value="cartesia">cartesia</option>
        <option value="hume">hume</option>
        <option value="fish">fish</option>
      </select>
      {value === 'fish' && initialFishVoiceId == null && (
        // FISH_AUDIO_PHASE_1 wiring audit C2 — warn before Save when fish is
        // selected but no fish_voice_id_<env> is set for the current env.
        // Without this, the next /api/sessions/open 4014s with no admin-side
        // hint that this is their own misconfig. RPC-side guard (preferred
        // fix) is tracked as a follow-up — would block at the DB boundary
        // and catch script-driven paths too.
        <div style={{
          marginTop: 8, padding: 8, border: '1px solid #a44',
          borderRadius: 4, color: '#fcc', fontSize: 12, backgroundColor: '#400',
        }}>
          <strong>Warning:</strong> fish_voice_id is not set for this env.
          Saving fish without a reference_id will cause every session-open
          to 4014 tts_no_voice_fish until you paste the Fish reference_id
          into creators.fish_voice_id_&lt;env&gt; via service-role SQL.
        </div>
      )}
      <button
        onClick={onSave}
        disabled={pending}
        style={{ marginLeft: 8, padding: '6px 12px', fontSize: 13 }}
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      {status && (
        <span style={{ marginLeft: 12, fontSize: 12, color: status === 'saved' ? 'lightgreen' : 'salmon' }}>
          {status}
        </span>
      )}
    </div>
  );
}

function HumeVoiceSubPanel({
  creatorId,
  initialId,
  initialName,
}: {
  creatorId: string;
  initialId: string | null;
  initialName: string | null;
}) {
  const [id, setId] = useState<string>(initialId ?? '');
  const [name, setName] = useState<string>(initialName ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave() {
    setStatus(null);
    startTransition(async () => {
      const trimId = id.trim();
      const trimName = name.trim();
      const payload = {
        creatorId,
        env: ENV,
        id:   trimId.length === 0 ? null : trimId,
        name: trimName.length === 0 ? null : trimName,
      };
      const res = await setCreatorHumeVoice(payload);
      if (res.ok) {
        setStatus('saved');
      } else {
        // Audit C4 (unit-wide) — reset form state to the DB-committed value
        // on action error. Without this, the admin sees their typed-but-
        // rejected input still in the field and assumes it's persisted.
        setId(initialId ?? '');
        setName(initialName ?? '');
        setStatus(`error: ${res.error}`);
      }
    });
  }

  function onClear() {
    setStatus(null);
    startTransition(async () => {
      const res = await setCreatorHumeVoice({ creatorId, env: ENV, id: null, name: null });
      if (res.ok) {
        setId('');
        setName('');
        setStatus('cleared');
      } else {
        // Audit C4 — same reset behavior on clear failure.
        setId(initialId ?? '');
        setName(initialName ?? '');
        setStatus(`error: ${res.error}`);
      }
    });
  }

  return (
    <div style={{ border: '1px solid #222', padding: 12, borderRadius: 6 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
        Hume voice
        <EnvBadge />
      </h3>
      <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        Paste the voice id + name from app.hume.ai/voices. Both required (DB
        CHECK is paired). The DELETE worker keys by name, so the pair must be
        an exact match to what Hume's dashboard shows.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480 }}>
        <label style={{ fontSize: 12 }}>
          Voice id
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={pending}
            placeholder="hume voice UUID"
            style={{ width: '100%', padding: 6, fontSize: 13, fontFamily: 'monospace' }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Voice name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="exact name from app.hume.ai"
            style={{ width: '100%', padding: 6, fontSize: 13 }}
          />
        </label>
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button onClick={onSave} disabled={pending} style={{ padding: '6px 12px', fontSize: 13 }}>
          {pending ? 'Saving…' : 'Save voice'}
        </button>
        <button onClick={onClear} disabled={pending} style={{ padding: '6px 12px', fontSize: 13 }}>
          Clear
        </button>
        {status && (
          <span style={{ alignSelf: 'center', fontSize: 12, color: status === 'saved' || status === 'cleared' ? 'lightgreen' : 'salmon' }}>
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

function HumeProsodySubPanel({
  creatorId,
  initialSpeed,
  initialSilence,
  initialDescription,
  initialModel,
}: {
  creatorId: string;
  initialSpeed: number | null;
  initialSilence: number | null;
  initialDescription: string | null;
  initialModel: '1' | '2' | 'default';
}) {
  const [speed, setSpeed] = useState<string>(initialSpeed != null ? String(initialSpeed) : '');
  const [silence, setSilence] = useState<string>(initialSilence != null ? String(initialSilence) : '');
  const [description, setDescription] = useState<string>(initialDescription ?? '');
  const [model, setModel] = useState<'1' | '2' | 'default'>(initialModel);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function parseNum(s: string): number | null {
    if (s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function onSave() {
    setStatus(null);
    startTransition(async () => {
      const res = await setCreatorHumeProsody({
        creatorId,
        env: ENV,
        ttsSpeed:         parseNum(speed),
        trailingSilence:  parseNum(silence),
        voiceDescription: description.trim() === '' ? null : description.trim(),
        modelVersion:     model,
      });
      if (res.ok) {
        setStatus('saved');
      } else {
        // Audit C4 — reset form state to DB-committed values on error so
        // the admin doesn't see ghost-saved drafts.
        setSpeed(initialSpeed != null ? String(initialSpeed) : '');
        setSilence(initialSilence != null ? String(initialSilence) : '');
        setDescription(initialDescription ?? '');
        setModel(initialModel);
        setStatus(`error: ${res.error}`);
      }
    });
  }

  return (
    <div style={{ border: '1px solid #222', padding: 12, borderRadius: 6 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
        Hume prosody dials
        <EnvBadge />
      </h3>
      <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        Octave 2 per-utterance knobs. Speed range [0.5, 2.0] — Hume default 1.0.
        Trailing silence [0, 5] seconds — Hume default 0.3.
        Voice description is acting hints (inert today on Octave 2 per Hume
        docs &quot;coming soon&quot;). Model version 2 is the default.
      </p>
      <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 8, padding: 8, border: '1px solid #553', borderRadius: 4 }}>
        <strong>Heads up:</strong> if the voice id above was created by hitting
        &quot;save&quot; in Hume&apos;s playground with speed/silence already applied,
        those settings are BAKED into the voice clone&apos;s cadence — leave
        these dials empty (= Hume defaults). Setting speed=1.5 on top of a
        voice already cloned at 1.5 compounds to ~2.25× and breaks the sound
        you tuned. Only use these dials for voices cloned NEUTRAL (i.e. from
        raw audio with no prosody adjustments).
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480 }}>
        <label style={{ fontSize: 12 }}>
          Speed
          <input
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
            disabled={pending}
            placeholder="e.g. 1.5"
            inputMode="decimal"
            style={{ width: '100%', padding: 6, fontSize: 13 }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Trailing silence (sec)
          <input
            value={silence}
            onChange={(e) => setSilence(e.target.value)}
            disabled={pending}
            placeholder="e.g. 0.3"
            inputMode="decimal"
            style={{ width: '100%', padding: 6, fontSize: 13 }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Voice description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={pending}
            placeholder="acting instructions (≤1000 chars, inert today)"
            rows={2}
            style={{ width: '100%', padding: 6, fontSize: 13 }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Model version
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as '1' | '2' | 'default')}
            disabled={pending}
            style={{ width: '100%', padding: 6, fontSize: 13 }}
          >
            <option value="2">Octave 2 (default)</option>
            <option value="1">Octave 1</option>
            <option value="default">Hume default</option>
          </select>
        </label>
      </div>
      <div style={{ marginTop: 8 }}>
        <button onClick={onSave} disabled={pending} style={{ padding: '6px 12px', fontSize: 13 }}>
          {pending ? 'Saving…' : 'Save dials'}
        </button>
        {status && (
          <span style={{ marginLeft: 12, fontSize: 12, color: status === 'saved' ? 'lightgreen' : 'salmon' }}>
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
