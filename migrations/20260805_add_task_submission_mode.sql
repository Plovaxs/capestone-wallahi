-- ============================================================================
-- Migration: per-task submission mode -- 'singular' (any one assignee's
-- submission is enough) vs 'multiple' (every assignee must submit).
--
-- The previous migration (20260805_add_task_submissions.sql) always
-- required every assignee to submit before a task became "Completed".
-- That's right for a real group task, but wrong for e.g. "whoever gets to
-- it first" duplicate-effort assignments, where a supervisor deliberately
-- assigns several people and only needs ONE submission. This makes that a
-- deliberate per-task choice instead of a fixed rule.
--
-- Apply after 20260805_add_task_submissions.sql. Safe to re-run (idempotent).
-- ============================================================================

alter table if exists public.tasks
  add column if not exists submission_mode text not null default 'multiple';

alter table if exists public.tasks
  drop constraint if exists tasks_submission_mode_check;

alter table if exists public.tasks
  add constraint tasks_submission_mode_check
  check (submission_mode in ('singular', 'multiple'));

comment on column public.tasks.submission_mode is
  'multiple = every assignee must submit before the task is considered '
  'Completed/ready for review (real group work). singular = any ONE '
  'assignee submitting is enough (duplicate-effort/"whoever gets to it '
  'first" assignments).';


-- ============================================================================
-- Supersedes trg_check_task_all_submitted: 'singular' mode only needs 1
-- submission (from any assignee) instead of one from every assignee.
-- ============================================================================

create or replace function public.trg_check_task_all_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task record;
  v_assigned_count int;
  v_submitted_count int;
  v_required_count int;
begin
  -- 🟩 RACE FIX: FOR UPDATE serializes concurrent submissions to the same
  -- task. Without it, two people submitting in the same instant (two
  -- overlapping transactions) could each count submissions BEFORE seeing
  -- the other's still-uncommitted insert, both conclude "not everyone yet",
  -- and the task would never auto-complete even once every assignee
  -- genuinely has a row -- a real, if narrow, way for a group task to get
  -- silently stuck forever. Locking the parent task row makes the second
  -- trigger wait for the first to commit before it re-counts.
  select * into v_task from public.tasks where id = new.task_id for update;
  if v_task is null then
    return new;
  end if;

  v_assigned_count := coalesce(array_length(v_task.assigned_to, 1), 0);
  select count(*) into v_submitted_count from public.task_submissions where task_id = new.task_id;

  v_required_count := case
    when v_task.submission_mode = 'singular' then least(1, v_assigned_count)
    else v_assigned_count
  end;

  if v_required_count > 0
     and v_submitted_count >= v_required_count
     and v_task.status is distinct from 'Approved'
     and v_task.status is distinct from 'Completed' then
    update public.tasks set status = 'Completed' where id = new.task_id;
  end if;

  return new;
end;
$$;

-- ============================================================================
-- End of migration.
-- ============================================================================
