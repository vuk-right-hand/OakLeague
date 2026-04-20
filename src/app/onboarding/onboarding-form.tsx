'use client';

import { useState, useTransition } from 'react';
import { saveOnboarding } from './actions';

function ChipInput({
  label,
  values,
  setValues,
  max,
}: {
  label: string;
  values: string[];
  setValues: (v: string[]) => void;
  max: number;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (!t || values.includes(t) || values.length >= max || t.length > 200) return;
    setValues([...values, t]);
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label>
        {label} ({values.length}/{max})
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {values.map((v, i) => (
          <span
            key={i}
            onClick={() => setValues(values.filter((_, j) => j !== i))}
            style={{
              background: '#222',
              padding: '4px 10px',
              borderRadius: 999,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {v} ×
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          disabled={values.length >= max}
          maxLength={200}
        />
        <button type="button" onClick={add} disabled={values.length >= max || !draft.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

export function OnboardingForm({ next }: { next: string }) {
  const [goals, setGoals] = useState<string[]>([]);
  const [obstacles, setObstacles] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 24 }}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        if (goals.length < 1) {
          setErr('Add at least one goal.');
          return;
        }
        const timezone =
          typeof Intl !== 'undefined'
            ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
            : 'UTC';
        startTransition(async () => {
          const res = await saveOnboarding({ goals, obstacles, timezone, next });
          if (!res.ok) setErr(res.error);
          else window.location.href = res.next;
        });
      }}
    >
      <ChipInput label="Goals" values={goals} setValues={setGoals} max={5} />
      <ChipInput label="Obstacles (optional)" values={obstacles} setValues={setObstacles} max={5} />
      {err && <div role="alert" style={{ color: 'salmon' }}>{err}</div>}
      <button type="submit" disabled={pending}>
        Continue
      </button>
    </form>
  );
}
