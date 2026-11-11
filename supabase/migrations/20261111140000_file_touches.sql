-- Which files each person's agents have edited, reported by a Claude Code hook. One row per
-- team, person and path, with a count and the last time, so the table stays small. This is only
-- what was reported: Hacky never sees anyone's real folder.

create table public.file_touches (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null,
  path text not null check (length(path) > 0 and length(path) <= 500),
  touches integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (team_id, user_id, path),
  foreign key (team_id, user_id) references public.members (team_id, user_id) on delete cascade
);

create index file_touches_recent_idx on public.file_touches (team_id, last_at desc);

alter table public.file_touches enable row level security;
revoke all on public.file_touches from anon, authenticated;
grant select on public.file_touches to authenticated;

create policy file_touches_select on public.file_touches for select to authenticated
  using ((select public.is_team_member(team_id)));

-- The only way to write: as yourself, through this function. It runs with its own rights because
-- clients have no insert or update on the table, so it checks membership itself and always uses
-- the caller's own id. It also forgets this team's touches older than 30 days (the app shows 7).
create function public.record_file_touch(target_team uuid, touched_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.members where team_id = target_team and user_id = auth.uid()
  ) then
    raise exception 'not a member of this team';
  end if;
  insert into public.file_touches (team_id, user_id, path)
    values (target_team, auth.uid(), left(touched_path, 500))
    on conflict (team_id, user_id, path)
    do update set touches = public.file_touches.touches + 1, last_at = now();
  delete from public.file_touches where team_id = target_team and last_at < now() - interval '30 days';
end;
$$;

revoke all on function public.record_file_touch(uuid, text) from public, anon;
grant execute on function public.record_file_touch(uuid, text) to authenticated;

alter publication supabase_realtime add table public.file_touches;
