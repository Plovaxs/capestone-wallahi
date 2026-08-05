-- ============================================================================
-- COMBINED MIGRATION HANDOFF
-- Bundles 4 separate migration files from this folder into one file, in the
-- order they must run:
--   1. 20260805_add_task_submissions.sql
--   2. 20260805_add_task_submission_mode.sql   (depends on #1)
--   3. 20260805_add_storage_object_rls.sql
--   4. 20260805_add_helpdesk_rls.sql
--
-- PREREQUISITE: 20260712_add_rls_policies.sql must already be applied --
-- everything below reuses its public.is_supervisor() / public.notify()
-- helper functions. If that one hasn't been run yet on this database, run
-- it FIRST, separately, before this file.
--
-- Safe to re-run in full (every statement is idempotent -- drop-if-exists
-- before create, add-column-if-not-exists, etc.).
-- Run this whole file in one go in the Supabase SQL editor.
--
-- This file is a convenience bundle for handing to someone managing the
-- database directly -- the 4 source files above remain the source of truth
-- and stay in this folder individually too.
-- ============================================================================


-- ############################################################################
-- 1) TASK SUBMISSIONS + TARGETED REVISIONS
-- ############################################################################

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

alter table if exists public.tasks
  add column if not exists revision_target_employee_id uuid references public.profiles(id);


-- 1a. TASK_SUBMISSIONS table -------------------------------------------------

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


-- 1b. AUTO-COMPLETE trigger. The function body defined here is a stub --
--     its real, final definition (submission-mode-aware + race-condition
--     safe) is created via CREATE OR REPLACE in section 2 below. Defining
--     the trigger itself here (once) is enough; PostgreSQL always calls
--     whatever the function's latest CREATE OR REPLACE left it as.

create or replace function public.trg_check_task_all_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  return new; -- placeholder; replaced for real in section 2 below
end;
$$;

drop trigger if exists check_task_all_submitted on public.task_submissions;
create trigger check_task_all_submitted
  after insert or update on public.task_submissions
  for each row execute function public.trg_check_task_all_submitted();


-- 1c. TARGETED REVISION: clears the relevant submission(s) -------------------

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


-- 1d. TARGETED REVISION NOTIFICATION: supersedes the 'Revision Needed'
--     branch of trg_notify_task_status_change (from 20260712 migration) --
--     if a specific assignee was targeted, only they get notified;
--     otherwise (general revision) every assignee does, same as before.

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


-- ############################################################################
-- 2) TASK SUBMISSION MODE ('singular' vs 'multiple') + race-condition fix
-- ############################################################################

-- 'singular' = any one assignee's submission is enough. 'multiple' = every
-- assignee must submit. Right for "whoever gets to it first" duplicate-
-- effort assignments vs. real group work, as a deliberate per-task choice.

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

-- This is the version of trg_check_task_all_submitted that actually takes
-- effect (supersedes section 1b above): adds submission_mode awareness AND
-- a `for update` row lock fixing a real race condition -- two people
-- submitting in the same instant (overlapping transactions) could each
-- count submissions before seeing the other's still-uncommitted insert,
-- and the task would never auto-complete even once everyone had submitted.

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


-- ############################################################################
-- 3) STORAGE OBJECT RLS (task_submission + avatars buckets)
-- ############################################################################

-- Neither bucket had ANY RLS policy anywhere -- only file-size/MIME-type
-- limits (from 20260712_add_rls_policies.sql). The `{user_id}/...` path
-- convention both upload flows use was purely client-side; without a
-- server-side policy any authenticated user could call the Storage API
-- directly and read/overwrite another user's files by path.

alter table storage.objects enable row level security;

-- TASK_SUBMISSION bucket: private. Files live at
-- `{employee_id}/{task_id}/{timestamp}.{ext}`.

drop policy if exists task_submission_insert_own_folder on storage.objects;
create policy task_submission_insert_own_folder
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'task_submission'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Readable by: a supervisor (any submission), the uploader themself, or
-- anyone else assigned to the same task.
drop policy if exists task_submission_select on storage.objects;
create policy task_submission_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'task_submission'
    and (
      public.is_supervisor()
      or (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.tasks t
        where t.id::text = (storage.foldername(name))[2]
          and auth.uid()::text = any(coalesce(t.assigned_to, '{}'::text[]))
      )
    )
  );

drop policy if exists task_submission_delete on storage.objects;
create policy task_submission_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'task_submission'
    and (public.is_supervisor() or (storage.foldername(name))[1] = auth.uid()::text)
  );

-- AVATARS bucket: public reads (profile photos, shown broadly via
-- getPublicUrl already), writes scoped to the user's own folder.

drop policy if exists avatars_select_all on storage.objects;
create policy avatars_select_all
  on storage.objects
  for select
  using (bucket_id = 'avatars');

drop policy if exists avatars_insert_own_folder on storage.objects;
create policy avatars_insert_own_folder
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- The app uploads with { upsert: true }, which needs UPDATE rights on an
-- existing object at the same path, not just INSERT.
drop policy if exists avatars_update_own_folder on storage.objects;
create policy avatars_update_own_folder
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_delete_own_folder on storage.objects;
create policy avatars_delete_own_folder
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);


-- ############################################################################
-- 4) HELPDESK RLS (helpdesk_tickets + helpdesk_replies)
-- ############################################################################

-- These two tables had no RLS policy of their own anywhere -- this makes
-- the shared-team-queue behavior explicit (everyone can see every ticket,
-- not just a private inbox), and lets a ticket's own submitter (not just a
-- supervisor) mark their own ticket In Progress/Resolved.

alter table if exists public.helpdesk_tickets enable row level security;
alter table if exists public.helpdesk_replies enable row level security;

-- HELPDESK_TICKETS

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
-- who filed it (their own ticket only).
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

-- HELPDESK_REPLIES

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
-- End of combined migration.
-- ============================================================================
