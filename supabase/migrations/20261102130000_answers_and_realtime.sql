-- One transaction for saving an answer: the decision and the question update succeed
-- together. SECURITY INVOKER keeps RLS in force, and the status filter means that when
-- two people answer at once, only the first one wins.
create function public.answer_question(target_question uuid, answer text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_team uuid;
  new_decision uuid;
begin
  select team_id into target_team from public.questions
    where id = target_question and status = 'open'
    for update;
  if target_team is null then
    raise exception 'this question is no longer open';
  end if;
  insert into public.decisions (team_id, text, decided_by)
    values (target_team, answer, auth.uid())
    returning id into new_decision;
  update public.questions
    set status = 'answered', decision_id = new_decision
    where id = target_question;
  return new_decision;
end;
$$;

revoke all on function public.answer_question(uuid, text) from public, anon;
grant execute on function public.answer_question(uuid, text) to authenticated;

-- Live updates for the sidebar. Realtime applies each subscriber's RLS policies.
alter publication supabase_realtime add table
  public.events, public.questions, public.question_waiters, public.decisions, public.tasks;
