import { supabaseAdmin } from '@/lib/supabase/admin';
import { WelcomeConsoleClient } from './welcome-client';

export const dynamic = 'force-dynamic';

type WelcomeRow = {
  id: string;
  creator_id: string;
  video_id: string | null;
  mux_playback_id: string | null;
  mux_status: string;
  active: boolean;
  transcript: string | null;
  processing_error: string | null;
};

type CreatorRow = { id: string; display_name: string; handle: string };

export default async function WelcomeAdminPage() {
  const admin = supabaseAdmin();
  const [{ data: rowsRaw }, { data: creatorsRaw }] = await Promise.all([
    admin
      .from('welcome_hooks')
      .select('id, creator_id, video_id, mux_playback_id, mux_status, active, transcript, processing_error')
      .order('created_at', { ascending: false }),
    admin
      .from('creators')
      .select('id, display_name, handle')
      .order('display_name', { ascending: true }),
  ]);

  return (
    <WelcomeConsoleClient
      welcomeHooks={(rowsRaw ?? []) as WelcomeRow[]}
      creators={(creatorsRaw ?? []) as CreatorRow[]}
    />
  );
}
