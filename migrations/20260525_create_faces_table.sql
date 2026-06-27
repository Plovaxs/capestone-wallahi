-- Migration: Create `faces` table with pgvector support
-- Run this in Supabase SQL editor (requires pgvector extension enabled)

-- 1. Make sure vector extension is available (Supabase supports pgvector)
create extension if not exists vector;

-- 2. Create faces table
create table if not exists public.faces (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  descriptor jsonb,
  embedding vector(128),
  thumbnail_url text,
  is_primary boolean default false,
  metadata jsonb default '{}'::jsonb,
  enrolled_at timestamptz default now()
);

-- 3. Create ivfflat index for faster nearest neighbor (adjust lists to your data size)
-- NOTE: requires pgvector >= 0.5 and the ivfflat operator class
create index if not exists faces_embedding_idx on public.faces using ivfflat (embedding vector_l2_ops) with (lists = 100);

-- 4. Helper function: convert jsonb array descriptor -> vector
-- This is a convenience SQL function; use with caution on large data.
create or replace function public.jsonb_to_vector128(jsonb) returns vector as $$
  select array_to_vector(array(select jsonb_array_elements_text($1)::float8))::vector
$$ language sql immutable strict;

-- 5. (Optional) Backfill existing profiles.face_descriptor into faces (if present)
-- Uncomment and run if you want to migrate existing descriptors into faces table
-- insert into public.faces (profile_id, descriptor, embedding, is_primary)
-- select id as profile_id, face_descriptor as descriptor,
--        public.jsonb_to_vector128(face_descriptor) as embedding,
--        true
-- from public.profiles
-- where face_descriptor is not null;

-- 6. Grant select/insert on faces to anon (if you want client access)
-- adjust based on your RLS policies and security model
-- grant select, insert, update on public.faces to anon;

-- End of migration
