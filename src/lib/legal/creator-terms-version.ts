// Creator Terms version — leaf module, no React or Next imports.
// Pinned in app code so the consent text on /apply, the audit trail
// in creator_applications.duet_consent_terms_version, and the
// rendered /legal/creator-terms page never drift. When terms change:
// bump the version, archive the prior version copy, and add a
// creator_terms_versions row (post-YC).
//
// Do NOT import from a Next.js page module (`page.tsx`) — page
// modules export `metadata` and a default React component which drag
// page-level concerns into client bundles when consumed across
// `'use client'` boundaries (audit R3-final C1).
export const CREATOR_TERMS_VERSION = 'v2026-05-04';
