-- LOA (Letter of Assignment) document upload at self-registration --
-- employees now self-report institution/position/department/contract
-- period at sign-up (see LoginPage.jsx's register form; those columns
-- already existed on profiles from earlier migrations) plus upload their
-- LOA as supporting proof, which a supervisor can cross-check against the
-- self-reported values via Outsource Directory / Settings > Manage Staff
-- Assignments.
-- Prerequisite: 20260712_add_rls_policies.sql (uses its is_supervisor()).

alter table public.profiles
    add column if not exists loa_file_path text;

comment on column public.profiles.loa_file_path is 'Storage path (loa_documents bucket) of the employee''s uploaded Letter of Assignment, submitted at self-registration.';

-- ============================================================================
-- LOA_DOCUMENTS bucket: private (LOA documents are sensitive personal
-- paperwork, unlike public avatars). Files live at {employee_id}/loa_{ts}.{ext}.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('loa_documents', 'loa_documents', false)
on conflict (id) do nothing;

update storage.buckets
set
    file_size_limit = 10485760, -- 10MB
    allowed_mime_types = array[
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
where id = 'loa_documents';

-- 🟩 storage.objects already has RLS enabled project-wide (from an
-- earlier migration) -- omitting a redundant `alter table ... enable row
-- level security` here deliberately: re-issuing it (even as a no-op)
-- requires table ownership this project's connection role doesn't have
-- ("must be owner of table objects"), which the initial enable apparently
-- didn't require. Only CREATE POLICY statements follow, which don't need
-- table ownership.

drop policy if exists loa_documents_insert_own_folder on storage.objects;
create policy loa_documents_insert_own_folder
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'loa_documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Readable by the uploader themself or any supervisor (to verify against
-- the self-reported institution/position/department/contract period).
drop policy if exists loa_documents_select on storage.objects;
create policy loa_documents_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'loa_documents'
    and (public.is_supervisor() or (storage.foldername(name))[1] = auth.uid()::text)
  );

drop policy if exists loa_documents_update_own_folder on storage.objects;
create policy loa_documents_update_own_folder
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'loa_documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'loa_documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists loa_documents_delete on storage.objects;
create policy loa_documents_delete
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'loa_documents' and (public.is_supervisor() or (storage.foldername(name))[1] = auth.uid()::text));
