// POST /api/me/avatar — user avatar upload (PROFILE_SYSTEM_PLAN U2).
//
//   multipart/form-data: image: File (JPEG|PNG, ≤2 MB)
//
// Re-encodes to a stripped 512px WEBP (avatar-transform), stores at the
// stable path avatars/{public_id}/avatar.webp (opaque public_id, never the
// auth uuid — audit M3), and writes profiles.avatar_url with a ?v= cache-bust
// so an updated avatar isn't masked by a CDN-cached old one.
//
// This writes the USER's avatar (profiles.avatar_url). A creator's public face
// uses creators.avatar_url, edited in the studio (audit M2) — not here.

import 'server-only';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isSameOrigin, json } from '@/lib/session/http-helpers';
import { processAvatar, AvatarError, AVATAR_MAX_BYTES } from '@/lib/avatar/avatar-transform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const userId = await getCallerUserId();
  if (!userId) return json(401, { error: 'unauthorized' });

  // Rate limit BEFORE the expensive sharp decode/re-encode (audit M1).
  const admin = supabaseAdmin();
  const { data: underLimit } = await admin.rpc('rate_limit_hit', {
    p_scope: 'avatar_upload',
    p_key: userId,
    p_window: '00:01:00',
    p_limit: 5,
  });
  if (underLimit === false) return json(429, { error: 'rate_limited' });

  const ctype = req.headers.get('content-type') ?? '';
  if (!ctype.includes('multipart/form-data')) return json(415, { error: 'bad_content_type' });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: 'bad_body' });
  }

  const file = form.get('image');
  if (!(file instanceof File)) return json(400, { error: 'no_image' });
  if (file.size > AVATAR_MAX_BYTES) return json(413, { error: 'too_large' });

  const input = Buffer.from(await file.arrayBuffer());
  let webp: Buffer;
  try {
    ({ webp } = await processAvatar(input));
  } catch (e) {
    if (e instanceof AvatarError) return json(422, { error: e.code });
    throw e;
  }

  const { data: prof } = await admin
    .from('profiles')
    .select('public_id')
    .eq('id', userId)
    .maybeSingle();
  if (!prof?.public_id) return json(409, { error: 'profile_missing' });

  // Stable path → one file per user, no orphans. Cache-bust via ?v= on the URL.
  const path = `${prof.public_id}/avatar.webp`;
  const up = await admin.storage
    .from('avatars')
    .upload(path, webp, { contentType: 'image/webp', upsert: true });
  if (up.error) return json(502, { error: 'upload_failed' });

  const { data: pub } = admin.storage.from('avatars').getPublicUrl(path);
  const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;

  const { error: updErr } = await admin
    .from('profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', userId);
  if (updErr) return json(500, { error: 'persist_failed' });

  return NextResponse.json({ ok: true, avatar_url: avatarUrl }, { headers: { 'cache-control': 'no-store' } });
}
