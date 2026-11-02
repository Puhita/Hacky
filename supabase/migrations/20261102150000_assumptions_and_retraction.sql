-- Assumptions and retraction. Agents hear about a rejected assumption or a changed decision
-- through notices, one row per person, removed once delivered by check_answers.
-- The functions are SECURITY INVOKER, so RLS stays in force for everything below.

create table public.notices (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null,
  kind text not null check (kind in ('assumption_rejected', 'decision_changed', 'decision_withdrawn')),
  -- The rejected assumption or the old decision.
  about text not null,
  -- The rejection reason or the new decision. Empty when a decision is withdrawn.
  text text,
  question_id uuid,
  created_at timestamptz not null default now(),
  foreign key (team_id, user_id) references public.members (team_id, user_id) on delete cascade,
  foreign key (team_id, question_id) references public.questions (team_id, id) on delete set null (question_id)
);

create index notices_team_user_idx on public.notices (team_id, user_id);

alter table public.notices enable row level security;

revoke all on public.notices from anon, authenticated;
grant select, insert, delete on public.notices to authenticated;

create policy notices_select on public.notices for select to authenticated
  using ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));
create policy notices_insert on public.notices for insert to authenticated
  with check ((select public.is_team_member(team_id)));
create policy notices_delete on public.notices for delete to authenticated
  using ((select public.is_team_member(team_id)) and user_id = (select auth.uid()));

-- Confirming an assumption answers its question, so every waiting agent gets it as the answer.
create function public.confirm_assumption(target_assumption uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.assumptions;
  new_decision uuid;
begin
  select * into target from public.assumptions
    where id = target_assumption and status = 'pending'
    for update;
  if target.id is null then
    raise exception 'this assumption is no longer pending';
  end if;
  if target.question_id is null then
    raise exception 'this assumption has no question to answer';
  end if;
  new_decision := public.answer_question(target.question_id, target.text);
  update public.assumptions set status = 'confirmed' where id = target_assumption;
  return new_decision;
end;
$$;

-- Tells the agent that declared it and every other agent on the same question.
-- The question stays open, since it still has no answer.
create function public.reject_assumption(target_assumption uuid, reason text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.assumptions;
begin
  select * into target from public.assumptions
    where id = target_assumption and status = 'pending'
    for update;
  if target.id is null then
    raise exception 'this assumption is no longer pending';
  end if;
  update public.assumptions set status = 'rejected' where id = target_assumption;
  insert into public.notices (team_id, user_id, kind, about, text, question_id)
    select target.team_id, involved.user_id, 'assumption_rejected', target.text, reason, target.question_id
    from (
      select target.user_id as user_id
      union
      select a.user_id from public.assumptions a where a.question_id = target.question_id and a.status = 'pending'
      union
      select w.user_id from public.question_waiters w where w.question_id = target.question_id
    ) involved;
end;
$$;

-- Replaces a decision, or withdraws it when new_text is null, which reopens its question.
-- Everyone on the team is told: get_context and search_decisions show decisions to every agent,
-- so there's no record of who relied on this one. Returns the new decision, if there is one.
create function public.change_decision(target_decision uuid, new_text text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.decisions;
  affected_question uuid;
  replacement uuid;
begin
  select * into target from public.decisions
    where id = target_decision and status = 'active'
    for update;
  if target.id is null then
    raise exception 'this decision is no longer active';
  end if;
  select q.id into affected_question from public.questions q where q.decision_id = target_decision limit 1;

  update public.decisions set status = 'superseded' where id = target_decision;
  if new_text is null then
    update public.questions set status = 'open', decision_id = null where decision_id = target_decision;
  else
    insert into public.decisions (team_id, text, decided_by)
      values (target.team_id, new_text, auth.uid())
      returning id into replacement;
    update public.questions set decision_id = replacement where decision_id = target_decision;
  end if;

  insert into public.notices (team_id, user_id, kind, about, text, question_id)
    select
      target.team_id,
      m.user_id,
      case when new_text is null then 'decision_withdrawn' else 'decision_changed' end,
      target.text,
      new_text,
      affected_question
    from public.members m
    where m.team_id = target.team_id;
  return replacement;
end;
$$;

revoke all on function public.confirm_assumption(uuid) from public, anon;
revoke all on function public.reject_assumption(uuid, text) from public, anon;
revoke all on function public.change_decision(uuid, text) from public, anon;
grant execute on function public.confirm_assumption(uuid) to authenticated;
grant execute on function public.reject_assumption(uuid, text) to authenticated;
grant execute on function public.change_decision(uuid, text) to authenticated;

-- So the assumptions panel updates live.
alter publication supabase_realtime add table public.assumptions;
