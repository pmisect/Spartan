-- Spartan Tracker: family sync setup
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- Safe to run more than once.
--
-- How access works: the website only ever calls the functions below.
-- The tables themselves are locked (row level security on, no policies, no grants),
-- so nobody can list or browse them. Each family's data is reachable only with its
-- long random sync code, which never leaves the family's devices.

create table if not exists public.trackers (
  code        text primary key check (char_length(code) between 20 and 64),
  data        jsonb not null default '{}'::jsonb,
  rev         bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.tracker_photos (
  code        text not null references public.trackers(code) on delete cascade,
  id          text not null check (char_length(id) <= 64),
  race_id     text not null check (char_length(race_id) <= 64),
  thumb       text not null,
  data        text not null,
  added_at    timestamptz,
  created_at  timestamptz not null default now(),
  primary key (code, id)
);

alter table public.trackers enable row level security;
alter table public.tracker_photos enable row level security;
revoke all on table public.trackers, public.tracker_photos from anon, authenticated, public;

-- Read a family's data
create or replace function public.tracker_get(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('data', t.data, 'rev', t.rev, 'updated_at', t.updated_at)
  from public.trackers t
  where t.code = p_code;
$$;

-- Save a family's data. p_rev is the revision the caller last saw (0 to create).
-- If someone else saved in between, nothing is written and the latest copy is returned
-- so the caller can merge and try again.
create or replace function public.tracker_put(p_code text, p_data jsonb, p_rev bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.trackers%rowtype;
begin
  if p_code is null or char_length(p_code) < 20 or char_length(p_code) > 64 then
    raise exception 'invalid sync code';
  end if;
  if pg_column_size(p_data) > 2000000 then
    raise exception 'data too large';
  end if;

  select * into cur from public.trackers where code = p_code for update;

  if not found then
    if p_rev <> 0 then
      return jsonb_build_object('ok', false, 'missing', true);
    end if;
    insert into public.trackers (code, data) values (p_code, p_data);
    return jsonb_build_object('ok', true, 'rev', 1);
  end if;

  if cur.rev <> p_rev then
    return jsonb_build_object('ok', false, 'rev', cur.rev, 'data', cur.data);
  end if;

  update public.trackers
     set data = p_data, rev = cur.rev + 1, updated_at = now()
   where code = p_code;
  return jsonb_build_object('ok', true, 'rev', cur.rev + 1);
end;
$$;

-- List a family's photos (ids only, no image data)
create or replace function public.photo_list(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'race_id', p.race_id, 'added_at', p.added_at)), '[]'::jsonb)
  from public.tracker_photos p
  where p.code = p_code;
$$;

-- Fetch one photo
create or replace function public.photo_get(p_code text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', p.id, 'race_id', p.race_id, 'thumb', p.thumb, 'data', p.data, 'added_at', p.added_at)
  from public.tracker_photos p
  where p.code = p_code and p.id = p_id;
$$;

-- Upload one photo
create or replace function public.photo_put(
  p_code text, p_id text, p_race_id text, p_thumb text, p_data text, p_added_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.trackers where code = p_code) then
    raise exception 'unknown sync code';
  end if;
  if char_length(p_data) > 6000000 or char_length(p_thumb) > 400000 then
    raise exception 'photo too large';
  end if;
  if p_data !~ '^data:image/' or p_thumb !~ '^data:image/' then
    raise exception 'not an image';
  end if;
  if (select count(*) from public.tracker_photos where code = p_code) >= 3000 then
    raise exception 'photo limit reached';
  end if;
  insert into public.tracker_photos (code, id, race_id, thumb, data, added_at)
  values (p_code, p_id, p_race_id, p_thumb, p_data, p_added_at)
  on conflict (code, id) do nothing;
  return true;
end;
$$;

-- Delete one photo
create or replace function public.photo_delete(p_code text, p_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  delete from public.tracker_photos where code = p_code and id = p_id;
  select true;
$$;

revoke all on function public.tracker_get(text) from public;
revoke all on function public.tracker_put(text, jsonb, bigint) from public;
revoke all on function public.photo_list(text) from public;
revoke all on function public.photo_get(text, text) from public;
revoke all on function public.photo_put(text, text, text, text, text, timestamptz) from public;
revoke all on function public.photo_delete(text, text) from public;

grant execute on function public.tracker_get(text) to anon, authenticated;
grant execute on function public.tracker_put(text, jsonb, bigint) to anon, authenticated;
grant execute on function public.photo_list(text) to anon, authenticated;
grant execute on function public.photo_get(text, text) to anon, authenticated;
grant execute on function public.photo_put(text, text, text, text, text, timestamptz) to anon, authenticated;
grant execute on function public.photo_delete(text, text) to anon, authenticated;

-- Make the API pick up the new functions right away
notify pgrst, 'reload schema';
