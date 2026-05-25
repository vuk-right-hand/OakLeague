// Canonical handle format (3–30 chars, lowercase alnum + underscore).
// Mirrors the DB CHECK on profiles.handle / creators.handle. Single source so
// the regex can't drift across the page, the actions, and the edit sheet.
export const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
