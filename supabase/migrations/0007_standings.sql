-- ISU's World Tour standings as ISU publishes them: the overall classification
-- (Crystal Globe), each distance and relay, and the nations classification.
create table standing (
  id int primary key,                  -- ISU world_standings_list_fsk_id
  season_id smallint not null references season,
  kind text not null,                  -- overall | distance | nations
  gender text not null,                -- Men | Women | Mixed
  distance text,                       -- 500 | 1000 | 1500 | relay | mixed; null for overall and nations
  name text not null,                  -- ISU's title
  events jsonb not null default '[]',  -- World Tour stops in order: [{ code: 'CAN1', name, date }]
  calculated_at timestamptz,
  isu_updated_at timestamptz,          -- ISU's updated_at; unchanged lists aren't fetched again
  synced_at timestamptz not null default now()
);
create index on standing (season_id);

create table standing_entry (
  standing_id int not null references standing on delete cascade,
  position smallint not null,          -- ISU's order (rank_index)
  rank smallint not null,              -- ties share a rank
  points int not null,
  skater_id int references skater,     -- null for teams, or a skater we haven't stored
  nation text,                         -- the skater's, or the team's
  name text not null,                  -- a skater's name, or the team's ("Canada")
  per_event int[] not null,            -- points at each stop, in `events` order; null where none
  primary key (standing_id, position)
);

alter table standing enable row level security;
alter table standing_entry enable row level security;

-- Ask can answer standings questions.
grant select on standing, standing_entry to chat_reader;
create policy chat_reader_read on standing for select to chat_reader using (true);
create policy chat_reader_read on standing_entry for select to chat_reader using (true);
comment on table standing is 'ISU World Tour standings (Crystal Globe overall, by distance, nations) per season; kind/gender/distance say which';
comment on column standing_entry.per_event is 'Points at each World Tour stop, in standing.events order (null = none there)';
