-- ============================================================================
-- CLOSE THE CROSS-TAB/CROSS-DEVICE DOUBLE CLOCK-IN RACE
-- ============================================================================
-- domain/attendanceClockIn.js's performClockIn already re-checks
-- "does a row for (employee_id, date) already exist?" immediately before
-- inserting, and its own comment is explicit that this can't fully close
-- the race window without a DB-level constraint: two near-simultaneous
-- clock-in attempts (two open tabs, or a retried request after a network
-- blip that actually succeeded server-side) can both pass that pre-check
-- before either insert commits, producing two attendance rows for the
-- same employee on the same day. Verified against production data before
-- writing this migration -- zero existing duplicate (employee_id, date)
-- pairs, so this is safe to add without a backfill/cleanup step.
alter table public.attendance
  add constraint attendance_employee_date_unique unique (employee_id, date);
