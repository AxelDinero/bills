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

-- ---------------------------------------------------------------------------------------------------------------------
-- "Add from Email" daily limits (used only by the scan-bill Edge Function, which runs as service_role).
-- Counts reads per person per day so no one person, and not everyone together, can run up the Anthropic bill.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.scan_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default ((now() at time zone 'utc')::date),
  n       int  not null default 0,
  primary key (user_id, day)
);
alter table public.scan_usage enable row level security;
revoke all on public.scan_usage from anon, authenticated;

-- Takes one slot for today. Returns false (and counts nothing) when this person or everyone together has hit the daily limit.
create or replace function public.take_scan_slot(p_user uuid, p_user_limit int, p_global_limit int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  d date := (now() at time zone 'utc')::date;
  total int;
  mine int;
begin
  select coalesce(sum(n), 0) into total from public.scan_usage where day = d;
  if total >= p_global_limit then
    return false;
  end if;
  insert into public.scan_usage as u (user_id, day, n) values (p_user, d, 1)
  on conflict (user_id, day) do update set n = u.n + 1 where u.n < p_user_limit
  returning u.n into mine;
  return mine is not null;
end;
$$;
revoke all on function public.take_scan_slot(uuid, int, int) from public, anon, authenticated;
grant execute on function public.take_scan_slot(uuid, int, int) to service_role;
