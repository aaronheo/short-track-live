-- Accounts for people who sign in (Google for now), so their favorite skaters
-- and settings follow them to another iPhone. Only our server reads these:
-- Row Level Security on with no policies, and nothing granted to chat_reader.
create table account (
  id bigint generated always as identity primary key,
  google_sub text unique,               -- Google's stable id for the person
  email text,
  name text,
  settings jsonb not null default '{}', -- { notifyStarts, notifyResults, appearance }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The app keeps a random token; we store only its SHA-256.
create table account_session (
  token_hash bytea primary key,
  account_id bigint not null references account on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index on account_session (account_id);

create table account_favorite (
  account_id bigint not null references account on delete cascade,
  skater_id int not null references skater on delete cascade,
  added_at timestamptz not null,
  primary key (account_id, skater_id)
);

alter table account enable row level security;
alter table account_session enable row level security;
alter table account_favorite enable row level security;

-- Supabase's Data API roles get every new table by default; take that back.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on account, account_session, account_favorite from anon, authenticated;
  end if;
end $$;
