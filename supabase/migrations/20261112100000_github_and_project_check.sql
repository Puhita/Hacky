-- GitHub link and same-project check.
--
-- team_github: the one GitHub repository a group works in. Only its name is stored (owner/name);
-- tokens never reach the database, they stay on each person's computer. A lead links or unlinks it.
--
-- project_fingerprints: what each person's active folder is, so the app can warn when teammates are
-- in different projects, also for groups that haven't linked GitHub. One row per person per group.
-- It holds the repository's first commit and its remote as owner/name or host/path (never with
-- credentials), and the folder's name. Never the full local path.

create table public.team_github (
  team_id uuid primary key references public.teams (id) on delete cascade,
  repo text not null check (repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$' and repo !~ '(^|/)\.\.?(/|$)'),
  linked_by uuid references auth.users (id) on delete set null,
  linked_at timestamptz not null default now()
);

alter table public.team_github enable row level security;
revoke all on public.team_github from anon, authenticated;
grant select on public.team_github to authenticated;

create policy team_github_select on public.team_github for select to authenticated
  using ((select public.is_team_member(team_id)));

create function public.link_github_repo(target_team uuid, repo_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_lead(target_team);
  insert into public.team_github (team_id, repo, linked_by)
    values (target_team, repo_name, auth.uid())
    on conflict (team_id)
    do update set repo = excluded.repo, linked_by = excluded.linked_by, linked_at = now();
end;
$$;

create function public.unlink_github_repo(target_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_lead(target_team);
  delete from public.team_github where team_id = target_team;
end;
$$;

revoke all on function public.link_github_repo(uuid, text) from public, anon;
revoke all on function public.unlink_github_repo(uuid) from public, anon;
grant execute on function public.link_github_repo(uuid, text) to authenticated;
grant execute on function public.unlink_github_repo(uuid) to authenticated;

create table public.project_fingerprints (
  team_id uuid not null,
  user_id uuid not null,
  folder_name text not null check (length(folder_name) between 1 and 200),
  root_commit text check (root_commit ~ '^[0-9a-f]{40}$'),
  remote text check (length(remote) <= 300),
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (team_id, user_id) references public.members (team_id, user_id) on delete cascade
);

alter table public.project_fingerprints enable row level security;
revoke all on public.project_fingerprints from anon, authenticated;
grant select, insert, delete on public.project_fingerprints to authenticated;
grant update (folder_name, root_commit, remote, updated_at) on public.project_fingerprints to authenticated;

create policy project_fingerprints_select on public.project_fingerprints for select to authenticated
  using ((select public.is_team_member(team_id)));
-- Everyone writes only their own row.
create policy project_fingerprints_insert on public.project_fingerprints for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_team_member(team_id)));
create policy project_fingerprints_update on public.project_fingerprints for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select public.is_team_member(team_id)));
create policy project_fingerprints_delete on public.project_fingerprints for delete to authenticated
  using (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.team_github, public.project_fingerprints;
