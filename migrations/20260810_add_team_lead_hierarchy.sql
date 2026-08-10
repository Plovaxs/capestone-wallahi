-- ============================================================================
-- TEAM/DEPARTMENT HIERARCHY (minimal, additive, low-blast-radius version)
-- ============================================================================
-- Adds a "team lead" designation a supervisor can grant to one employee per
-- department: read-only visibility into their department's other profiles,
-- WITHOUT granting any of the write/approval powers reserved for
-- is_supervisor() (task approval, leave approval, review authoring, role
-- changes, etc). Deliberately minimal: this app's existing RLS model is a
-- flat employee/supervisor split threaded through 10+ tables, and rebuilding
-- that as a full N-level hierarchy would touch all of it. A team lead here
-- is scoped to exactly one new capability (see profiles_select_team_lead_
-- department below) rather than a new tier of is_supervisor()-equivalent power.

alter table public.profiles add column if not exists is_team_lead boolean not null default false;

-- SECURITY DEFINER helpers (same pattern as is_supervisor()/is_self() in
-- 20260712_add_rls_policies.sql) -- querying public.profiles from inside a
-- policy on public.profiles would otherwise recurse through RLS itself.
create or replace function public.is_team_lead()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_team_lead from public.profiles where id = auth.uid()), false);
$$;

grant execute on function public.is_team_lead() to authenticated;

create or replace function public.my_department()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select department from public.profiles where id = auth.uid();
$$;

grant execute on function public.my_department() to authenticated;

-- Additive SELECT policy: Postgres OR's multiple permissive policies for
-- the same command together, so this can only ever widen who can read a
-- row beyond the existing profiles_select_own_or_supervisor policy, never
-- narrow it.
drop policy if exists profiles_select_team_lead_department on public.profiles;
create policy profiles_select_team_lead_department
  on public.profiles
  for select
  using (
    public.is_team_lead()
    and department is not null
    and department = public.my_department()
  );

-- Only a supervisor may grant/revoke the team-lead designation itself --
-- extends the existing column-protection trigger (role, leave allowances)
-- rather than adding a second competing trigger.
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
    if new.is_team_lead is distinct from old.is_team_lead then
      raise exception 'Only supervisors can change team-lead status';
    end if;
  end if;
  return new;
end;
$$;

-- Read-only visibility into the team's attendance -- the most practically
-- useful thing a team lead actually needs ("who on my team is in today"),
-- without granting any write/approval power (insert/update/delete stay
-- restricted to the existing supervisor-or-self policies).
drop policy if exists attendance_select_team_lead_department on public.attendance;
create policy attendance_select_team_lead_department
  on public.attendance
  for select
  using (
    public.is_team_lead()
    and exists (
      select 1 from public.profiles p
      where p.id = attendance.employee_id
        and p.department is not null
        and p.department = public.my_department()
    )
  );
