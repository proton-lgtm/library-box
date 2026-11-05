create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (btrim(name) <> ''),
  thumbnail_url text not null default '',
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  last_updated timestamptz,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (thumbnail_url = '' or thumbnail_url ~* '^https://')
);

create table if not exists public.game_details (
  game_id uuid primary key references public.games(id) on delete cascade,
  description text not null default '',
  release_date date,
  last_updated timestamptz,
  developer_links jsonb not null default '{}'::jsonb
    check (jsonb_typeof(developer_links) = 'object'),
  version text,
  operating_systems text[] not null default '{}',
  download_links jsonb not null default '{}'::jsonb
    check (jsonb_typeof(download_links) = 'object'),
  mod_links jsonb not null default '[]'::jsonb
    check (jsonb_typeof(mod_links) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists games_set_updated_at on public.games;
create trigger games_set_updated_at
before update on public.games
for each row execute function public.set_updated_at();

drop trigger if exists game_details_set_updated_at on public.game_details;
create trigger game_details_set_updated_at
before update on public.game_details
for each row execute function public.set_updated_at();

alter table public.games enable row level security;
alter table public.game_details enable row level security;

drop policy if exists "Public catalog read" on public.games;
create policy "Public catalog read"
on public.games for select to anon, authenticated
using (true);

drop policy if exists "Public game details read" on public.game_details;
create policy "Public game details read"
on public.game_details for select to anon, authenticated
using (true);

revoke insert, update, delete, truncate, references, trigger
on public.games, public.game_details
from anon, authenticated;

grant select on public.games, public.game_details to anon, authenticated;
