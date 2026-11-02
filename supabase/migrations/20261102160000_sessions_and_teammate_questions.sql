-- Agent sessions and direct questions between agents.
--
-- Until now an agent was identified by its human, so two chats on one account shared a single
-- identity: one chat's check_answers took the answers and notices the other was waiting for.
-- Every MCP server process is now a session. Waits belong to a session, notices are delivered
-- once per session, and a new chat can take over an earlier one with resume_session.
-- Functions are SECURITY INVOKER, so RLS stays in force for everything below.

create table public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null,
  -- What the agent is doing or will do next. Shown to teammates and to the person's next chat.
  focus text,
  -- Notes the agent wrote for whoever continues its work.
  handoff text,
  task_id uuid,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_progress_at timestamptz,
  closed_at timestamptz,
  -- Notices created from this moment on are this session's to receive.
  since timestamptz not null default now(),
  -- The session that took this one over. Its waits and notices are then the taker's.
  resumed_by uuid references public.agent_sessions (id) on delete set null,
  -- Lets waits and questions reference a session together with its owner, so nobody can
  -- attach theirs to a teammate's session.
  unique (team_id, user_id, id),
  foreign key (team_id, user_id) references public.members (team_id, user_id) on delete cascade,
  foreign key (team_id, task_id) references public.tasks (team_id, id) on delete set null (task_id)
);

create index agent_sessions_team_user_idx on public.agent_sessions (team_id, user_id, last_seen_at desc);

alter table public.agent_sessions enable row level security;
revoke all on public.agent_sessions from anon, authenticated;
grant select, insert, update on public.agent_sessions to authenticated;

create policy agent_sessions_select on public.agent_sessions for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy agent_sessions_insert on public.agent_sessions for insert to authenticated
  with check ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));
create policy agent_sessions_update on public.agent_sessions for update to authenticated
  using ((select public.is_team_member(team_id)) and user_id = (select auth.uid()))
  with check ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));

-- Waits belong to a session. Waits that already exist go to a closed session per person,
-- which that person's next chat can take over.
alter table public.question_waiters add column session_id uuid;

insert into public.agent_sessions (team_id, user_id, focus, closed_at)
  select distinct team_id, user_id, 'Waiting on answers from before sessions were tracked', now()
  from public.question_waiters;

update public.question_waiters w set session_id = s.id
  from public.agent_sessions s
  where s.team_id = w.team_id and s.user_id = w.user_id;

alter table public.question_waiters alter column session_id set not null;
alter table public.question_waiters drop constraint question_waiters_pkey;
alter table public.question_waiters add primary key (question_id, user_id, session_id);
alter table public.question_waiters
  add foreign key (team_id, user_id, session_id) references public.agent_sessions (team_id, user_id, id) on delete cascade;

-- Notices stay in place and each session records the ones it has been given.
create table public.notice_deliveries (
  notice_id uuid not null references public.notices (id) on delete cascade,
  session_id uuid not null references public.agent_sessions (id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (notice_id, session_id)
);

alter table public.notice_deliveries enable row level security;
revoke all on public.notice_deliveries from anon, authenticated;
grant select, insert on public.notice_deliveries to authenticated;

create policy notice_deliveries_select on public.notice_deliveries for select to authenticated
  using (exists (
    select 1 from public.agent_sessions s where s.id = session_id and s.user_id = (select auth.uid())
  ));
create policy notice_deliveries_insert on public.notice_deliveries for insert to authenticated
  with check (exists (
    select 1 from public.agent_sessions s where s.id = session_id and s.user_id = (select auth.uid())
  ));

-- A question from one agent to a teammate's agents. Any of the teammate's sessions can answer
-- it, and so can the teammate in the sidebar. It is not a team decision, so it never reaches
-- search_decisions or anyone else's agent.
create table public.peer_questions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  from_user uuid not null,
  from_session uuid not null,
  to_user uuid not null check (to_user <> from_user),
  task_id uuid,
  question text not null,
  context text,
  status text not null default 'open' check (status in ('open', 'answered')),
  answer text,
  -- Null when the person answered in the sidebar.
  answered_by_session uuid references public.agent_sessions (id) on delete set null,
  answered_at timestamptz,
  -- When the asking agent received the answer.
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (team_id, from_user) references public.members (team_id, user_id) on delete cascade,
  foreign key (team_id, to_user) references public.members (team_id, user_id) on delete cascade,
  foreign key (team_id, from_user, from_session) references public.agent_sessions (team_id, user_id, id) on delete cascade,
  foreign key (team_id, task_id) references public.tasks (team_id, id) on delete set null (task_id)
);

create index peer_questions_to_idx on public.peer_questions (team_id, to_user, status);
create index peer_questions_from_idx on public.peer_questions (team_id, from_user, status);

alter table public.peer_questions enable row level security;
revoke all on public.peer_questions from anon, authenticated;
grant select, insert on public.peer_questions to authenticated;
grant update (status, answer, answered_by_session, answered_at, delivered_at) on public.peer_questions to authenticated;

create policy peer_questions_select on public.peer_questions for select to authenticated
  using ((select public.is_team_member(team_id)) and (select auth.uid()) in (from_user, to_user));
create policy peer_questions_insert on public.peer_questions for insert to authenticated
  with check ((select public.is_team_member(team_id)) and from_user = (select auth.uid()));
create policy peer_questions_update on public.peer_questions for update to authenticated
  using ((select public.is_team_member(team_id)) and (select auth.uid()) in (from_user, to_user))
  with check ((select public.is_team_member(team_id)) and (select auth.uid()) in (from_user, to_user));

-- Returns where this session's notices start: when the person's most recent chat was last
-- seen, so a chat that starts after another ended still gets what it missed.
create function public.start_session(target_team uuid, new_session uuid)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  started timestamptz;
begin
  insert into public.agent_sessions (id, team_id, user_id, since)
    values (
      new_session,
      target_team,
      auth.uid(),
      coalesce(
        (select max(s.last_seen_at) from public.agent_sessions s where s.team_id = target_team and s.user_id = auth.uid()),
        now()
      )
    )
    on conflict (id) do nothing;
  select since into started from public.agent_sessions where id = new_session;
  return started;
end;
$$;

-- Hands an earlier chat's work to this one: its waits, its notices and its notes. Refuses
-- a chat that looks alive unless takeover is true, because two chats would then do the same work.
create function public.resume_session(
  old_session uuid,
  new_session uuid,
  takeover boolean,
  active_within_seconds integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  previous public.agent_sessions;
  adopted_since timestamptz;
begin
  select * into previous from public.agent_sessions
    where id = old_session and user_id = auth.uid()
    for update;
  if previous.id is null then
    raise exception 'no such session of yours';
  end if;
  if previous.id = new_session then
    raise exception 'that is this chat';
  end if;
  if previous.resumed_by is not null then
    raise exception 'another chat already took over that session';
  end if;
  if not takeover
     and previous.closed_at is null
     and previous.last_seen_at > now() - make_interval(secs => active_within_seconds) then
    return jsonb_build_object('status', 'still_active', 'last_seen_at', previous.last_seen_at, 'focus', previous.focus);
  end if;
  if not exists (
    select 1 from public.agent_sessions
    where id = new_session and user_id = auth.uid() and team_id = previous.team_id
  ) then
    raise exception 'this chat is not registered in that team';
  end if;

  -- Anything the old chat had itself taken over now belongs to the new one.
  update public.agent_sessions
    set resumed_by = new_session, closed_at = coalesce(closed_at, now())
    where id = old_session or resumed_by = old_session;
  update public.agent_sessions
    set since = least(since, previous.since),
        task_id = coalesce(task_id, previous.task_id),
        focus = coalesce(focus, previous.focus)
    where id = new_session
    returning since into adopted_since;

  return jsonb_build_object(
    'status', 'resumed',
    'focus', previous.focus,
    'handoff', previous.handoff,
    'task_id', previous.task_id,
    'last_seen_at', previous.last_seen_at,
    'since', adopted_since
  );
end;
$$;

-- The first session of the teammate to answer wins, and so does the teammate in the sidebar.
create function public.answer_peer_question(target_question uuid, answer_text text, answering_session uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.peer_questions
    set status = 'answered', answer = answer_text, answered_by_session = answering_session, answered_at = now()
    where id = target_question and to_user = auth.uid() and status = 'open';
  if not found then
    raise exception 'this question is no longer open';
  end if;
end;
$$;

-- ask_question now records which session is waiting. The old signature is dropped so an
-- outdated MCP server fails loudly instead of waiting as nobody.
drop function public.ask_question(uuid, text, text, extensions.vector, uuid, double precision, boolean);

create function public.ask_question(
  target_team uuid,
  question_text text,
  question_context text,
  question_embedding extensions.vector,
  target_routed_to uuid,
  candidate_threshold double precision,
  confirmed_new boolean,
  asking_session uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidates jsonb;
  new_question uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_team::text, 0));

  if not confirmed_new and question_embedding is not null then
    select jsonb_agg(row_to_json(similar_question)) into candidates
    from (
      select
        q.id as question_id,
        q.text as question,
        q.status,
        d.text as answer,
        round((1 - (q.embedding operator(extensions.<=>) question_embedding))::numeric, 3) as similarity
      from public.questions q
      left join public.decisions d on d.id = q.decision_id
      where q.team_id = target_team
        and q.embedding is not null
        and (q.status = 'open' or d.status = 'active')
        and 1 - (q.embedding operator(extensions.<=>) question_embedding) >= candidate_threshold
      order by q.embedding operator(extensions.<=>) question_embedding
      limit 3
    ) similar_question;
    if candidates is not null then
      return jsonb_build_object('status', 'possible_duplicates', 'candidates', candidates);
    end if;
  end if;

  insert into public.questions (team_id, text, context, asked_by, routed_to, embedding)
    values (target_team, question_text, question_context, auth.uid(), target_routed_to, question_embedding)
    returning id into new_question;
  insert into public.question_waiters (team_id, question_id, user_id, session_id)
    values (target_team, new_question, auth.uid(), asking_session);
  return jsonb_build_object('status', 'pending', 'question_id', new_question);
end;
$$;

revoke all on function public.start_session(uuid, uuid) from public, anon;
revoke all on function public.resume_session(uuid, uuid, boolean, integer) from public, anon;
revoke all on function public.answer_peer_question(uuid, text, uuid) from public, anon;
revoke all on function public.ask_question(uuid, text, text, extensions.vector, uuid, double precision, boolean, uuid) from public, anon;
grant execute on function public.start_session(uuid, uuid) to authenticated;
grant execute on function public.resume_session(uuid, uuid, boolean, integer) to authenticated;
grant execute on function public.answer_peer_question(uuid, text, uuid) to authenticated;
grant execute on function public.ask_question(uuid, text, text, extensions.vector, uuid, double precision, boolean, uuid) to authenticated;

-- So the sidebar's pulse and agent chat update live.
alter publication supabase_realtime add table public.agent_sessions, public.peer_questions;
