-- Debug Center "who does this detected face belong to" testing feature:
-- identifies a live-captured face descriptor against every enrolled
-- employee's stored template(s), server-side only. Same discipline as
-- 20260810_add_duplicate_enrollment_detection.sql -- face_descriptor is
-- never bulk-fetched to the client to do this comparison (see
-- profilesRepository.js's column-selection comment); the client sends one
-- live descriptor in, the database returns only the best match's identity
-- and distance, never anyone's raw stored template. Supervisor-gated
-- inside the function itself, same pattern as every other privileged RPC
-- in this schema.
-- Prerequisite: 20260712_add_rls_policies.sql (uses its is_supervisor()),
-- 20260810_add_duplicate_enrollment_detection.sql (uses its
-- euclidean_distance_jsonb()).

create or replace function public.identify_face_by_descriptor(p_descriptor jsonb, p_threshold float8 default 0.5)
returns table(
    profile_id uuid,
    profile_name text,
    profile_role text,
    distance float8
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_supervisor() then
        raise exception 'Only supervisors can run face identification';
    end if;

    if p_descriptor is null or jsonb_typeof(p_descriptor) <> 'array' then
        return;
    end if;

    return query
    select
        p.id,
        p.name,
        p.role,
        min(public.euclidean_distance_jsonb(elem, p_descriptor)) as distance
    from public.profiles p,
         lateral jsonb_array_elements(
             case
                 when jsonb_typeof(p.face_descriptor::jsonb) = 'array'
                      and jsonb_typeof((p.face_descriptor::jsonb) -> 0) = 'array'
                 then p.face_descriptor::jsonb
                 else jsonb_build_array(p.face_descriptor::jsonb)
             end
         ) as elem
    where p.face_descriptor is not null
    group by p.id, p.name, p.role
    having min(public.euclidean_distance_jsonb(elem, p_descriptor)) < p_threshold
    order by distance asc
    limit 1;
end;
$$;
