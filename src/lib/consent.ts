// Consent versions + apply-flow requirements (FIVE_CREATOR_ONBOARDING_READINESS
// P0-3). Plain module (no 'server-only') — used by both the apply form (client)
// and the apply action (server). Version-pinned: the version is STAMPED onto
// each consent row at acceptance time. NOTE (audit C1): the clone/face gate
// currently checks consent EXISTENCE (active, non-revoked), NOT version — so
// bumping a value here records the new version on FUTURE acceptances but does
// NOT retroactively force existing creators to re-accept. "Re-consent on a
// version bump" is a P1 follow-up; until then, treat a bump as non-blocking.

export const CONSENT_VERSIONS = {
  tos: '2026-05-21',
  privacy: '2026-05-21',
  voice_clone: '2026-05-21',
  likeness: '2026-05-21',
  content_license: '2026-05-21',
} as const;

export type ConsentType = keyof typeof CONSENT_VERSIONS;

// The two apply-form checkboxes map to these consent rows. The voice/likeness
// box authorizes BOTH the cloned voice and the avatar (the two surfaces the
// admin clone/face routes gate on); the ToS box also records privacy.
export const APPLY_CONSENT_GROUPS = {
  tos: ['tos', 'privacy'] as ConsentType[],
  voice_likeness: ['voice_clone', 'likeness'] as ConsentType[],
};

// Shape passed to submit_creator_application (p_consents jsonb array).
export type ConsentEntry = { type: ConsentType; version: string };

export function buildApplyConsents(): ConsentEntry[] {
  const types: ConsentType[] = [
    ...APPLY_CONSENT_GROUPS.tos,
    ...APPLY_CONSENT_GROUPS.voice_likeness,
  ];
  return types.map((type) => ({ type, version: CONSENT_VERSIONS[type] }));
}
