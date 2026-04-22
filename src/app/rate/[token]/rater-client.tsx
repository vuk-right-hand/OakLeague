'use client';

import { useState } from 'react';

// Phase 1 scoring form. Phase 3 expands to a multi-clip flow; this Phase 1
// version is single-clip-pair-per-submit so the route surface is exercisable.
// Raters never see which provider is on which side — `left` and `right` are
// the only labels. Ground truth for provider mapping lives server-side.

type Cohort = 'vuk_naive' | 'vuk_knower';

type FormState = {
  clipPairId: string;
  lipsyncAlignment: number;
  mouthInSync: 'yes' | 'no' | '';
  feelsAlive: number;
  resemblance: number;
  uncannyValley: 'yes' | 'no' | '';
  wouldListen5Min: 'yes' | 'no' | '';
};

const INITIAL: FormState = {
  clipPairId: '',
  lipsyncAlignment: 5,
  mouthInSync: '',
  feelsAlive: 5,
  resemblance: 5,
  uncannyValley: '',
  wouldListen5Min: '',
};

function yesNoToBool(v: 'yes' | 'no' | ''): boolean | null {
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return null;
}

export default function RaterClient({ token, cohort }: { token: string; cohort: Cohort }) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);

    const mouth = yesNoToBool(form.mouthInSync);
    if (mouth === null) {
      setSubmitting(false);
      setResult('Please answer "Mouth in sync?"');
      return;
    }

    const body: Record<string, unknown> = {
      token,
      clip_pair_id: form.clipPairId,
      lipsync_alignment: form.lipsyncAlignment,
      mouth_in_sync: mouth,
      feels_alive: form.feelsAlive,
    };
    if (cohort === 'vuk_knower') {
      const uncanny = yesNoToBool(form.uncannyValley);
      const wouldListen = yesNoToBool(form.wouldListen5Min);
      if (uncanny === null || wouldListen === null) {
        setSubmitting(false);
        setResult('Please answer the Vuk-knower questions');
        return;
      }
      body.resemblance = form.resemblance;
      body.uncanny_valley = uncanny;
      body.would_listen_5_min = wouldListen;
    }

    try {
      const res = await fetch('/api/rate/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setResult('Thanks — submission recorded.');
        setForm(INITIAL);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setResult(`Error: ${j.error ?? `http_${res.status}`}`);
      }
    } catch (e) {
      setResult(`Network error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 13, opacity: 0.75 }}>
        Cohort: <code>{cohort}</code>. You are scoring LEFT vs RIGHT for one clip pair.
        The provider mapping is hidden by design.
      </p>

      <label>
        Clip pair id&nbsp;
        <input
          required
          value={form.clipPairId}
          onChange={(e) => setForm({ ...form, clipPairId: e.target.value })}
          placeholder="e.g. 03_seashells_pairA"
          style={{ width: 260 }}
        />
      </label>

      <label>
        Lipsync alignment (1 = very off, 10 = perfect): <strong>{form.lipsyncAlignment}</strong>
        <input
          type="range" min={1} max={10}
          value={form.lipsyncAlignment}
          onChange={(e) => setForm({ ...form, lipsyncAlignment: Number(e.target.value) })}
        />
      </label>

      <label>
        Mouth in sync with audio?&nbsp;
        <select
          value={form.mouthInSync}
          onChange={(e) => setForm({ ...form, mouthInSync: e.target.value as 'yes' | 'no' | '' })}
        >
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>

      <label>
        Feels alive (1 = mannequin, 10 = present): <strong>{form.feelsAlive}</strong>
        <input
          type="range" min={1} max={10}
          value={form.feelsAlive}
          onChange={(e) => setForm({ ...form, feelsAlive: Number(e.target.value) })}
        />
      </label>

      {cohort === 'vuk_knower' && (
        <>
          <label>
            Resemblance to Vuk (1–10): <strong>{form.resemblance}</strong>
            <input
              type="range" min={1} max={10}
              value={form.resemblance}
              onChange={(e) => setForm({ ...form, resemblance: Number(e.target.value) })}
            />
          </label>
          <label>
            Uncanny valley?&nbsp;
            <select
              value={form.uncannyValley}
              onChange={(e) => setForm({ ...form, uncannyValley: e.target.value as 'yes' | 'no' | '' })}
            >
              <option value="">—</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            Would listen 5 min?&nbsp;
            <select
              value={form.wouldListen5Min}
              onChange={(e) => setForm({ ...form, wouldListen5Min: e.target.value as 'yes' | 'no' | '' })}
            >
              <option value="">—</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit'}
      </button>
      {result && <p>{result}</p>}
    </form>
  );
}
