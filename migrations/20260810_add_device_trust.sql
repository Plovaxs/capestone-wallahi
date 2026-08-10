-- ============================================================================
-- DEVICE TRUST / NEW-DEVICE DETECTION
-- ============================================================================
-- Standard SaaS fraud-prevention pattern (Fingerprint.com, TrustDecision-
-- style device intelligence, "new sign-in" alerts from Google/GitHub/etc.):
-- tracks a lightweight, client-computed device fingerprint per user, and
-- surfaces (to both the account owner via a notification, and supervisors
-- via a dedicated panel) whenever a login happens from a device that
-- account has never used before. This is deliberately NOT a hard block --
-- there's no second factor to step up TO yet in this app beyond the face/
-- PIN checks that already ran to get here -- it's a visibility/detection
-- control: the legitimate owner finds out "someone signed into my account
-- from a device I don't recognize" instead of it going unnoticed.

create table if not exists public.known_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  fingerprint text not null,
  label text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, fingerprint)
);

create index if not exists known_devices_user_idx on public.known_devices (user_id, last_seen_at desc);

alter table public.known_devices enable row level security;

drop policy if exists known_devices_select_own_or_supervisor on public.known_devices;
create policy known_devices_select_own_or_supervisor
  on public.known_devices
  for select
  using (public.is_supervisor() or user_id = auth.uid());

drop policy if exists known_devices_insert_own on public.known_devices;
create policy known_devices_insert_own
  on public.known_devices
  for insert
  with check (user_id = auth.uid());

drop policy if exists known_devices_update_own on public.known_devices;
create policy known_devices_update_own
  on public.known_devices
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- New device -> log it to the audit trail AND notify the account owner
-- (reuses the existing public.notify() helper from 20260712_add_rls_policies.sql).
create or replace function public.trg_notify_new_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_audit_event(
    'new_device_seen', 'profile', new.user_id::text,
    jsonb_build_object('device_label', new.label)
  );
  perform public.notify(new.user_id, format('New device sign-in detected: %s', coalesce(new.label, 'Unknown device')));
  return new;
end;
$$;

drop trigger if exists notify_new_device on public.known_devices;
create trigger notify_new_device
  after insert on public.known_devices
  for each row execute function public.trg_notify_new_device();
