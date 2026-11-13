-- Sprints: a team plans a stretch of work with a name, a goal and dates, puts board tasks in it,
-- starts it and closes it. Closing saves a record of what got done (finished tasks, unfinished
-- tasks and the progress people's agents logged during the sprint), so the team can look back at
-- any past sprint even after its tasks move on. Unfinished tasks go back to the backlog, or into
-- the next sprint when one is picked. Any team member can plan, start and close sprints, the same
-- as for tasks; row level security is about team isolation.

create table public.sprints (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  name text not null check (length(trim(name)) > 0 and length(name) <= 120),
  goal text not null default '' check (length(goal) <= 2000),
  starts_on date,
  ends_on date,
  status text not null default 'planned' check (status in ('planned', 'active', 'closed')),
  created_by uuid,
  started_at timestamptz,
  closed_at timestamptz,
  -- Filled in by close_sprint: { done: [...], unfinished: [...], progress: [...] }.
  summary jsonb,
  created_at timestamptz not null default now(),
  check (starts_on is null or ends_on is null or ends_on >= starts_on),
  unique (team_id, id),
  foreign key (team_id, created_by) references public.members (team_id, user_id) on delete set null (created_by)
);

-- One running sprint per team.
create unique index sprints_one_active_idx on public.sprints (team_id) where status = 'active';
create index sprints_team_idx on public.sprints (team_id, created_at desc);

alter table public.tasks add column sprint_id uuid;
alter table public.tasks
  add constraint tasks_sprint_fkey foreign key (team_id, sprint_id) references public.sprints (team_id, id) on delete set null (sprint_id);
create index tasks_sprint_idx on public.tasks (sprint_id) where sprint_id is not null;

alter table public.sprints enable row level security;
revoke all on public.sprints from anon, authenticated;
grant select, insert, update, delete on public.sprints to authenticated;

create policy sprints_select on public.sprints for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy sprints_insert on public.sprints for insert to authenticated
  with check ((select public.is_team_member(team_id)) and created_by = (select auth.uid()) and status = 'planned' and summary is null);
create policy sprints_update on public.sprints for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));
-- Only a sprint that never started can be deleted; past sprints are the team's record.
create policy sprints_delete on public.sprints for delete to authenticated
  using ((select public.is_team_member(team_id)) and status = 'planned');

-- Starts a planned sprint. Fails if the team already has one running.
create function public.start_sprint(target_sprint uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sprint public.sprints;
begin
  select * into sprint from public.sprints where id = target_sprint for update;
  if not found then
    raise exception 'no such sprint';
  end if;
  if sprint.status <> 'planned' then
    raise exception 'only a planned sprint can be started';
  end if;
  if exists (select 1 from public.sprints where team_id = sprint.team_id and status = 'active') then
    raise exception 'finish the running sprint first';
  end if;
  update public.sprints
    set status = 'active', started_at = now(), starts_on = coalesce(starts_on, current_date)
    where id = target_sprint;
end;
$$;

-- Closes the running sprint and saves what was done. Unfinished tasks move to carry_to (a planned
-- sprint of the same team) or back to the backlog when carry_to is null.
create function public.close_sprint(target_sprint uuid, carry_to uuid default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sprint public.sprints;
  record jsonb;
begin
  select * into sprint from public.sprints where id = target_sprint for update;
  if not found then
    raise exception 'no such sprint';
  end if;
  if sprint.status <> 'active' then
    raise exception 'only the running sprint can be closed';
  end if;
  if carry_to is not null and not exists (
    select 1 from public.sprints where id = carry_to and team_id = sprint.team_id and status = 'planned'
  ) then
    raise exception 'unfinished tasks can only move to a planned sprint of this team';
  end if;

  select jsonb_build_object(
    'done', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', left(t.title, 500), 'owner', m.display_name, 'area', t.area) order by t.updated_at)
      from public.tasks t
      left join public.members m on m.team_id = t.team_id and m.user_id = t.owner_id
      where t.sprint_id = target_sprint and t.status = 'done'
    ), '[]'::jsonb),
    'unfinished', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', left(t.title, 500), 'owner', m.display_name, 'area', t.area, 'status', t.status) order by t.created_at)
      from public.tasks t
      left join public.members m on m.team_id = t.team_id and m.user_id = t.owner_id
      where t.sprint_id = target_sprint and t.status <> 'done'
    ), '[]'::jsonb),
    -- Progress logged during the sprint, newest first, capped so the record stays small.
    'progress', coalesce((
      select jsonb_agg(p.item order by p.at desc)
      from (
        select e.created_at as at,
          jsonb_build_object('summary', left(e.summary, 500), 'author', m.display_name, 'at', e.created_at, 'task', left(t.title, 200)) as item
        from public.events e
        left join public.members m on m.team_id = e.team_id and m.user_id = e.user_id
        left join public.tasks t on t.id = e.task_id
        where e.team_id = sprint.team_id
          and e.created_at >= coalesce(sprint.started_at, sprint.created_at)
          and e.created_at <= now()
        order by e.created_at desc
        limit 200
      ) p
    ), '[]'::jsonb)
  ) into record;

  update public.tasks set sprint_id = carry_to, updated_at = now()
    where sprint_id = target_sprint and status <> 'done';
  update public.sprints
    set status = 'closed', closed_at = now(), ends_on = coalesce(ends_on, current_date), summary = record
    where id = target_sprint;
end;
$$;

revoke all on function public.start_sprint(uuid) from public, anon;
revoke all on function public.close_sprint(uuid, uuid) from public, anon;
grant execute on function public.start_sprint(uuid) to authenticated;
grant execute on function public.close_sprint(uuid, uuid) to authenticated;

alter publication supabase_realtime add table public.sprints;
