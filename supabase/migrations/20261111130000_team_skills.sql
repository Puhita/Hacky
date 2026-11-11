-- Agent skills the team has chosen to share: a folder with a SKILL.md inside a GitHub repo, pinned
-- to one commit. Teammates install the exact files from that commit. Nothing here holds the skill's
-- content, only where it comes from.
create table public.team_skills (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  repo text not null check (repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  path text not null default '' check (length(path) <= 300),
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  added_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

alter table public.team_skills enable row level security;
revoke all on public.team_skills from anon, authenticated;
grant select, insert, delete on public.team_skills to authenticated;
-- Moving a skill to a newer commit is the only change allowed.
grant update (sha) on public.team_skills to authenticated;

create policy team_skills_select on public.team_skills for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy team_skills_insert on public.team_skills for insert to authenticated
  with check ((select public.is_team_member(team_id)) and added_by = (select auth.uid()));
create policy team_skills_update on public.team_skills for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));
create policy team_skills_delete on public.team_skills for delete to authenticated
  using ((select public.is_team_member(team_id)));
