-- ============================================================================
-- Migration: track how a clock-in's timestamp was determined.
--
-- Punctuality ("Late" vs "Present") is normally decided from the Supabase
-- server's own clock (via its HTTP Date response header), specifically
-- because the device's clock is trivially spoofable. Offline clock-ins
-- (queued via OfflineMutationQueue and synced once connectivity returns)
-- can't reach the server at the moment of clock-in, so their timestamp is
-- instead derived from the last known server time projected forward using
-- a monotonic clock (performance.now(), which -- unlike the device's wall
-- clock -- cannot be rewound by changing the system time). This column
-- records which of the three ways a given clock-in's time was determined,
-- purely for transparency/audit -- it never changes what gets enforced.
--
-- Safe to re-run (idempotent).
-- ============================================================================

alter table if exists public.attendance
  add column if not exists clock_in_time_source text;

alter table if exists public.attendance
  drop constraint if exists attendance_clock_in_time_source_check;

alter table if exists public.attendance
  add constraint attendance_clock_in_time_source_check
  check (clock_in_time_source is null or clock_in_time_source in ('server', 'estimated', 'device_untrusted'));

comment on column public.attendance.clock_in_time_source is
  'server = confirmed against the Supabase server clock at clock-in time. '
  'estimated = offline clock-in, timestamp projected from the last known '
  'server time via a monotonic clock (not spoofable by changing the device '
  'clock). device_untrusted = offline clock-in with no server-time '
  'checkpoint available yet this session, so it fell back to the device '
  'clock (which IS spoofable) -- worth a closer look if flagged. '
  'null = pre-existing row from before this column existed, or clocked in '
  'online (the common case).';
