-- ============================================================================
-- Migration: Row Level Security, column-protection triggers, rate limiting,
-- and the notification system for the Internship Monitoring System.
--
-- This supersedes the original baseline RLS migration. Corrections folded in
-- from implementation (verified against the live schema):
--   - tasks.assigned_to is text[], not uuid[] — casts corrected throughout
--   - contributions is a team-wide forum; SELECT is now open to all
--     authenticated users rather than owner-only
--   - notifications has no client INSERT policy — rows are created only by
--     the triggers in this file, via public.notify()
--
-- Apply after the core tables exist. Safe to re-run (idempotent).
-- ============================================================================


-- ============================================================================
-- 1. HELPER FUNCTIONS — shared authorization primitives
-- ============================================================================

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'anonymous');
$$;

create or replace function public.is_supervisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() = 'supervisor';
$$;

create or replace function public.is_self(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() = target_id;
$$;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_supervisor() to authenticated;
grant execute on function public.is_self(uuid) to authenticated;


-- ============================================================================
-- 2. RATE LIMITING
-- ============================================================================

create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);

revoke all on public.rate_limits from anon, authenticated;

-- Authenticated, client-callable version — keyed on the caller's verified
-- auth.uid(), never a client-supplied identifier.
create or replace function public.check_rate_limit(
  p_action text,
  p_max_requests integer,
  p_window_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
  v_retry_after_ms bigint;
begin
  if v_uid is null then
    raise exception 'Authentication required for rate-limited action';
  end if;

  v_key := v_uid::text || ':' || p_action;

  select window_start, count into v_window_start, v_count
  from public.rate_limits where key = v_key for update;

  if not found then
    insert into public.rate_limits (key, window_start, count) values (v_key, v_now, 1);
    return jsonb_build_object('allowed', true, 'remaining', p_max_requests - 1);
  end if;

  if v_now - v_window_start > make_interval(secs => p_window_seconds) then
    update public.rate_limits set window_start = v_now, count = 1 where key = v_key;
    return jsonb_build_object('allowed', true, 'remaining', p_max_requests - 1);
  end if;

  if v_count >= p_max_requests then
    v_retry_after_ms := ceil(extract(epoch from
      (v_window_start + make_interval(secs => p_window_seconds) - v_now)) * 1000);
    return jsonb_build_object('allowed', false, 'retry_after_ms', greatest(v_retry_after_ms, 0));
  end if;

  update public.rate_limits set count = count + 1 where key = v_key;
  return jsonb_build_object('allowed', true, 'remaining', p_max_requests - v_count - 1);
end;
$$;

grant execute on function public.check_rate_limit(text, integer, integer) to authenticated;
revoke execute on function public.check_rate_limit(text, integer, integer) from anon;

-- Service-role-only version, for pre-authentication Edge Function endpoints
-- (biometric login/attendance), keyed on an arbitrary caller-supplied key
-- (e.g. request IP), since no auth.uid() exists yet.
create or replace function public.check_rate_limit_internal(
  p_key text,
  p_max_requests integer,
  p_window_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
  v_retry_after_ms bigint;
begin
  select window_start, count into v_window_start, v_count
  from public.rate_limits where key = p_key for update;

  if not found then
    insert into public.rate_limits (key, window_start, count) values (p_key, v_now, 1);
    return jsonb_build_object('allowed', true);
  end if;

  if v_now - v_window_start > make_interval(secs => p_window_seconds) then
    update public.rate_limits set window_start = v_now, count = 1 where key = p_key;
    return jsonb_build_object('allowed', true);
  end if;

  if v_count >= p_max_requests then
    v_retry_after_ms := ceil(extract(epoch from
      (v_window_start + make_interval(secs => p_window_seconds) - v_now)) * 1000);
    return jsonb_build_object('allowed', false, 'retry_after_ms', greatest(v_retry_after_ms, 0));
  end if;

  update public.rate_limits set count = count + 1 where key = p_key;
  return jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.check_rate_limit_internal(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit_internal(text, integer, integer) to service_role;


-- ============================================================================
-- 3. PROFILES — RLS + column-protection triggers + email sync
-- ============================================================================

alter table if exists public.profiles enable row level security;

drop policy if exists profiles_select_own_or_supervisor on public.profiles;
create policy profiles_select_own_or_supervisor
  on public.profiles
  for select
  using (public.is_supervisor() or public.is_self(id));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles
  for insert
  with check (public.is_self(id));

drop policy if exists profiles_update_own_or_supervisor on public.profiles;
create policy profiles_update_own_or_supervisor
  on public.profiles
  for update
  using (public.is_supervisor() or public.is_self(id))
  with check (public.is_supervisor() or public.is_self(id));

drop policy if exists profiles_delete_supervisor_only on public.profiles;
create policy profiles_delete_supervisor_only
  on public.profiles
  for delete
  using (public.is_supervisor());

-- Raw biometric data: no client, of any role, may read this column directly.
-- Only the service role (used inside the biometric Edge Functions) can.
revoke select (face_descriptor) on public.profiles from anon, authenticated;

-- Column-level protection: RLS above permits a self-update of the *row*,
-- which would otherwise implicitly permit changing role/leave-allowance
-- columns too. This trigger closes that gap.
create or replace function public.protect_privileged_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    if new.role is distinct from old.role then
      raise exception 'Only supervisors can change role';
    end if;
    if new.vacation_days is distinct from old.vacation_days
       or new.sick_days is distinct from old.sick_days then
      raise exception 'Only supervisors can adjust leave allowances';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns
  before update on public.profiles
  for each row execute function public.protect_privileged_profile_columns();

-- Same protection at signup time: role must start as 'employee' unless a
-- supervisor is the one creating the row.
create or replace function public.enforce_signup_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() and new.role is distinct from 'employee' then
    raise exception 'New accounts must be created with role=employee';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_signup_role on public.profiles;
create trigger enforce_signup_role
  before insert on public.profiles
  for each row execute function public.enforce_signup_role();

-- Keep profiles.email in sync with auth.users.email (required by the
-- biometric-login Edge Function's generateLink call).
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is null;

create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists sync_profile_email on auth.users;
create trigger sync_profile_email
  after update of email on auth.users
  for each row execute function public.sync_profile_email();


-- ============================================================================
-- 4. TASKS — RLS (corrected assigned_to type) + approval-status protection
-- ============================================================================

alter table if exists public.tasks enable row level security;

drop policy if exists tasks_select_own_or_supervisor on public.tasks;
create policy tasks_select_own_or_supervisor
  on public.tasks
  for select
  using (public.is_supervisor() or auth.uid()::text = any(coalesce(assigned_to, '{}'::text[])));

drop policy if exists tasks_insert_supervisor_only on public.tasks;
create policy tasks_insert_supervisor_only
  on public.tasks
  for insert
  with check (public.is_supervisor());

drop policy if exists tasks_update_own_or_supervisor on public.tasks;
create policy tasks_update_own_or_supervisor
  on public.tasks
  for update
  using (public.is_supervisor() or auth.uid()::text = any(coalesce(assigned_to, '{}'::text[])))
  with check (public.is_supervisor() or auth.uid()::text = any(coalesce(assigned_to, '{}'::text[])));

drop policy if exists tasks_delete_supervisor_only on public.tasks;
create policy tasks_delete_supervisor_only
  on public.tasks
  for delete
  using (public.is_supervisor());

-- Column-level protection: an assigned employee can update their task row
-- (e.g. to submit a file), but must not be able to set status to an
-- approval-type value themselves.
create or replace function public.protect_approval_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor()
     and new.status is distinct from old.status
     and new.status in ('Approved', 'Rejected') then
    raise exception 'Only supervisors can approve or reject';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_task_approval on public.tasks;
create trigger protect_task_approval
  before update on public.tasks
  for each row execute function public.protect_approval_status();


-- ============================================================================
-- 5. ATTENDANCE — RLS
-- ============================================================================

alter table if exists public.attendance enable row level security;

drop policy if exists attendance_select_own_or_supervisor on public.attendance;
create policy attendance_select_own_or_supervisor
  on public.attendance
  for select
  using (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists attendance_insert_own_or_supervisor on public.attendance;
create policy attendance_insert_own_or_supervisor
  on public.attendance
  for insert
  with check (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists attendance_update_own_or_supervisor on public.attendance;
create policy attendance_update_own_or_supervisor
  on public.attendance
  for update
  using (public.is_supervisor() or employee_id = auth.uid())
  with check (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists attendance_delete_supervisor_only on public.attendance;
create policy attendance_delete_supervisor_only
  on public.attendance
  for delete
  using (public.is_supervisor());

-- Note: the biometric-attendance Edge Function writes here using the
-- service role (bypassing this RLS entirely by design, only after a
-- verified face match). The manual clock-in button still goes through
-- this policy directly, with no biometric check — a known, deliberate
-- product decision, not an oversight.


-- ============================================================================
-- 6. LEAVE REQUESTS — RLS + approval-status protection (shared trigger fn)
-- ============================================================================

alter table if exists public.leave_requests enable row level security;

drop policy if exists leave_select_own_or_supervisor on public.leave_requests;
create policy leave_select_own_or_supervisor
  on public.leave_requests
  for select
  using (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists leave_insert_own on public.leave_requests;
create policy leave_insert_own
  on public.leave_requests
  for insert
  with check (employee_id = auth.uid());

drop policy if exists leave_update_own_or_supervisor on public.leave_requests;
create policy leave_update_own_or_supervisor
  on public.leave_requests
  for update
  using (public.is_supervisor() or employee_id = auth.uid())
  with check (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists leave_delete_own_or_supervisor on public.leave_requests;
create policy leave_delete_own_or_supervisor
  on public.leave_requests
  for delete
  using (public.is_supervisor() or employee_id = auth.uid());

drop trigger if exists protect_leave_approval on public.leave_requests;
create trigger protect_leave_approval
  before update on public.leave_requests
  for each row execute function public.protect_approval_status();


-- ============================================================================
-- 7. CONTRIBUTIONS (team forum) — RLS corrected to team-wide read
-- ============================================================================

alter table if exists public.contributions enable row level security;

-- Corrected: this is a team-wide forum feed (fetchContributions() does an
-- unfiltered select('*') by design). The original owner-only SELECT policy
-- would have broken the feature for every non-supervisor user.
drop policy if exists contributions_select_own_or_supervisor on public.contributions;
drop policy if exists contributions_select_all on public.contributions;
create policy contributions_select_all
  on public.contributions
  for select
  to authenticated
  using (true);

drop policy if exists contributions_insert_own on public.contributions;
create policy contributions_insert_own
  on public.contributions
  for insert
  with check (employee_id = auth.uid());

drop policy if exists contributions_update_own_or_supervisor on public.contributions;
create policy contributions_update_own_or_supervisor
  on public.contributions
  for update
  using (public.is_supervisor() or employee_id = auth.uid())
  with check (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists contributions_delete_own_or_supervisor on public.contributions;
create policy contributions_delete_own_or_supervisor
  on public.contributions
  for delete
  using (public.is_supervisor() or employee_id = auth.uid());


-- ============================================================================
-- 8. CONTRIBUTION_REPLIES — new table, replaces the old replies/"Replies"
--    jsonb columns (dropped at the end of this section)
-- ============================================================================

create table if not exists public.contribution_replies (
  id uuid primary key default gen_random_uuid(),
  post_id bigint not null references public.contributions(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  message text not null check (char_length(trim(message)) > 0),
  created_at timestamptz not null default now()
);

alter table public.contribution_replies enable row level security;

drop policy if exists replies_select_all on public.contribution_replies;
create policy replies_select_all
  on public.contribution_replies
  for select
  to authenticated
  using (true);

drop policy if exists replies_insert_own on public.contribution_replies;
create policy replies_insert_own
  on public.contribution_replies
  for insert
  to authenticated
  with check (author_id = auth.uid());

drop policy if exists replies_update_own_or_supervisor on public.contribution_replies;
create policy replies_update_own_or_supervisor
  on public.contribution_replies
  for update
  using (public.is_supervisor() or author_id = auth.uid())
  with check (public.is_supervisor() or author_id = auth.uid());

drop policy if exists replies_delete_own_or_supervisor on public.contribution_replies;
create policy replies_delete_own_or_supervisor
  on public.contribution_replies
  for delete
  using (public.is_supervisor() or author_id = auth.uid());

-- One-time migration of any existing jsonb reply data, then drop the old
-- columns. Comment out the INSERT if this has already been run once.
insert into public.contribution_replies (post_id, author_id, message, created_at)
select
  c.id,
  (r->>'author_id')::uuid,
  r->>'message',
  coalesce((r->>'created_at')::timestamptz, c.created_at)
from public.contributions c,
     jsonb_array_elements(coalesce(c.replies, '[]'::jsonb)) as r
where r->>'author_id' is not null
on conflict do nothing;

alter table public.contributions drop column if exists replies;
alter table public.contributions drop column if exists "Replies";


-- ============================================================================
-- 9. PERFORMANCE_EVALUATIONS — RLS (fully supervisor-gated, no column
--    trigger needed)
-- ============================================================================

alter table if exists public.performance_evaluations enable row level security;

drop policy if exists evaluations_select_own_or_supervisor on public.performance_evaluations;
create policy evaluations_select_own_or_supervisor
  on public.performance_evaluations
  for select
  using (public.is_supervisor() or employee_id = auth.uid() or supervisor_id = auth.uid());

drop policy if exists evaluations_insert_supervisor_only on public.performance_evaluations;
create policy evaluations_insert_supervisor_only
  on public.performance_evaluations
  for insert
  with check (public.is_supervisor() and supervisor_id = auth.uid());

drop policy if exists evaluations_update_supervisor_only on public.performance_evaluations;
create policy evaluations_update_supervisor_only
  on public.performance_evaluations
  for update
  using (public.is_supervisor() and supervisor_id = auth.uid())
  with check (public.is_supervisor() and supervisor_id = auth.uid());

drop policy if exists evaluations_delete_supervisor_only on public.performance_evaluations;
create policy evaluations_delete_supervisor_only
  on public.performance_evaluations
  for delete
  using (public.is_supervisor());


-- ============================================================================
-- 10. NOTIFICATIONS — RLS (no client INSERT) + server-side triggers
-- ============================================================================

alter table if exists public.notifications enable row level security;

drop policy if exists notifications_select_own_or_supervisor on public.notifications;
create policy notifications_select_own_or_supervisor
  on public.notifications
  for select
  using (public.is_supervisor() or user_id = auth.uid());

-- Corrected: the original policy allowed a client to insert a notification
-- addressed to any user_id as long as the caller was a supervisor OR the
-- target was themself — which still permitted employees to insert
-- self-notifications, and broke entirely for the employee -> supervisor
-- notification flows (submission, leave request, urgent post). Removed
-- entirely: no INSERT policy means no client, of any role, may insert here.
-- All notifications are now created exclusively by the SECURITY DEFINER
-- triggers below via public.notify(), which bypass RLS.
drop policy if exists notifications_insert_own_or_supervisor on public.notifications;

drop policy if exists notifications_update_own_or_supervisor on public.notifications;
create policy notifications_update_own_or_supervisor
  on public.notifications
  for update
  using (public.is_supervisor() or user_id = auth.uid())
  with check (public.is_supervisor() or user_id = auth.uid());

drop policy if exists notifications_delete_supervisor_only on public.notifications;
create policy notifications_delete_supervisor_only
  on public.notifications
  for delete
  using (public.is_supervisor());

create or replace function public.notify(p_user_id uuid, p_message text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, message) values (p_user_id, p_message);
$$;

-- New task assigned -> notify each assignee
create or replace function public.trg_notify_task_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid text;
begin
  if tg_op = 'INSERT' then
    foreach uid in array coalesce(new.assigned_to, '{}'::text[])
    loop
      perform public.notify(uid::uuid, format('New Task Assigned: %s', new.title));
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_task_assigned on public.tasks;
create trigger notify_task_assigned
  after insert on public.tasks
  for each row execute function public.trg_notify_task_assigned();

-- Task status changes -> notify supervisor(s) on submission, assignees on
-- approval/revision
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
      foreach uid in array coalesce(new.assigned_to, '{}'::text[])
      loop
        perform public.notify(uid::uuid, format('Revision requested on "%s".', new.title));
      end loop;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_task_status_change on public.tasks;
create trigger notify_task_status_change
  after update on public.tasks
  for each row execute function public.trg_notify_task_status_change();

-- New leave request -> notify supervisor(s)
create or replace function public.trg_notify_leave_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  supervisor record;
  requester_name text;
begin
  if tg_op = 'INSERT' then
    select name into requester_name from public.profiles where id = new.employee_id;
    for supervisor in select id from public.profiles where role = 'supervisor'
    loop
      perform public.notify(supervisor.id, format('Leave Request: %s has submitted a new %s form.', coalesce(requester_name, 'An employee'), new.type));
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_leave_submitted on public.leave_requests;
create trigger notify_leave_submitted
  after insert on public.leave_requests
  for each row execute function public.trg_notify_leave_submitted();

-- Leave approved/rejected -> notify requester
create or replace function public.trg_notify_leave_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    perform public.notify(new.employee_id, format('Leave Request Update: Your request for %s has been %s.', new.type, new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists notify_leave_status_change on public.leave_requests;
create trigger notify_leave_status_change
  after update on public.leave_requests
  for each row execute function public.trg_notify_leave_status_change();

-- Urgent forum post -> notify supervisor(s)
create or replace function public.trg_notify_urgent_contribution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  supervisor record;
  author_name text;
begin
  if tg_op = 'INSERT' and new.category = 'urgent' then
    select name into author_name from public.profiles where id = new.employee_id;
    for supervisor in select id from public.profiles where role = 'supervisor'
    loop
      perform public.notify(supervisor.id, format('Action Required: %s posted an urgent %s in the forum.', coalesce(author_name, 'Someone'), new.category));
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_urgent_contribution on public.contributions;
create trigger notify_urgent_contribution
  after insert on public.contributions
  for each row execute function public.trg_notify_urgent_contribution();

-- New reply -> notify original post author
create or replace function public.trg_notify_new_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  post_author uuid;
begin
  select employee_id into post_author from public.contributions where id = new.post_id;
  if post_author is not null and post_author <> new.author_id then
    perform public.notify(post_author, 'Someone replied to your forum post.');
  end if;
  return new;
end;
$$;

drop trigger if exists notify_new_reply on public.contribution_replies;
create trigger notify_new_reply
  after insert on public.contribution_replies
  for each row execute function public.trg_notify_new_reply();

-- Performance evaluation created/updated -> notify employee
create or replace function public.trg_notify_evaluation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify(
    new.employee_id,
    case tg_op
      when 'INSERT' then format('New Performance Review: You have received a formal evaluation score of %s Pts.', new.final_score)
      else format('Review Updated: Your performance appraisal has been amended. Index: %s Pts.', new.final_score)
    end
  );
  return new;
end;
$$;

drop trigger if exists notify_evaluation on public.performance_evaluations;
create trigger notify_evaluation
  after insert or update on public.performance_evaluations
  for each row execute function public.trg_notify_evaluation();


-- ============================================================================
-- 11. FACES — legacy/unused table, RLS applied defensively
-- ============================================================================
-- The live app stores biometric data in profiles.face_descriptor, not this
-- table (confirmed unused via code search). RLS is applied regardless, in
-- case it's adopted later or was already reachable via the API.

alter table if exists public.faces enable row level security;

drop policy if exists faces_select_own_or_supervisor on public.faces;
create policy faces_select_own_or_supervisor
  on public.faces
  for select
  using (public.is_supervisor() or profile_id = auth.uid());

drop policy if exists faces_insert_own_or_supervisor on public.faces;
create policy faces_insert_own_or_supervisor
  on public.faces
  for insert
  with check (public.is_supervisor() or profile_id = auth.uid());

drop policy if exists faces_update_own_or_supervisor on public.faces;
create policy faces_update_own_or_supervisor
  on public.faces
  for update
  using (public.is_supervisor() or profile_id = auth.uid())
  with check (public.is_supervisor() or profile_id = auth.uid());

drop policy if exists faces_delete_own_or_supervisor on public.faces;
create policy faces_delete_own_or_supervisor
  on public.faces
  for delete
  using (public.is_supervisor() or profile_id = auth.uid());


-- ============================================================================
-- 12. STORAGE BUCKETS — authoritative file-type/size enforcement
-- ============================================================================
-- Client-side MIME/extension checks (sanitize.js, validateMime.js) are UX
-- only and bypassable via direct API calls. This is the layer that's
-- actually enforced server-side by Supabase Storage.

update storage.buckets
set
  file_size_limit = 10485760, -- 10MB
  allowed_mime_types = array[
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'text/plain'
  ]
where id = 'task_submission';

update storage.buckets
set
  file_size_limit = 2097152, -- 2MB
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'avatars';

-- ============================================================================
-- End of migration.
--
-- Orphaned tables not covered here — verify RLS status separately before
-- deciding whether to lock down or drop:
--   select relname, relrowsecurity from pg_class
--   where relname in ('performance_reviews','forum_posts','forum_comments','attendance_logs')
--   and relnamespace = 'public'::regnamespace;
-- ===========================================================================


