-- Sign in with Apple: Apple's stable id for the person, beside Google's.
alter table account add column apple_sub text unique;

-- Live Activities. A phone's push-to-start token lets the server start an
-- activity when a favorite's race is up next; each activity then has its own
-- token, which the server updates lap by lap and ends after the result.
alter table push_device
  add column activity_start_token text,
  add column notify_activities boolean not null default true;

create table live_activity (
  token text primary key,                 -- the activity's push token, hex
  device_token text not null references push_device on delete cascade,
  heat_id int not null references heat on delete cascade,
  last_state text,                        -- the content last sent, to skip unchanged updates
  ended boolean not null default false,
  created_at timestamptz not null default now()
);
create index on live_activity (heat_id);

alter table live_activity enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on live_activity from anon, authenticated;
  end if;
end $$;
