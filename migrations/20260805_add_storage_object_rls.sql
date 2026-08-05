-- ============================================================================
-- Migration: Row Level Security on storage.objects for the 'task_submission'
-- and 'avatars' buckets.
--
-- Neither bucket had ANY RLS policy anywhere in this repo's migrations --
-- only file-size/MIME-type limits (see 20260712_add_rls_policies.sql,
-- section 12). Both buckets' upload code already namespaces every file
-- under `${userProfile.id}/...` as the first path segment (TasksView.jsx's
-- task submission upload, SettingsView.jsx's avatar upload), but that's
-- just a CLIENT-SIDE convention -- with no server-side policy enforcing
-- it, any authenticated user could call the Storage API directly and
-- upload to, overwrite, or (task submissions) read another user's files
-- by path, entirely bypassing the app's own UI.
--
-- Safe to re-run (idempotent).
-- ============================================================================

alter table storage.objects enable row level security;


-- ============================================================================
-- TASK_SUBMISSION bucket: private. Files live at
-- `{employee_id}/{task_id}/{timestamp}.{ext}`.
-- ============================================================================

drop policy if exists task_submission_insert_own_folder on storage.objects;
create policy task_submission_insert_own_folder
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'task_submission'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Readable by: a supervisor (any submission), the uploader themself, or
-- anyone else assigned to the same task (teammates can already see each
-- other's submission rows via the task_submissions table's own RLS --
-- this just lets them actually open the file referenced there).
drop policy if exists task_submission_select on storage.objects;
create policy task_submission_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'task_submission'
    and (
      public.is_supervisor()
      or (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.tasks t
        where t.id::text = (storage.foldername(name))[2]
          and auth.uid()::text = any(coalesce(t.assigned_to, '{}'::text[]))
      )
    )
  );

drop policy if exists task_submission_delete on storage.objects;
create policy task_submission_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'task_submission'
    and (public.is_supervisor() or (storage.foldername(name))[1] = auth.uid()::text)
  );


-- ============================================================================
-- AVATARS bucket: public reads (profile photos are already shown broadly
-- across the app via <UserAvatar>, fetched with getPublicUrl -- not
-- signed URLs), writes scoped to the user's own folder.
-- ============================================================================

drop policy if exists avatars_select_all on storage.objects;
create policy avatars_select_all
  on storage.objects
  for select
  using (bucket_id = 'avatars');

drop policy if exists avatars_insert_own_folder on storage.objects;
create policy avatars_insert_own_folder
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- The app uploads with { upsert: true }, which needs UPDATE rights on an
-- existing object at the same path, not just INSERT.
drop policy if exists avatars_update_own_folder on storage.objects;
create policy avatars_update_own_folder
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_delete_own_folder on storage.objects;
create policy avatars_delete_own_folder
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================================
-- End of migration.
-- ============================================================================
