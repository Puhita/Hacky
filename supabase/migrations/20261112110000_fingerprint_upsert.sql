-- The app saves a person's folder with an upsert, which also sets the key columns (team_id,
-- user_id), so the column-level update grant from 20261112100000 refused it. Row level security
-- still limits every write to the person's own row in a team they belong to.
grant update on public.project_fingerprints to authenticated;
