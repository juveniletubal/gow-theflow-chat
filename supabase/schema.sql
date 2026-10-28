-- Gow/theFlow Chat — Supabase database schema
-- Messages expire 12 hours after insertion.
-- Corrected: expires_at is a normal column, not a generated column.

create extension if not exists pg_cron with schema extensions;

-- 1. User profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null default 'Gow/theFlow user',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Create a profile automatically when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Gow/theFlow user'
    )
  )
  on conflict (id) do update
    set email = excluded.email;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 2. Messages
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '',
  media_path text,
  media_type text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours'),
  constraint messages_not_self check (sender_id <> recipient_id),
  constraint messages_have_content check (
    length(trim(body)) > 0 or media_path is not null
  )
);

create index if not exists messages_pair_created_idx
on public.messages (sender_id, recipient_id, created_at desc);

create index if not exists messages_expiry_idx
on public.messages (expires_at);

alter table public.messages enable row level security;

-- Always set message timestamps on the database.
create or replace function public.set_message_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  new.expires_at := new.created_at + interval '12 hours';
  return new;
end;
$$;

drop trigger if exists set_message_expiry_trigger on public.messages;

create trigger set_message_expiry_trigger
before insert on public.messages
for each row execute procedure public.set_message_expiry();

-- 3. Profile access policies
drop policy if exists "Authenticated users can read public profiles"
on public.profiles;

create policy "Authenticated users can read public profiles"
on public.profiles for select to authenticated
using (true);

drop policy if exists "Users can update their own profile"
on public.profiles;

create policy "Users can update their own profile"
on public.profiles for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- 4. Message access policies
drop policy if exists "Chat participants can read messages"
on public.messages;

create policy "Chat participants can read messages"
on public.messages for select to authenticated
using (
  auth.uid() = sender_id
  or auth.uid() = recipient_id
);

drop policy if exists "Users can send messages as themselves"
on public.messages;

create policy "Users can send messages as themselves"
on public.messages for insert to authenticated
with check (
  auth.uid() = sender_id
  and sender_id <> recipient_id
);

-- 5. Private media storage bucket
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'chat-media',
  'chat-media',
  false,
  26214400,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 26214400,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own media"
on storage.objects;

create policy "Users can upload their own media"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'chat-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Chat participants can view media attached to their messages"
on storage.objects;

create policy "Chat participants can view media attached to their messages"
on storage.objects for select to authenticated
using (
  bucket_id = 'chat-media'
  and exists (
    select 1
    from public.messages m
    where m.media_path = name
      and (
        m.sender_id = auth.uid()
        or m.recipient_id = auth.uid()
      )
      and m.expires_at > now()
  )
);

-- IMPORTANT:
-- This schema sets the 12-hour expiry timestamp.
-- Expired messages and media still need a scheduled cleanup task
-- to actually delete them.
-- Enable Realtime for public.messages in the Supabase dashboard.
