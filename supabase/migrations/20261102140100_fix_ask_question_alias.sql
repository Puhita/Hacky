-- "found" is a PL/pgSQL variable, so it can't be used as a subquery alias here.
create or replace function public.ask_question(
  target_team uuid,
  question_text text,
  question_context text,
  question_embedding extensions.vector,
  target_routed_to uuid,
  candidate_threshold double precision,
  confirmed_new boolean
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
  insert into public.question_waiters (team_id, question_id, user_id)
    values (target_team, new_question, auth.uid());
  return jsonb_build_object('status', 'pending', 'question_id', new_question);
end;
$$;
