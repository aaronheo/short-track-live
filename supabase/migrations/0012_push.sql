-- Server push (APNs). Each phone registers its device token with what it wants
-- to hear about: its favorite skaters and notification switches, and the
-- account it's signed in to (for "Picks are open"). Only our server reads these.
create table push_device (
  token text primary key,                 -- APNs device token, hex
  environment text not null check (environment in ('sandbox', 'production')),
  favorites jsonb not null default '[]',  -- [{ id, addedAt }]: no alerts for races before a skater was a favorite
  notify_starts boolean not null default true,
  notify_results boolean not null default true,
  notify_picks boolean not null default true,
  account_id bigint references account on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on push_device (account_id);

-- Alerts already sent ("start-123", "result-123", "picks-123"), so each goes once.
create table push_sent (
  token text not null references push_device on delete cascade,
  alert_id text not null,
  sent_at timestamptz not null default now(),
  primary key (token, alert_id)
);

alter table push_device enable row level security;
alter table push_sent enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on push_device, push_sent from anon, authenticated;
  end if;
end $$;
