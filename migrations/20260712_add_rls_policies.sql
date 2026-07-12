-- Migration: Enable Row Level Security and add baseline policies
-- Apply this in Supabase after the core tables exist.

-- Helper: current user's role from public.profiles
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

-- Profiles
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

-- Tasks
alter table if exists public.tasks enable row level security;
drop policy if exists tasks_select_own_or_supervisor on public.tasks;
create policy tasks_select_own_or_supervisor
  on public.tasks
  for select
  using (public.is_supervisor() or auth.uid() = any(coalesce(assigned_to, '{}'::uuid[])));

drop policy if exists tasks_insert_supervisor_only on public.tasks;
create policy tasks_insert_supervisor_only
  on public.tasks
  for insert
  with check (public.is_supervisor());

drop policy if exists tasks_update_own_or_supervisor on public.tasks;
create policy tasks_update_own_or_supervisor
  on public.tasks
  for update
  using (public.is_supervisor() or auth.uid() = any(coalesce(assigned_to, '{}'::uuid[])))
  with check (public.is_supervisor() or auth.uid() = any(coalesce(assigned_to, '{}'::uuid[])));

drop policy if exists tasks_delete_supervisor_only on public.tasks;
create policy tasks_delete_supervisor_only
  on public.tasks
  for delete
  using (public.is_supervisor());

-- Attendance
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

-- Leave requests
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

-- Contributions
alter table if exists public.contributions enable row level security;
drop policy if exists contributions_select_own_or_supervisor on public.contributions;
create policy contributions_select_own_or_supervisor
  on public.contributions
  for select
  using (public.is_supervisor() or employee_id = auth.uid());

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

-- Performance evaluations
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

-- Notifications
alter table if exists public.notifications enable row level security;
drop policy if exists notifications_select_own_or_supervisor on public.notifications;
create policy notifications_select_own_or_supervisor
  on public.notifications
  for select
  using (public.is_supervisor() or user_id = auth.uid());

drop policy if exists notifications_insert_own_or_supervisor on public.notifications;
create policy notifications_insert_own_or_supervisor
  on public.notifications
  for insert
  with check (public.is_supervisor() or user_id = auth.uid());

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

-- Faces
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
