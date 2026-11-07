drop policy if exists "Public catalog read" on public.games;
drop policy if exists "Authenticated catalog read" on public.games;
create policy "Authenticated catalog read"
on public.games for select to authenticated
using (true);

drop policy if exists "Public game details read" on public.game_details;
drop policy if exists "Authenticated game details read" on public.game_details;
create policy "Authenticated game details read"
on public.game_details for select to authenticated
using (true);

revoke all privileges
on public.games, public.game_details
from anon;

revoke insert, update, delete, truncate, references, trigger
on public.games, public.game_details
from authenticated;

grant select on public.games, public.game_details to authenticated;
