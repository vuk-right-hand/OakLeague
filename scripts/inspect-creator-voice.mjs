#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const { data } = await supabase.from('creators').select('handle, voice_id, tts_speed, simli_face_id').eq('handle', 'vuk_lehendas').single();
console.log(data);
