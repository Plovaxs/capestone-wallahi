-- Ghost-employee / duplicate-enrollment detection: a classic outsourcing-
-- payroll fraud pattern is one real person enrolled under two different
-- profile accounts (to double-claim wages/allowances). Compares every
-- enrolled employee's stored face template(s) against every OTHER
-- employee's pairwise, server-side only -- face_descriptor never leaves
-- the database to do this (the client never bulk-fetches biometric
-- templates; see profilesRepository.js's column-selection comment for why
-- that's deliberate). Supervisor-gated inside the function itself, same
-- pattern as every other privileged RPC in this schema.
-- Prerequisite: 20260712_add_rls_policies.sql (uses its is_supervisor()).

-- Pure Euclidean distance between two JSONB arrays of the same length
-- (face-api.js descriptors are always 128 numbers) -- kept as its own
-- small, independently testable function rather than inlined.
create or replace function public.euclidean_distance_jsonb(a jsonb, b jsonb)
returns float8
language plpgsql
immutable
as $$
declare
    i int;
    diff float8;
    total float8 := 0;
begin
    if a is null or b is null then return null; end if;
    if jsonb_typeof(a) <> 'array' or jsonb_typeof(b) <> 'array' then return null; end if;
    if jsonb_array_length(a) <> jsonb_array_length(b) then return null; end if;

    for i in 0..jsonb_array_length(a) - 1 loop
        diff := (a->>i)::float8 - (b->>i)::float8;
        total := total + diff * diff;
    end loop;

    return sqrt(total);
end;
$$;

create or replace function public.find_duplicate_enrollments(p_threshold float8 default 0.5)
returns table(
    employee_a_id uuid,
    employee_a_name text,
    employee_b_id uuid,
    employee_b_name text,
    min_distance float8
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_supervisor() then
        raise exception 'Only supervisors can run duplicate-enrollment detection';
    end if;

    create temporary table if not exists _tmp_enrollment_templates (
        profile_id uuid,
        profile_name text,
        template jsonb
    ) on commit drop;
    -- 🟩 FIX: this project's database rejects a bare DELETE with no WHERE
    -- clause ("DELETE requires a WHERE clause") -- surfaced as a live 400
    -- the first time a supervisor actually clicked "Check for Duplicates".
    -- TRUNCATE is also the semantically correct statement for "empty this
    -- temp table" (faster than DELETE too) and isn't subject to that guard.
    truncate _tmp_enrollment_templates;

    -- One row per (employee, template) -- handles both legacy single-
    -- template enrollment (a flat 128-number array) and multi-angle
    -- enrollment (an array of several 128-number arrays), same shape
    -- ambiguity src/vision/multiTemplateMatcher.js's normalizeStoredTemplates
    -- already handles client-side.
    insert into _tmp_enrollment_templates (profile_id, profile_name, template)
    select p.id, p.name, elem
    from public.profiles p,
         lateral jsonb_array_elements(
             case
                 when jsonb_typeof(p.face_descriptor::jsonb) = 'array'
                      and jsonb_typeof((p.face_descriptor::jsonb) -> 0) = 'array'
                 then p.face_descriptor::jsonb
                 else jsonb_build_array(p.face_descriptor::jsonb)
             end
         ) as elem
    where p.role = 'employee' and p.face_descriptor is not null;

    return query
    select
        a.profile_id, a.profile_name,
        b.profile_id, b.profile_name,
        min(public.euclidean_distance_jsonb(a.template, b.template))
    from _tmp_enrollment_templates a
    join _tmp_enrollment_templates b on a.profile_id < b.profile_id
    group by a.profile_id, a.profile_name, b.profile_id, b.profile_name
    having min(public.euclidean_distance_jsonb(a.template, b.template)) < p_threshold
    order by 5 asc;
end;
$$;
