-- ============================================================================
-- PERSONAL ACTIVITY LOG (Settings > Security > Recent Activity)
-- ============================================================================
-- audit_log previously had exactly one select policy, supervisor-only
-- (20260810_document_audit_log.sql). That's correct for the supervisor-
-- facing AuditLogView, but means a regular employee could never see their
-- own actions (e.g. their own profile edits) even though those rows are
-- already scoped to them via actor_id. This adds the missing self-visibility
-- policy -- same "own row, or supervisor" shape as known_devices' policy.

drop policy if exists audit_log_select_own_or_supervisor on public.audit_log;
create policy audit_log_select_own_or_supervisor
  on public.audit_log
  for select
  using (public.is_supervisor() or actor_id = auth.uid());

-- The old supervisor-only policy is superseded by the one above (which
-- already includes is_supervisor()) -- postgres OR's multiple permissive
-- policies together, so leaving both would be harmless but redundant.
drop policy if exists audit_log_select_supervisor_only on public.audit_log;
