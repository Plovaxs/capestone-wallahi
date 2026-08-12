-- ============================================================================
-- TRUSTED DEVICE SELF-REVOKE (Settings > Security > Trusted Devices)
-- ============================================================================
-- 20260810_add_device_trust.sql created known_devices with select/insert/
-- update policies for the owning user, but no delete policy -- so a user
-- could see their trusted-device list but never remove an entry from it
-- (e.g. a shared/borrowed device they no longer use). This is the missing
-- policy, scoped identically to the existing own-row policies.

drop policy if exists known_devices_delete_own on public.known_devices;
create policy known_devices_delete_own
  on public.known_devices
  for delete
  using (user_id = auth.uid());
