-- ============================================================================
-- Migration: per-assignee task submissions + targeted revision requests.
--
-- Previously a task had a single `submitted_file_path` column shared by
-- every assignee -- whoever uploaded FIRST flipped the whole task to
-- "Completed" regardless of how many other people were also assigned and
-- hadn't submitted anything yet. This adds a proper per-person submission
-- table: a task only becomes "Completed" (ready for supervisor review)
-- once every assignee has one.
--
-- Also adds targeted revisions: a supervisor requesting a revision can
-- either target one specific assignee (only their submission is cleared,
-- only they're notified) or leave it general (everyone's submission is
-- cleared, everyone assigned is notified) -- matches a real group-task
-- workflow where sometimes only one person's part needs fixing.
--
-- The old `tasks.submitted_file_path` / `tasks.feedback` columns are left
-- in place (not dropped) for backward compatibility with already-completed
-- historical rows that used the old single-submission flow.
--
-- Apply after 20260712_add_rls_policies.sql (reuses its is_supervisor()/
-- notify() helpers). Safe to re-run (idempotent).
-- ============================================================================

alter table if exists public.tasks
  add column if not exists revision_target_employee_id uuid references public.profiles(id);


-- ============================================================================
-- 1. TASK_SUBMISSIONS
-- ============================================================================

create table if not exists public.task_submissions (
  id uuid primary key default gen_random_uuid(),
  task_id bigint not null references public.tasks(id) on delete cascade,
  employee_id uuid not null references public.profiles(id),
  file_path text not null,
  submitted_at timestamptz not null default now(),
  unique (task_id, employee_id)
);

alter table public.task_submissions enable row level security;

drop policy if exists task_submissions_select on public.task_submissions;
create policy task_submissions_select
  on public.task_submissions
  for select
  to authenticated
  using (
    public.is_supervisor()
    or employee_id = auth.uid()
    or exists (
      select 1 from public.tasks t
      where t.id = task_submissions.task_id
        and auth.uid()::text = any(coalesce(t.assigned_to, '{}'::text[]))
    )
  );

-- Only an actual assignee of the task can submit for themself -- not on
-- someone else's behalf, and not for a task they were never assigned to.
drop policy if exists task_submissions_insert_own on public.task_submissions;
create policy task_submissions_insert_own
  on public.task_submissions
  for insert
  to authenticated
  with check (
    employee_id = auth.uid()
    and exists (
      select 1 from public.tasks t
      where t.id = task_submissions.task_id
        and auth.uid()::text = any(coalesce(t.assigned_to, '{}'::text[]))
    )
  );

-- Re-uploading (replacing an earlier file) updates the same row.
drop policy if exists task_submissions_update_own on public.task_submissions;
create policy task_submissions_update_own
  on public.task_submissions
  for update
  to authenticated
  using (employee_id = auth.uid())
  with check (employee_id = auth.uid());

drop policy if exists task_submissions_delete_own_or_supervisor on public.task_submissions;
create policy task_submissions_delete_own_or_supervisor
  on public.task_submissions
  for delete
  to authenticated
  using (public.is_supervisor() or employee_id = auth.uid());


-- ============================================================================
-- 2. AUTO-COMPLETE: once every assignee has a submission row, the task
--    flips to 'Completed' (ready for review) -- reuses the existing
--    trg_notify_task_status_change trigger (20260712 migration) for the
--    "ready for review" notification, since that already fires whenever
--    a task's status lands on 'Completed'.
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
begin
  select * into v_task from public.tasks where id = new.task_id;
  if v_task is null then
    return new;
  end if;

  v_assigned_count := coalesce(array_length(v_task.assigned_to, 1), 0);
  select count(*) into v_submitted_count from public.task_submissions where task_id = new.task_id;

  if v_assigned_count > 0
     and v_submitted_count >= v_assigned_count
     and v_task.status is distinct from 'Approved'
     and v_task.status is distinct from 'Completed' then
    update public.tasks set status = 'Completed' where id = new.task_id;
  end if;

  return new;
end;
$$;

drop trigger if exists check_task_all_submitted on public.task_submissions;
create trigger check_task_all_submitted
  after insert or update on public.task_submissions
  for each row execute function public.trg_check_task_all_submitted();


-- ============================================================================
-- 3. TARGETED REVISION: clears the relevant submission(s) so the task can't
--    stay "Completed" while actually needing rework, and stops the auto-
--    complete trigger above from immediately flipping it back.
-- ============================================================================

create or replace function public.trg_clear_submissions_on_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'Revision Needed' and old.status is distinct from 'Revision Needed' then
    if new.revision_target_employee_id is not null then
      delete from public.task_submissions
      where task_id = new.id and employee_id = new.revision_target_employee_id;
    else
      delete from public.task_submissions where task_id = new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_submissions_on_revision on public.tasks;
create trigger clear_submissions_on_revision
  after update on public.tasks
  for each row execute function public.trg_clear_submissions_on_revision();


-- ============================================================================
-- 4. TARGETED REVISION NOTIFICATION: supersedes the 'Revision Needed'
--    branch of trg_notify_task_status_change (20260712 migration) -- if a
--    specific assignee was targeted, only they get notified; otherwise
--    (general revision) every assignee does, same as before.
-- ============================================================================

create or replace function public.trg_notify_task_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid text;
  supervisor record;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'Completed' then
      for supervisor in select id from public.profiles where role = 'supervisor'
      loop
        perform public.notify(supervisor.id, format('Task Ready for Review: "%s" has been submitted.', new.title));
      end loop;
    end if;
    if new.status = 'Approved' then
      foreach uid in array coalesce(new.assigned_to, '{}'::text[])
      loop
        perform public.notify(uid::uuid, format('Task Approved: Your submission for "%s" has been successfully approved!', new.title));
      end loop;
    end if;
    if new.status = 'Revision Needed' then
      if new.revision_target_employee_id is not null then
        perform public.notify(new.revision_target_employee_id, format('Revision requested on "%s".', new.title));
      else
        foreach uid in array coalesce(new.assigned_to, '{}'::text[])
        loop
          perform public.notify(uid::uuid, format('Revision requested on "%s".', new.title));
        end loop;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ============================================================================
-- End of migration.
-- ============================================================================
