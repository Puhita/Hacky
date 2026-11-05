-- Group management with roles. A group is a team. Roles: 'lead' (manages the group) and 'member'.
-- Everything here goes through functions that check the caller's role, because clients have no
-- write access to teams or members.

-- Removing someone must not erase what they did. Their events, decisions and questions stay, with
-- the author cleared (the apps show "A teammate"), so these three links stop blocking the removal.
alter table public.events alter column user_id drop not null;
alter table public.events drop constraint events_team_id_user_id_fkey;
alter table public.events add constraint events_team_id_user_id_fkey
  foreign key (team_id, user_id) references public.members (team_id, user_id) on delete set null (user_id);

alter table public.decisions alter column decided_by drop not null;
alter table public.decisions drop constraint decisions_team_id_decided_by_fkey;
alter table public.decisions add constraint decisions_team_id_decided_by_fkey
  foreign key (team_id, decided_by) references public.members (team_id, user_id) on delete set null (decided_by);

alter table public.questions alter column asked_by drop not null;
alter table public.questions drop constraint questions_team_id_asked_by_fkey;
alter table public.questions add constraint questions_team_id_asked_by_fkey
  foreign key (team_id, asked_by) references public.members (team_id, user_id) on delete set null (asked_by);

-- Raises unless the caller leads the team.
create function public.require_lead(target_team uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.members
    where team_id = target_team and user_id = auth.uid() and role = 'lead'
  ) then
    raise exception 'only a group lead can do this';
  end if;
end;
$$;

create function public.rename_team(target_team uuid, new_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_lead(target_team);
  if length(trim(new_name)) = 0 then
    raise exception 'the group needs a name';
  end if;
  update public.teams set name = trim(new_name) where id = target_team;
end;
$$;

create function public.delete_team(target_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_lead(target_team);
  delete from public.teams where id = target_team;
end;
$$;

-- The old code stops working, so people holding it can no longer join.
create function public.regenerate_invite_code(target_team uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_code text;
begin
  perform public.require_lead(target_team);
  update public.teams set invite_code = encode(extensions.gen_random_bytes(12), 'hex')
    where id = target_team returning invite_code into new_code;
  return new_code;
end;
$$;

create function public.set_member_role(target_team uuid, target_user uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_lead(target_team);
  if new_role not in ('lead', 'member') then
    raise exception 'unknown role';
  end if;
  if new_role = 'member' and not exists (
    select 1 from public.members
    where team_id = target_team and role = 'lead' and user_id <> target_user
  ) then
    raise exception 'the group needs at least one lead';
  end if;
  update public.members set role = new_role where team_id = target_team and user_id = target_user;
  if not found then
    raise exception 'not a member of this group';
  end if;
end;
$$;

-- A lead removes someone else. Leaving is leave_team.
create function public.remove_member(target_team uuid, target_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_lead(target_team);
  if target_user = auth.uid() then
    raise exception 'use leave to leave the group yourself';
  end if;
  delete from public.members where team_id = target_team and user_id = target_user;
  if not found then
    raise exception 'not a member of this group';
  end if;
end;
$$;

-- Leaves the group. The last lead can't leave while others remain, because nobody could manage it.
create function public.leave_team(target_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  my_role text;
begin
  select role into my_role from public.members where team_id = target_team and user_id = auth.uid();
  if my_role is null then
    raise exception 'not a member of this group';
  end if;
  if my_role = 'lead'
    and not exists (select 1 from public.members where team_id = target_team and role = 'lead' and user_id <> auth.uid())
    and exists (select 1 from public.members where team_id = target_team and user_id <> auth.uid())
  then
    raise exception 'you are the only lead: make someone else a lead first, or delete the group';
  end if;
  delete from public.members where team_id = target_team and user_id = auth.uid();
  -- Nobody left: the group would be unreachable.
  if not exists (select 1 from public.members where team_id = target_team) then
    delete from public.teams where id = target_team;
  end if;
end;
$$;

-- The person's name, in every group they belong to.
create function public.set_display_name(new_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if length(trim(new_name)) = 0 then
    raise exception 'the name can not be empty';
  end if;
  update public.members set display_name = trim(new_name) where user_id = auth.uid();
end;
$$;

revoke all on function public.require_lead(uuid) from public, anon, authenticated;
revoke all on function public.rename_team(uuid, text) from public, anon;
revoke all on function public.delete_team(uuid) from public, anon;
revoke all on function public.regenerate_invite_code(uuid) from public, anon;
revoke all on function public.set_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.remove_member(uuid, uuid) from public, anon;
revoke all on function public.leave_team(uuid) from public, anon;
revoke all on function public.set_display_name(text) from public, anon;
grant execute on function public.rename_team(uuid, text) to authenticated;
grant execute on function public.delete_team(uuid) to authenticated;
grant execute on function public.regenerate_invite_code(uuid) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.leave_team(uuid) to authenticated;
grant execute on function public.set_display_name(text) to authenticated;
