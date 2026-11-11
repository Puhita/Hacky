-- An optional area label on tasks, so a team with artists, coders, designers and audio people
-- can filter the board and the map. Null means unlabelled.
alter table public.tasks
  add column area text check (area in ('art', 'code', 'design', 'audio'));
