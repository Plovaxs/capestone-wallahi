-- ============================================================================
-- SELF-ASSESSMENT (employee self-scores before/independent of supervisor review)
-- ============================================================================
-- Kept as its own table rather than adding self_scores/self_comments
-- columns to performance_evaluations -- that table's RLS is "fully
-- supervisor-gated, no column trigger needed" by design (see
-- 20260712_add_rls_policies.sql section 9); carving out an employee-
-- writable exception there would mean either relaxing that policy (wider
-- blast radius) or adding a new column-protection trigger (more moving
-- parts) for a value entirely separate from the official evaluation.
-- A dedicated table keeps the officially-graded record and the
-- employee's own self-rating cleanly separate, with independent RLS.

create table if not exists public.self_assessments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  scores jsonb not null default '{}'::jsonb,
  comments text,
  submitted_at timestamptz not null default now()
);

create index if not exists self_assessments_employee_idx on public.self_assessments (employee_id, submitted_at desc);

alter table public.self_assessments enable row level security;

drop policy if exists self_assessments_select_own_or_supervisor on public.self_assessments;
create policy self_assessments_select_own_or_supervisor
  on public.self_assessments
  for select
  using (public.is_supervisor() or employee_id = auth.uid());

drop policy if exists self_assessments_insert_own on public.self_assessments;
create policy self_assessments_insert_own
  on public.self_assessments
  for insert
  with check (employee_id = auth.uid());

drop policy if exists self_assessments_delete_supervisor_only on public.self_assessments;
create policy self_assessments_delete_supervisor_only
  on public.self_assessments
  for delete
  using (public.is_supervisor());
