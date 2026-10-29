-- What ISU answered while an event was live, with when, so a weekend can be
-- played back later to test the live features. Only responses that changed
-- since the last one for the same request are kept (most 5 s polls repeat).
create table isu_recording (
  id bigint generated always as identity primary key,
  fetched_at timestamptz not null default now(),
  key text not null,          -- sha1 of method, path and body: the same request has the same key
  method text not null,
  path text not null,
  body text,                  -- the request's JSON or form body
  hash text not null,         -- sha1 of the response JSON
  data bytea not null         -- the response JSON, gzipped
);
create index on isu_recording (key, id desc);
create index on isu_recording (fetched_at);

alter table isu_recording enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on isu_recording from anon, authenticated;
  end if;
end $$;
