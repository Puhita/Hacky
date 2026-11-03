# Dogfood measurement

Step 6 of the plan: use Hacky at a hackathon and measure whether it cut the minutes the team loses to coordination (copy-pasting context, duplicate work, conflicting assumptions). If that number isn't clearly lower than without Hacky, Hacky has failed.

Hacky records some of this on its own. The rest has to be written down by a person, and this document says which is which.

## Before the hackathon

1. Write down a **baseline** from the last hackathon, from memory: roughly how many minutes per person went on re-explaining context, finding out someone else had already done a thing, and fixing work built on a wrong guess. A rough number is fine. Without it there is nothing to compare against.
2. Note the team size, the hours, and the `team_id` (run the first query below to find it).

## What Hacky records for you

Run the queries with the Supabase SQL editor, or from the repo: `npx supabase db query --linked -f queries.sql`. Replace `<TEAM_ID>` with the team's id. They read data only.

Find the team id:

```sql
select id, name, created_at from public.teams order by created_at;
```

### 1. Overall activity

```sql
select
  (select count(*) from public.events where team_id = '<TEAM_ID>') as progress_updates,
  (select count(*) from public.questions where team_id = '<TEAM_ID>') as questions_asked,
  (select count(*) from public.questions where team_id = '<TEAM_ID>' and status = 'answered') as questions_answered,
  (select count(*) from public.decisions where team_id = '<TEAM_ID>' and status = 'active') as decisions_in_force,
  (select count(*) from public.agent_sessions where team_id = '<TEAM_ID>') as agent_chats,
  (select count(*) from public.tasks where team_id = '<TEAM_ID>' and status = 'done') as tasks_done;
```

### 2. Questions: how long humans took to answer

Time from the question to its decision. A decision that was later replaced shows the replacement's time, so those rows read longer than they were.

```sql
select
  q.text as question,
  q.created_at as asked_at,
  d.created_at as answered_at,
  round((extract(epoch from d.created_at - q.created_at) / 60)::numeric, 1) as minutes_to_answer
from public.questions q
left join public.decisions d on d.id = q.decision_id
where q.team_id = '<TEAM_ID>'
order by q.created_at;
```

```sql
select
  count(*) filter (where d.id is not null) as answered,
  round((percentile_cont(0.5) within group (order by extract(epoch from d.created_at - q.created_at) / 60))::numeric, 1) as median_minutes,
  round((max(extract(epoch from d.created_at - q.created_at) / 60))::numeric, 1) as slowest_minutes
from public.questions q
left join public.decisions d on d.id = q.decision_id
where q.team_id = '<TEAM_ID>';
```

### 3. Wrong guesses caught

An agent's declared assumption that a human rejected, and decisions that were replaced or withdrawn, are work that would have been built on something wrong.

```sql
select status, count(*) as assumptions
from public.assumptions
where team_id = '<TEAM_ID>'
group by status
order by status;
```

```sql
select kind, count(*) as notices
from public.notices
where team_id = '<TEAM_ID>'
group by kind
order by kind;
```

```sql
select count(*) as decisions_replaced_or_withdrawn
from public.decisions
where team_id = '<TEAM_ID>' and status = 'superseded';
```

### 4. Questions between agents

```sql
select
  count(*) as asked,
  count(*) filter (where status = 'answered') as answered,
  count(*) filter (where answered_by_session is null and status = 'answered') as answered_in_sidebar,
  round((percentile_cont(0.5) within group (order by extract(epoch from answered_at - created_at) / 60))::numeric, 1) as median_minutes_to_answer
from public.peer_questions
where team_id = '<TEAM_ID>';
```

### 5. Who did what

```sql
select m.display_name, count(*) as progress_updates, min(e.created_at) as first_update, max(e.created_at) as last_update
from public.events e
join public.members m on m.team_id = e.team_id and m.user_id = e.user_id
where e.team_id = '<TEAM_ID>'
group by m.display_name
order by progress_updates desc;
```

### 6. Tasks

Hacky doesn't record when a task was claimed, so the time below is from creation to the last update.

```sql
select status, count(*) as tasks
from public.tasks
where team_id = '<TEAM_ID>'
group by status
order by status;
```

```sql
select
  title,
  round((extract(epoch from updated_at - created_at) / 60)::numeric, 0) as minutes_from_created_to_done
from public.tasks
where team_id = '<TEAM_ID>' and status = 'done'
order by updated_at;
```

### 7. Chats and handoffs

How many chats each person ran, how long they lasted, and how many were taken over by a later chat.

```sql
select
  m.display_name,
  count(*) as chats,
  count(*) filter (where s.resumed_by is not null) as handed_to_a_later_chat,
  round((avg(extract(epoch from coalesce(s.closed_at, s.last_seen_at) - s.started_at) / 60))::numeric, 0) as average_minutes
from public.agent_sessions s
join public.members m on m.team_id = s.team_id and m.user_id = s.user_id
where s.team_id = '<TEAM_ID>'
group by m.display_name
order by chats desc;
```

## What Hacky can't record

These you write down yourselves, during or just after the hackathon.

- **Duplicate work found.** Hacky warns an agent when a teammate holds the same files, but the warning isn't stored. Note each time someone says "oh, you already did that", and about how many minutes it cost.
- **Questions merged.** When an agent joins a teammate's identical question, the wait rows are deleted as soon as the answer is collected, so this can't be counted afterwards. Note each time an agent says it joined an existing question.
- **Agent waiting time.** Same reason. Use the minutes-to-answer from query 2 as the closest figure, and note any wait that visibly stalled someone.
- **Copy-pasting and re-explaining.** The main thing Hacky is meant to remove. Count the times a person had to paste context into a chat, or explain a decision to a teammate or their agent.

## End-of-hackathon template

Fill this in together within an hour of finishing.

```
Hackathon:            Date:            Team size:         Hours:

Baseline (last time, estimated, minutes lost per person):
  Re-explaining or copy-pasting context:
  Duplicate work found too late:
  Rework from a wrong guess:
  Total per person:

This time (queries 1 to 7 plus notes):
  Questions asked / answered / median minutes to answer:
  Wrong guesses caught (rejected assumptions + replaced decisions):
  Questions between agents:
  Duplicate work found anyway (count, minutes):
  Questions merged (count):
  Re-explaining or copy-pasting (count, minutes per person):
  Total minutes lost per person:

Result: lower / about the same / higher than the baseline, by how much.
What broke or annoyed us (agents ignoring tools, slow answers, bad merges, sidebar problems):
What to change before next time:
```

The success test from the README is a clear drop in the total. If it isn't clearly lower, write down why.
