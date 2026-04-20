-- Atomic redemption pattern locks token to its email. Schema sanity: column
-- exists, token_hash unique, used_at + expires_at present.
BEGIN;
SELECT plan(3);

SELECT columns_are(
  'public'::name, 'creator_invitations'::name,
  ARRAY[
    'id','email','token_hash','invited_by','notes','expires_at',
    'used_at','used_by_user_id','created_at'
  ]
);

-- pgTAP's has_index() doesn't reliably match partial indexes. Query pg_indexes directly.
SELECT is(
  (SELECT count(*)::int FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'creator_invitations'
      AND indexname  = 'creator_invitations_email_idx'),
  1,
  'creator_invitations_email_idx (partial, WHERE used_at IS NULL) exists'
);

SELECT col_is_unique(
  'public'::name, 'creator_invitations'::name,
  ARRAY['token_hash']
);

SELECT * FROM finish();
ROLLBACK;
