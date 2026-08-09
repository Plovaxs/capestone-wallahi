-- In-app, Sentry-style error monitoring: a self-hosted alternative to a
-- third-party service (no external account needed) so supervisors have
-- visibility into client-side crashes/API failures that were previously
-- only ever visible in an individual user's own browser console, i.e.
-- never seen by anyone on the team. Prerequisite: 20260712_add_rls_policies.sql
-- (uses the shared is_supervisor() helper it defines).

create table if not exists public.client_error_logs (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    user_id uuid references public.profiles(id) on delete set null,
    user_email text,
    message text not null,
    stack text,
    url text,
    user_agent text,
    context jsonb
);

create index if not exists client_error_logs_created_at_idx on public.client_error_logs (created_at desc);

alter table public.client_error_logs enable row level security;

-- Any authenticated user can log THEIR OWN error (user_id must match their
-- own auth.uid(), preventing one user from forging reports attributed to
-- someone else) -- this is what makes the reports actually useful for
-- debugging, but nobody should be able to read anyone else's.
drop policy if exists client_error_logs_insert_own on public.client_error_logs;
create policy client_error_logs_insert_own
  on public.client_error_logs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists client_error_logs_select_supervisor_only on public.client_error_logs;
create policy client_error_logs_select_supervisor_only
  on public.client_error_logs
  for select
  using (public.is_supervisor());

drop policy if exists client_error_logs_delete_supervisor_only on public.client_error_logs;
create policy client_error_logs_delete_supervisor_only
  on public.client_error_logs
  for delete
  using (public.is_supervisor());
