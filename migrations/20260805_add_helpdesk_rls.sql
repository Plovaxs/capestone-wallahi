-- ============================================================================
-- Migration: Row Level Security for helpdesk_tickets / helpdesk_replies.
--
-- These two tables had no RLS policy of their own anywhere in this repo's
-- migrations. Depending on how they were originally created, that means one
-- of two very different (and both wrong) states in production:
--   - RLS never enabled on them -> no restriction at all (fine for read,
--     but ANY authenticated user could also update/delete ANY ticket).
--   - RLS enabled (e.g. via the Supabase dashboard) with no SELECT policy
--     -> default-deny, so nobody except a service-role caller can read
--     anything -- this is the "employees can't see help requests" bug.
-- This migration makes the actual intended behavior explicit either way.
--
-- Reuses public.is_supervisor()/public.is_self() from
-- 20260712_add_rls_policies.sql -- apply that migration first.
--
-- Safe to re-run (idempotent).
-- ============================================================================

alter table if exists public.helpdesk_tickets enable row level security;
alter table if exists public.helpdesk_replies enable row level security;


-- ============================================================================
-- HELPDESK_TICKETS
-- ============================================================================

-- Every employee and supervisor can see every ticket -- this is a shared
-- team helpdesk queue, not a private inbox; an "Urgent Blocker" filed by
-- one intern is exactly the kind of thing a teammate (not just a
-- supervisor) should be able to see and help with.
drop policy if exists helpdesk_tickets_select_all on public.helpdesk_tickets;
create policy helpdesk_tickets_select_all
  on public.helpdesk_tickets
  for select
  to authenticated
  using (true);

drop policy if exists helpdesk_tickets_insert_own on public.helpdesk_tickets;
create policy helpdesk_tickets_insert_own
  on public.helpdesk_tickets
  for insert
  to authenticated
  with check (employee_id = auth.uid());

-- A ticket can be updated by a supervisor (any ticket) or by the employee
-- who filed it (their own ticket only) -- matches the app's UI, which now
-- lets a submitter mark their own ticket In Progress/Resolved instead of
-- that being supervisor-only.
drop policy if exists helpdesk_tickets_update_own_or_supervisor on public.helpdesk_tickets;
create policy helpdesk_tickets_update_own_or_supervisor
  on public.helpdesk_tickets
  for update
  to authenticated
  using (public.is_supervisor() or employee_id = auth.uid())
  with check (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists helpdesk_tickets_delete_supervisor_only on public.helpdesk_tickets;
create policy helpdesk_tickets_delete_supervisor_only
  on public.helpdesk_tickets
  for delete
  to authenticated
  using (public.is_supervisor());


-- ============================================================================
-- HELPDESK_REPLIES
-- ============================================================================

drop policy if exists helpdesk_replies_select_all on public.helpdesk_replies;
create policy helpdesk_replies_select_all
  on public.helpdesk_replies
  for select
  to authenticated
  using (true);

drop policy if exists helpdesk_replies_insert_own on public.helpdesk_replies;
create policy helpdesk_replies_insert_own
  on public.helpdesk_replies
  for insert
  to authenticated
  with check (author_id = auth.uid());

drop policy if exists helpdesk_replies_delete_own_or_supervisor on public.helpdesk_replies;
create policy helpdesk_replies_delete_own_or_supervisor
  on public.helpdesk_replies
  for delete
  to authenticated
  using (public.is_supervisor() or author_id = auth.uid());

-- ============================================================================
-- End of migration.
-- ============================================================================
