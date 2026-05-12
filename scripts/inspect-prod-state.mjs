#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 100 });
const vuk = users.users.find((u) => u.email?.toLowerCase().includes('vukpjescic'));
console.log('vuk user id:', vuk?.id, vuk?.email);

const { data: creators } = await supabase.from('creators').select('id, user_id, display_name, handle, brain_mode, brain_status');
console.log('\nall creators in prod:');
for (const c of creators ?? []) console.log(`  ${c.id} | user=${c.user_id} | handle=${c.handle} | name=${c.display_name} | mode=${c.brain_mode} | status=${c.brain_status}`);

const { data: profiles } = await supabase.from('profiles').select('id, display_name, handle, tier').eq('id', vuk.id);
console.log('\nvuk profile:', profiles?.[0]);
