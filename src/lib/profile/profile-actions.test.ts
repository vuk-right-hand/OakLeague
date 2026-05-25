import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetCaller, mockFrom, mockRpc, mockUpdate, mockMaybeSingle, mockRevalidate } = vi.hoisted(() => ({
  mockGetCaller: vi.fn(),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockUpdate: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockRevalidate: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({ getCallerUserId: mockGetCaller }));
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidate }));
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

import { saveProfile } from './profile-actions';

const USER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

// `from('creators')` → maybeSingle; `from('profiles')` → update().eq()
function wireSupabase({ isCreator }: { isCreator: boolean }) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'creators') {
      return { select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) };
    }
    // profiles
    return { update: mockUpdate };
  });
  mockMaybeSingle.mockResolvedValue({ data: isCreator ? { id: 'c1' } : null, error: null });
  mockUpdate.mockReturnValue({ eq: () => Promise.resolve({ error: null }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCaller.mockResolvedValue(USER);
  mockRpc.mockResolvedValue({ data: true, error: null }); // handle available
});

describe('saveProfile', () => {
  it('401 when unauthenticated', async () => {
    mockGetCaller.mockResolvedValueOnce(null);
    expect(await saveProfile({ display_name: 'X' })).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('rejects a creator editing identity here (M2 → edit_in_studio)', async () => {
    wireSupabase({ isCreator: true });
    const res = await saveProfile({ display_name: 'New Name' });
    expect(res).toEqual({ ok: false, error: 'edit_in_studio' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates a non-creator profile (whitelisted fields)', async () => {
    wireSupabase({ isCreator: false });
    const res = await saveProfile({ display_name: 'Vuk', bio: 'builder', handle: 'vuk_p' });
    expect(res).toEqual({ ok: true });
    expect(mockUpdate).toHaveBeenCalledWith({ display_name: 'Vuk', bio: 'builder', handle: 'vuk_p' });
  });

  it('rejects a bad handle format before any write', async () => {
    wireSupabase({ isCreator: false });
    const res = await saveProfile({ handle: 'no' }); // too short
    expect(res).toEqual({ ok: false, error: 'bad_handle' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a taken handle from the availability pre-check', async () => {
    wireSupabase({ isCreator: false });
    mockRpc.mockResolvedValueOnce({ data: false, error: null });
    const res = await saveProfile({ handle: 'taken_one' });
    expect(res).toEqual({ ok: false, error: 'handle_taken' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('maps a unique-violation from the trigger to handle_taken', async () => {
    wireSupabase({ isCreator: false });
    mockUpdate.mockReturnValueOnce({ eq: () => Promise.resolve({ error: { code: '23505' } }) });
    const res = await saveProfile({ handle: 'racey' });
    expect(res).toEqual({ ok: false, error: 'handle_taken' });
  });

  it('rejects an empty patch', async () => {
    wireSupabase({ isCreator: false });
    expect(await saveProfile({})).toEqual({ ok: false, error: 'nothing_to_update' });
  });
});
