import { getCreatorForCaller } from '@/lib/creator/get-creator';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { resolveVoiceId } from '@/lib/voice/env-scoped-voice-id';
import { VoiceSpeedUI } from './voice-ui';

export const dynamic = 'force-dynamic';

export default async function CreatorVoicePage() {
  const { creatorId } = await getCreatorForCaller();

  // Separate SELECT — getCreatorForCaller() doesn't return voice_id columns
  // or tts_speed (R2 audit M1). Pull the env-scoped voice_id + the current
  // speed for the slider's initial value.
  const sb = supabaseAdmin();
  const { data: row } = await sb
    .from('creators')
    .select('voice_id, voice_id_preview, voice_id_dev, tts_speed')
    .eq('id', creatorId)
    .maybeSingle<{
      voice_id: string | null;
      voice_id_preview: string | null;
      voice_id_dev: string | null;
      tts_speed: number | string | null;
    }>();

  const voiceTrained =
    row != null &&
    resolveVoiceId({
      voice_id: row.voice_id,
      voice_id_preview: row.voice_id_preview,
      voice_id_dev: row.voice_id_dev,
    }) != null;

  // supabase-js returns numeric as string; coerce to number for the slider.
  const initialSpeed: number = (() => {
    const raw = row?.tts_speed;
    if (raw == null) return 1.0;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n >= 0.6 && n <= 1.5 ? n : 1.0;
  })();

  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '20px 0' }}>
      <header>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Voice playback</h1>
        <p style={{ color: '#888', margin: '6px 0 0 0', fontSize: 14 }}>
          Dial how fast your cloned voice plays back to people who tap to ask you a question.
          Drag the slider, tap Check Speech to hear it, and save when it sounds right.
        </p>
      </header>

      <VoiceSpeedUI initialSpeed={initialSpeed} voiceTrained={voiceTrained} />
    </main>
  );
}
