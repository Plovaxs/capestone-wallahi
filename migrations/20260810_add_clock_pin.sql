-- ============================================================================
-- PIN + GEOFENCE CLOCK-IN/OUT (camera-free alternative to the face-scan flow)
-- ============================================================================
-- Employees can optionally set a numeric PIN (Settings) and use it, combined
-- with the SAME geofence check the face flow already enforces (WFO requires
-- being in range; WFH bypasses -- see officeGeofence.js / AttendanceView.jsx),
-- to clock in/out without the camera. The PIN itself is never stored or
-- compared in plaintext -- hashed server-side via pgcrypto's bcrypt (crypt()
-- + gen_salt('bf')), and verification is scoped to auth.uid()'s own row only
-- (verify_clock_pin takes no employee_id parameter), so there is no way to
-- use this RPC to brute-force or probe another employee's PIN.

-- 🟩 Supabase projects install pgcrypto into the `extensions` schema (not
-- `public`) by default -- this only actually creates it if truly absent;
-- on this project it already exists there. crypt()/gen_salt() below are
-- called fully-qualified as extensions.crypt()/extensions.gen_salt()
-- rather than relying on search_path to find them, since search_path is
-- deliberately pinned to just `public` in every function here.
create extension if not exists pgcrypto with schema extensions;

alter table public.profiles add column if not exists clock_pin_hash text;
alter table public.attendance add column if not exists clock_method text;

create or replace function public.set_clock_pin(pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if pin is null or pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN must be 4-8 digits';
  end if;
  update public.profiles set clock_pin_hash = extensions.crypt(pin, extensions.gen_salt('bf')) where id = auth.uid();
end;
$$;

grant execute on function public.set_clock_pin(text) to authenticated;

create or replace function public.clear_clock_pin()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set clock_pin_hash = null where id = auth.uid();
$$;

grant execute on function public.clear_clock_pin() to authenticated;

-- Deliberately scoped to the CALLER's own PIN only (no employee_id
-- parameter) -- this is a personal-device convenience flow (the employee
-- is already logged into their own account in the browser), not a shared
-- kiosk, so there is never a legitimate reason for one account to verify
-- another account's PIN. This also closes off using the RPC itself as an
-- enumeration/brute-force vector against other employees.
create or replace function public.verify_clock_pin(pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  stored text;
begin
  select clock_pin_hash into stored from public.profiles where id = auth.uid();
  if stored is null then
    return false;
  end if;
  return stored = extensions.crypt(pin, stored);
end;
$$;

grant execute on function public.verify_clock_pin(text) to authenticated;
