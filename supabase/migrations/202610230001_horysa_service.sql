create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table private.admins enable row level security;
grant usage on schema private to authenticated;

create or replace function private.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists(select 1 from private.admins where user_id = (select auth.uid()));
$$;
revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

create or replace function public.is_horysa_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$ select private.is_admin(); $$;
revoke all on function public.is_horysa_admin() from public, anon;
grant execute on function public.is_horysa_admin() to authenticated;

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"favorites":[],"agenda":[],"routes":[]}'::jsonb
    check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 250000),
  updated_at timestamptz not null default now()
);
alter table public.user_data enable row level security;
revoke all on public.user_data from anon, authenticated;
grant select, insert, update, delete on public.user_data to authenticated;
drop policy if exists "users manage their own data" on public.user_data;
create policy "users manage their own data" on public.user_data
  for all to authenticated
  using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  with check ((select auth.uid()) is not null and user_id = (select auth.uid()));

create or replace function public.touch_user_data()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists touch_user_data_updated_at on public.user_data;
create trigger touch_user_data_updated_at before update on public.user_data
for each row execute function public.touch_user_data();

create table if not exists public.catalog_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('place','event')),
  city text not null default 'Cotonou',
  title text not null check (length(trim(title)) between 2 and 120),
  description text not null check (length(trim(description)) between 2 and 1800),
  category text,
  area text,
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  source_url text check (source_url is null or source_url ~* '^https://'),
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'published' check (status in ('pending','published','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists catalog_entries_public_idx
  on public.catalog_entries (city, kind, starts_at) where status = 'published';
alter table public.catalog_entries enable row level security;
revoke all on public.catalog_entries from anon, authenticated;
grant select on public.catalog_entries to anon, authenticated;
grant insert, update, delete on public.catalog_entries to authenticated;
drop policy if exists "published catalog is public" on public.catalog_entries;
create policy "published catalog is public" on public.catalog_entries
  for select to anon, authenticated using (status = 'published');
drop policy if exists "admins inspect full catalog" on public.catalog_entries;
create policy "admins inspect full catalog" on public.catalog_entries
  for select to authenticated using (private.is_admin());
drop policy if exists "admins manage catalog" on public.catalog_entries;
create policy "admins manage catalog" on public.catalog_entries
  for all to authenticated using (private.is_admin()) with check (private.is_admin());

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('place','event')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 10000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  moderator_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);
create index if not exists submissions_pending_idx on public.submissions(created_at)
  where status = 'pending';
create index if not exists submissions_owner_pending_idx on public.submissions(user_id,created_at)
  where status = 'pending';
alter table public.submissions enable row level security;
revoke all on public.submissions from anon, authenticated;
grant select, insert, delete on public.submissions to authenticated;
drop policy if exists "users submit and read their own suggestions" on public.submissions;
create policy "users submit and read their own suggestions" on public.submissions
  for select to authenticated using (user_id = (select auth.uid()) or private.is_admin());
drop policy if exists "signed in users submit suggestions" on public.submissions;
create policy "signed in users submit suggestions" on public.submissions
  for insert to authenticated with check (user_id = (select auth.uid()) and status = 'pending');
drop policy if exists "users remove their pending suggestions" on public.submissions;
create policy "users remove their pending suggestions" on public.submissions
  for delete to authenticated using (user_id = (select auth.uid()) and status = 'pending');

create or replace function private.limit_horysa_submissions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is distinct from (select auth.uid()) then
    raise exception 'submission owner must match the signed in user' using errcode = '42501';
  end if;
  if (select count(*) from public.submissions
      where user_id = new.user_id and status = 'pending'
        and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'daily pending suggestion limit reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.limit_horysa_submissions() from public, anon, authenticated;
drop trigger if exists limit_horysa_submissions on public.submissions;
create trigger limit_horysa_submissions before insert on public.submissions
for each row execute function private.limit_horysa_submissions();

create or replace function public.review_horysa_submission(
  submission_id uuid, approve boolean, note text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare item public.submissions%rowtype;
begin
  if not private.is_admin() then raise exception 'admin access required' using errcode = '42501'; end if;
  select * into item from public.submissions where id = submission_id for update;
  if not found or item.status <> 'pending' then raise exception 'submission is not pending'; end if;
  if approve then
    insert into public.catalog_entries(kind,city,title,description,category,area,latitude,longitude,source_url,starts_at,ends_at,status)
    values (
      item.kind,
      coalesce(nullif(trim(item.payload->>'city'),''),'Cotonou'),
      trim(item.payload->>'title'),
      trim(item.payload->>'description'),
      nullif(item.payload->>'category',''),
      nullif(item.payload->>'area',''),
      nullif(item.payload->>'latitude','')::double precision,
      nullif(item.payload->>'longitude','')::double precision,
      nullif(item.payload->>'source_url',''),
      nullif(item.payload->>'starts_at','')::timestamptz,
      nullif(item.payload->>'ends_at','')::timestamptz,
      'published'
    );
  end if;
  update public.submissions set status = case when approve then 'approved' else 'rejected' end,
    moderator_note = left(note,500), reviewed_at = now(), reviewed_by = (select auth.uid())
  where id = item.id;
end;
$$;
revoke all on function public.review_horysa_submission(uuid,boolean,text) from public, anon;
grant execute on function public.review_horysa_submission(uuid,boolean,text) to authenticated;

create or replace function public.delete_my_horysa_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'authentication required' using errcode = '42501'; end if;
  delete from auth.users where id = (select auth.uid());
end;
$$;
revoke all on function public.delete_my_horysa_account() from public, anon;
grant execute on function public.delete_my_horysa_account() to authenticated;
