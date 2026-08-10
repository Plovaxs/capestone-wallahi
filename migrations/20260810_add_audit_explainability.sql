-- ============================================================================
-- EXPLAINABLE AUDIT TRAIL (adds WHY, not just WHO/WHAT/WHEN)
-- ============================================================================
-- The existing audit_log (20260810_document_audit_log.sql) already captures
-- who changed what and the before/after values -- solid accountability, but
-- not "explainable" in the stronger sense: a supervisor reviewing "leave
-- request approved" or "task approved" has to go cross-reference the
-- employee's quota or the task's deadline themselves to know whether that
-- decision looks reasonable. This extends the two decision-bearing triggers
-- (leave status changes, task status changes) to capture that context AT
-- THE MOMENT of the decision, so a later dispute ("why was this approved
-- when quota was already exhausted?") has a durable, contemporaneous answer
-- instead of relying on someone's memory or a since-changed profile value.

create or replace function public.trg_audit_leave_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_days integer;
  v_quota_balance integer;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    v_requested_days := (new.end_date::date - new.start_date::date) + 1;

    -- Quota balance only means something for the two types that actually
    -- draw from a profile allowance -- Unpaid Leave has its own separate
    -- annual-cap rule (LeaveQuotaPolicy.js), not a profiles column.
    if new.type = 'Sick Leave' then
      select sick_days into v_quota_balance from public.profiles where id = new.employee_id;
    elsif new.type = 'Paid Holiday' then
      select vacation_days into v_quota_balance from public.profiles where id = new.employee_id;
    else
      v_quota_balance := null;
    end if;

    perform public.log_audit_event(
      'status_change', 'leave_request', new.id::text,
      jsonb_build_object(
        'type', new.type, 'from', old.status, 'to', new.status,
        'requested_days', v_requested_days,
        'quota_balance_at_decision', v_quota_balance
      )
    );
  end if;
  return new;
end;
$$;

create or replace function public.trg_audit_task_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days_relative_to_deadline integer;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.due_date is not null and new.status in ('Approved', 'Completed', 'Rejected') then
      -- Positive = decided N days AFTER the deadline, negative = N days
      -- before/ahead of it -- deliberately raw signed days, not a
      -- pre-judged "late"/"early" label, so the audit view can phrase it
      -- either way without re-deriving the sign itself.
      v_days_relative_to_deadline := (now()::date - new.due_date::date);
    else
      v_days_relative_to_deadline := null;
    end if;

    perform public.log_audit_event(
      'status_change', 'task', new.id::text,
      jsonb_build_object(
        'title', new.title, 'from', old.status, 'to', new.status,
        'days_relative_to_deadline', v_days_relative_to_deadline
      )
    );
  end if;
  return new;
end;
$$;
