-- 0007 — waitlist
-- Public insert (anyone can sign up). Service-role only reads.

CREATE TABLE public.waitlist (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext       NOT NULL UNIQUE,
  source      text         CHECK (source IS NULL OR char_length(source) <= 100),
  created_at  timestamptz  NOT NULL DEFAULT now()
);

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Anyone may insert their own email. No read policy — service-role only.
CREATE POLICY "waitlist public insert"
  ON public.waitlist FOR INSERT
  WITH CHECK (true);
