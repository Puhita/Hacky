-- Hacky schema: the README's data model, with team isolation enforced by RLS.
-- Composite foreign keys on (team_id, ...) stop a row referencing another team's rows.

create extension if not exists vector with schema extensions;

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  invite_code text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  created_at timestamptz not null default now()
);

create table public.members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  role text not null default 'member' check (role in ('lead', 'member')),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index members_user_id_idx on public.members (user_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  title text not null,
  owner_id uuid,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  files text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, id),
  foreign key (team_id, owner_id) references public.members (team_id, user_id) on delete set null (owner_id)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null,
  task_id uuid,
  summary text not null,
  files text[] not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (team_id, user_id) references public.members (team_id, user_id),
  foreign key (team_id, task_id) references public.tasks (team_id, id) on delete set null (task_id)
);

create index events_team_created_idx on public.events (team_id, created_at desc);

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  text text not null,
  decided_by uuid not null,
  status text not null default 'active' check (status in ('active', 'superseded')),
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  unique (team_id, id),
  foreign key (team_id, decided_by) references public.members (team_id, user_id)
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  text text not null,
  context text,
  asked_by uuid not null,
  routed_to uuid,
  status text not null default 'open' check (status in ('open', 'answered')),
  decision_id uuid,
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  unique (team_id, id),
  foreign key (team_id, asked_by) references public.members (team_id, user_id),
  foreign key (team_id, routed_to) references public.members (team_id, user_id) on delete set null (routed_to),
  foreign key (team_id, decision_id) references public.decisions (team_id, id) on delete set null (decision_id)
);

create index questions_team_status_idx on public.questions (team_id, status);

create table public.question_waiters (
  team_id uuid not null references public.teams (id) on delete cascade,
  question_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (question_id, user_id),
  foreign key (team_id, question_id) references public.questions (team_id, id) on delete cascade,
  foreign key (team_id, user_id) references public.members (team_id, user_id) on delete cascade
);

create table public.assumptions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  question_id uuid,
  user_id uuid not null,
  text text not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  foreign key (team_id, question_id) references public.questions (team_id, id) on delete set null (question_id),
  foreign key (team_id, user_id) references public.members (team_id, user_id)
);

-- SECURITY DEFINER so the policy on members can use it without recursing into itself.
create function public.is_team_member(target_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members
    where team_id = target_team and user_id = (select auth.uid())
  );
$$;

-- Teams and memberships are only created through these two functions, so joining
-- always requires a valid invite code.
create function public.create_team(team_name text, member_name text)
returns public.teams
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_team public.teams;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.teams (name) values (team_name) returning * into new_team;
  insert into public.members (team_id, user_id, display_name, role)
    values (new_team.id, auth.uid(), member_name, 'lead');
  return new_team;
end;
$$;

create function public.join_team(code text, member_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_team uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select id into target_team from public.teams where invite_code = code;
  if target_team is null then
    raise exception 'invalid invite code';
  end if;
  insert into public.members (team_id, user_id, display_name)
    values (target_team, auth.uid(), member_name)
    on conflict (team_id, user_id) do nothing;
  return target_team;
end;
$$;

revoke all on function public.is_team_member(uuid) from public, anon;
revoke all on function public.create_team(text, text) from public, anon;
revoke all on function public.join_team(text, text) from public, anon;
grant execute on function public.is_team_member(uuid) to authenticated;
grant execute on function public.create_team(text, text) to authenticated;
grant execute on function public.join_team(text, text) to authenticated;

alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;
alter table public.decisions enable row level security;
alter table public.questions enable row level security;
alter table public.question_waiters enable row level security;
alter table public.assumptions enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.teams, public.members to authenticated;
grant select, insert, update on public.tasks, public.decisions, public.questions, public.assumptions to authenticated;
grant select, insert on public.events to authenticated;
grant select, insert, delete on public.question_waiters to authenticated;

create policy teams_select on public.teams for select to authenticated
  using ((select public.is_team_member(id)));

create policy members_select on public.members for select to authenticated
  using ((select public.is_team_member(team_id)));

create policy tasks_select on public.tasks for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.is_team_member(team_id)));
create policy tasks_update on public.tasks for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));

create policy events_select on public.events for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy events_insert on public.events for insert to authenticated
  with check ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));

create policy decisions_select on public.decisions for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy decisions_insert on public.decisions for insert to authenticated
  with check ((select public.is_team_member(team_id)) and decided_by = (select auth.uid()));
create policy decisions_update on public.decisions for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));

create policy questions_select on public.questions for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy questions_insert on public.questions for insert to authenticated
  with check ((select public.is_team_member(team_id)) and asked_by = (select auth.uid()));
create policy questions_update on public.questions for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));

create policy question_waiters_select on public.question_waiters for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy question_waiters_insert on public.question_waiters for insert to authenticated
  with check ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));
create policy question_waiters_delete on public.question_waiters for delete to authenticated
  using ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));

create policy assumptions_select on public.assumptions for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy assumptions_insert on public.assumptions for insert to authenticated
  with check ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));
create policy assumptions_update on public.assumptions for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));
