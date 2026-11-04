-- Bills: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. Running it twice is safe.
--
-- One table holds every person's bills, name and settings as small documents.
-- Row Level Security makes sure each signed-in person can only ever see and change their own rows.

create table if not exists public.docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint docs_id_length   check (char_length(id) between 1 and 64),
  constraint docs_data_object check (jsonb_typeof(data) = 'object'),
  constraint docs_data_size   check (pg_column_size(data) <= 20000)
);

alter table public.docs enable row level security;

drop policy if exists "docs: read own"   on public.docs;
drop policy if exists "docs: insert own" on public.docs;
drop policy if exists "docs: update own" on public.docs;
drop policy if exists "docs: delete own" on public.docs;

create policy "docs: read own"   on public.docs for select to authenticated using      (user_id = (select auth.uid()));
create policy "docs: insert own" on public.docs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "docs: update own" on public.docs for update to authenticated using      (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "docs: delete own" on public.docs for delete to authenticated using      (user_id = (select auth.uid()));

-- People who are not signed in get nothing at all.
revoke all on public.docs from anon;

-- Keep updated_at fresh whenever a row changes.
create or replace function public.docs_touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists docs_touch_updated_at on public.docs;
create trigger docs_touch_updated_at before update on public.docs
  for each row execute function public.docs_touch_updated_at();
