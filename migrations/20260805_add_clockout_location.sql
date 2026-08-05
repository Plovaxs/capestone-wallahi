-- ============================================================================
-- Migration: capture clock-out location separately from clock-in location.
--
-- Previously `public.attendance` only stored one lat/lng pair (captured at
-- clock-in) and the UI reused it as if it also represented where the
-- employee clocked out -- for a WFH employee, or anyone who moves between
-- the two events, that's simply the wrong location shown for clock-out.
--
-- Safe to re-run (idempotent).
-- ============================================================================

alter table if exists public.attendance
  add column if not exists clock_out_latitude double precision,
  add column if not exists clock_out_longitude double precision;

-- Existing RLS policies on public.attendance (see 20260712_add_rls_policies.sql)
-- already cover UPDATE, which is what setting these two new columns uses --
-- no policy changes needed here.
