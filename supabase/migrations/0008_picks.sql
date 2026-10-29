-- Picks: before a quarterfinal, semifinal or final, signed-in people guess the
-- finishing order and who gets penalized. Scored once the result is official
-- (3 for an exact place, 1 for one place off, 3 for a penalty called right).

-- The name people go by on leaderboards (and in chat later). Unique, ignoring case.
alter table account add column nickname text;
create unique index account_nickname_key on account (lower(nickname));

create table pick (
  account_id bigint not null references account on delete cascade,
  heat_id int not null references heat on delete cascade,
  finish bigint[] not null,           -- entry ids in the predicted finishing order
  penalized bigint[] not null,        -- entry ids predicted to be penalized
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, heat_id)
);
create index on pick (heat_id);

alter table pick enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on pick from anon, authenticated;
  end if;
end $$;
