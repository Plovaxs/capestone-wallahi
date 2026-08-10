-- ============================================================================
-- 1:1 DIRECT MESSAGING (employee <-> supervisor)
-- ============================================================================
-- A lightweight message thread, distinct from the public Forum
-- (contributions) and the ticket-workflow Helpdesk -- just plain private
-- messages between two people. Scope deliberately kept to "any employee can
-- message any supervisor and vice versa" (enforced at the UI level by who
-- shows up as a contact, not at the DB level) rather than general
-- employee-to-employee chat, to match this app's existing employee/
-- supervisor-centric permission model instead of becoming a full chat
-- product.

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists direct_messages_sender_idx on public.direct_messages (sender_id, created_at);
create index if not exists direct_messages_recipient_idx on public.direct_messages (recipient_id, created_at);

alter table public.direct_messages enable row level security;

drop policy if exists direct_messages_select_participant on public.direct_messages;
create policy direct_messages_select_participant
  on public.direct_messages
  for select
  using (sender_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists direct_messages_insert_as_sender on public.direct_messages;
create policy direct_messages_insert_as_sender
  on public.direct_messages
  for insert
  with check (sender_id = auth.uid() and sender_id <> recipient_id);

-- Recipients may only touch read_at (marking a message read) -- see the
-- immutability trigger below, which blocks changing anything else
-- (including impersonating being the sender by rewriting sender_id).
drop policy if exists direct_messages_update_mark_read on public.direct_messages;
create policy direct_messages_update_mark_read
  on public.direct_messages
  for update
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create or replace function public.protect_direct_message_immutability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.body is distinct from old.body
     or new.sender_id is distinct from old.sender_id
     or new.recipient_id is distinct from old.recipient_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Messages are immutable except for read_at';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_direct_message_immutability on public.direct_messages;
create trigger protect_direct_message_immutability
  before update on public.direct_messages
  for each row execute function public.protect_direct_message_immutability();

-- Realtime replication for this table is enabled via the Supabase
-- dashboard (Database -> Replication), same as every other live-updated
-- table in this app -- see subscribeToTable.js's header comment.
