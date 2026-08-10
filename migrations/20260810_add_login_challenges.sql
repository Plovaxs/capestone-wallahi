-- ============================================================================
-- LOGIN CHALLENGES (server-side anti-replay for face-login)
-- ============================================================================
-- Every liveness check the client performs (see vision/livenessDetector.js,
-- livenessFusion.js, handRegionHeuristic.js, deviceEdgeHeuristic.js) runs in
-- the browser -- necessarily, since there's no other place a webcam feed is
-- available. That means the biometric-login Edge Function previously had NO
-- way to know whether any of those checks actually ran: a captured/replayed
-- network request, or a script calling the function directly with a leaked
-- 128-d descriptor, could mint a session with zero camera interaction at all.
--
-- This table backs a standard single-use, short-lived nonce: the client
-- fetches one before starting its liveness challenge, and the Edge Function
-- requires it back with the actual login attempt, atomically consuming it
-- (single-use) and enforcing a minimum elapsed time since issuance (closes
-- instant-replay/zero-interaction abuse). This is a real, standard
-- anti-replay control -- NOT a cryptographic proof that a human blinked; it
-- cannot single-handedly guarantee "unbypassable by anyone, by any means"
-- (no browser-based biometric system can, without dedicated secure hardware
-- attestation), but it closes the specific gap of the server blindly
-- trusting whatever descriptor arrives.

create table if not exists public.login_challenges (
  nonce uuid primary key default gen_random_uuid(),
  ip text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '35 seconds'),
  consumed_at timestamptz
);

create index if not exists login_challenges_expires_idx on public.login_challenges (expires_at);

alter table public.login_challenges enable row level security;

-- Deliberately NO policies for anon/authenticated -- this table is only
-- ever touched by the biometric-login Edge Function's service-role client
-- (which bypasses RLS entirely), same lockdown as biometric_login_attempts.
-- A client able to read/write this directly could forge a "consumed"
-- status or read/guess a valid nonce, which would defeat the whole point.
revoke all on public.login_challenges from anon, authenticated;
