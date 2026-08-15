-- Bug fix for 20260815_add_identify_face_by_descriptor.sql: the original
-- version used a hard `having min(distance) < p_threshold` filter, so any
-- live descriptor whose closest match landed even slightly above the
-- threshold returned ZERO rows -- the Debug Center panel just says "No
-- enrolled match found", with no visibility into how close the real
-- nearest match actually was. Reported live: a supervisor whose face
-- reliably passes the real login match (same 0.5 threshold) still got "no
-- match" from this debug panel -- impossible to tell from that message
-- alone whether it's a genuine data bug or the live capture in this panel
-- (different lighting/angle/detector warm-up than a real login attempt)
-- just landed a bit above the line.
--
-- Now always returns the single closest match (if anyone in the system
-- has an enrolled face_descriptor at all), with its real distance --
-- p_threshold is no longer a hard filter, just returned alongside so the
-- client can label the result "confident match" vs "closest guess, above
-- the match threshold" instead of getting no information at all.

-- create or replace can't change an existing function's OUT-parameter
-- (return table) shape -- must drop the old 4-column version first.
drop function if exists public.identify_face_by_descriptor(jsonb, float8);

create or replace function public.identify_face_by_descriptor(p_descriptor jsonb, p_threshold float8 default 0.5)
returns table(
    profile_id uuid,
    profile_name text,
    profile_role text,
    distance float8,
    threshold float8
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
        min(public.euclidean_distance_jsonb(elem, p_descriptor)) as distance,
        p_threshold as threshold
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
    order by distance asc
    limit 1;
end;
$$;
