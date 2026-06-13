import 'server-only';

// Shared Cartesia clone-endpoint constants (audit S2). Both the admin
// (/api/admin/voice-clone) and creator (/creator/api/voice-clone) routes
// import these so a Cartesia API-version bump can't land on one path only.
export const CARTESIA_VERSION = '2026-03-01';
export const CARTESIA_CLONE_URL = 'https://api.cartesia.ai/voices/clone';
