-- Global, database-backed app settings -- the first concrete need is a
-- supervisor-controllable on/off switch for the virtual-camera-driver
-- block on face sign-in (src/vision/virtualCameraDetector.js). Reported
-- live: a real user's legitimate virtual-camera driver (for testing/
-- screen-sharing purposes) got hard-blocked with no way to proceed
-- except falling back to email+password -- a supervisor needs to be able
-- to relax that check for everyone, from one place, without a redeploy.
--
-- Deliberately NOT the existing per-browser FeatureFlagService
-- (src/feature-flags/FeatureFlagService.js) -- that's a localStorage
-- override, invisible to every other browser/device, which defeats the
-- point of "one supervisor flips it, it applies for everyone." This is a
-- real, tiny key-value table instead.
--
-- Publicly READABLE (including by the anon role) because the check this
-- gates runs on LoginPage.jsx -- before the user is authenticated at all.
-- WRITABLE only by supervisors.

create table if not exists public.system_settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now(),
    updated_by uuid references public.profiles(id)
);

alter table public.system_settings enable row level security;

drop policy if exists system_settings_select_all on public.system_settings;
create policy system_settings_select_all
    on public.system_settings
    for select
    to anon, authenticated
    using (true);

drop policy if exists system_settings_write_supervisor on public.system_settings;
create policy system_settings_write_supervisor
    on public.system_settings
    for all
    to authenticated
    using (public.is_supervisor())
    with check (public.is_supervisor());

insert into public.system_settings (key, value)
values ('virtual_camera_check_enabled', 'true'::jsonb)
on conflict (key) do nothing;
