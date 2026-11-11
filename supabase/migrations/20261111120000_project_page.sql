-- The project page: one shared overview per team (idea and architecture), and a list of ideas and
-- bugs. People edit the overview from the board; agents can only read it and file bugs and ideas
-- (the MCP server has no tool that writes the overview). The database can't tell an agent from
-- its person, since both use the same login, so row level security here is about team isolation.

create table public.team_overview (
  team_id uuid primary key references public.teams (id) on delete cascade,
  idea text not null default '' check (length(idea) <= 20000),
  architecture text not null default '' check (length(architecture) <= 20000),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (team_id, updated_by) references public.members (team_id, user_id) on delete set null (updated_by)
);

create table public.project_items (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  kind text not null check (kind in ('idea', 'bug')),
  title text not null check (length(trim(title)) > 0 and length(title) <= 200),
  details text not null default '' check (length(details) <= 4000),
  severity text check (severity in ('low', 'medium', 'high')),
  status text not null default 'open' check (status in ('open', 'done', 'dropped')),
  author_id uuid,
  task_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'bug' or severity is null),
  unique (team_id, id),
  foreign key (team_id, author_id) references public.members (team_id, user_id) on delete set null (author_id),
  foreign key (team_id, task_id) references public.tasks (team_id, id) on delete set null (task_id)
);

create index project_items_team_idx on public.project_items (team_id, created_at desc);

alter table public.team_overview enable row level security;
alter table public.project_items enable row level security;

revoke all on public.team_overview, public.project_items from anon, authenticated;
grant select, insert, update on public.team_overview, public.project_items to authenticated;

create policy team_overview_select on public.team_overview for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy team_overview_insert on public.team_overview for insert to authenticated
  with check ((select public.is_team_member(team_id)) and updated_by = (select auth.uid()));
create policy team_overview_update on public.team_overview for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)) and updated_by = (select auth.uid()));

create policy project_items_select on public.project_items for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy project_items_insert on public.project_items for insert to authenticated
  with check ((select public.is_team_member(team_id)) and author_id = (select auth.uid()));
create policy project_items_update on public.project_items for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));

-- Turns an idea or bug into a board task and links them, in one step. Runs with the caller's
-- rights, so row level security still applies to every row it touches.
create function public.item_to_task(target_item uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item public.project_items;
  new_task uuid;
begin
  select * into item from public.project_items where id = target_item for update;
  if not found then
    raise exception 'no such idea or bug';
  end if;
  if item.task_id is not null then
    raise exception 'this item already has a task';
  end if;
  insert into public.tasks (team_id, title)
    values (item.team_id, left(case item.kind when 'bug' then 'Bug: ' else 'Idea: ' end || item.title, 500))
    returning id into new_task;
  update public.project_items set task_id = new_task, updated_at = now() where id = target_item;
  return new_task;
end;
$$;

revoke all on function public.item_to_task(uuid) from public, anon;
grant execute on function public.item_to_task(uuid) to authenticated;

alter publication supabase_realtime add table public.team_overview, public.project_items;
