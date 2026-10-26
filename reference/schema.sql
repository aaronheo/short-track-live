-- Short track results store, modeled on ISU's front-api.isu.org.
--
--   season ─< event ─< competition ─< round ─< heat ─< entry ─< lap
--               └─< schedule_item >─ round
--
-- ISU name                                  -> table here
--   /common/get-season                      -> season
--   /events/list                            -> event
--   /events/getschedule/{slug}              -> schedule_item
--   event_result                            -> competition   ("Men 500 m")
--   event_result_round                      -> round         ("Quarterfinals")
--   event_result_round_heats                -> heat          ("Heat 3", "Final A")
--   event_result_round_heats_competitors    -> entry         (one skater or relay team in one heat)
--   competitor.lap[]                        -> lap
--   competitor.skaters / skaters_team       -> skater / relay_team
--
-- Each mirrored table keeps ISU's numeric id (isu_id) and, where present, its
-- upstream UUID (api_id). Our own ids are the primary keys, so if ISU re-keys
-- its data (2025/26 was re-imported in July 2026) only isu_id needs remapping.
--
-- Every *_at column holds real UTC. ISU mixes conventions (heat times are
-- local wall-clock time with a "Z" suffix), so the ingest normalizes them.

create type event_state as enum ('upcoming', 'live', 'finished');
-- ISU heat status / result_status -> heat_state:
--   Scheduled / ''          scheduled    (skaters not known yet)
--   Scheduled / Start List  start_list
--   Live      / Live        running      (laps fill in while the race is on)
--   Finished  / Live        unofficial
--   Finished  / Official    official
create type heat_state as enum ('scheduled', 'start_list', 'running', 'unofficial', 'official');
create type schedule_source as enum ('isu', 'derived');

create table nation (
  code text primary key,                -- CAN, KOR, NED
  name text not null
);

create table season (
  id smallint generated always as identity primary key,
  isu_id int not null unique,
  title text not null unique,           -- '2025/2026'
  starts_on date not null,
  ends_on date not null
);

create table event (
  id int generated always as identity primary key,
  isu_id int not null unique,
  api_id uuid unique,
  slug text not null unique,
  season_id smallint not null references season,
  name text not null,                   -- 'ISU Short Track World Tour #1'
  series text,                          -- 'ISU World Tour', 'Olympic Games', ...
  city text,
  country_code text references nation,
  time_zone text not null,              -- IANA zone; ISU's value is sometimes wrong
  starts_on date not null,              -- local dates
  ends_on date not null,
  state event_state not null
);
create index on event (season_id, starts_on);

create table competition (               -- one distance at one event
  id int generated always as identity primary key,
  isu_id int not null unique,
  api_id uuid,
  event_id int not null references event on delete cascade,
  name text not null,                   -- 'Men 500 m', 'Mixed Team Relay'
  gender text not null,                 -- 'Men', 'Women', 'Mixed'
  distance_m int,
  is_relay bool not null,
  display_order smallint,
  state event_state not null
);
create index on competition (event_id);

create table round (
  id int generated always as identity primary key,
  isu_id int not null unique,
  competition_id int not null references competition on delete cascade,
  name text not null,                   -- 'Rep. Quarterfinals', 'Finals'
  display_order smallint not null,      -- position in the bracket, not in time
  qualification_rule text,
  starts_at timestamptz,
  state event_state not null
);
create index on round (competition_id);

-- The event's running order: what happens next on the ice. This is the spine
-- of the main screen. ISU's schedule is one item per round when it exists;
-- past events often have none (source = 'derived', rebuilt from round times)
-- or have items without round links (matched on title + round_label).
create table schedule_item (
  id int generated always as identity primary key,
  event_id int not null references event on delete cascade,
  round_id int references round on delete set null,
  starts_at timestamptz not null,
  title text not null,                  -- 'Women 500 m'
  round_label text not null,            -- 'Quarterfinals'
  source schedule_source not null
);
create index on schedule_item (event_id, starts_at);
create index on schedule_item (round_id);

create table heat (
  id int generated always as identity primary key,
  isu_id int not null unique,
  api_id uuid,
  round_id int not null references round on delete cascade,
  name text not null,                   -- 'Heat 3', 'Final B'
  display_order smallint not null,
  run_order smallint,                   -- order actually raced (Final B goes before Final A)
  starts_at timestamptz,                -- planned time; ISU replaces it with the actual start once raced
  state heat_state not null,
  source_updated_at timestamptz         -- ISU's updated_at, for change detection
);
create index on heat (round_id, run_order);

create table skater (
  id int generated always as identity primary key,
  isu_id int not null unique,
  api_id uuid unique,
  slug text unique,
  first_name text,
  last_name text not null,
  gender char(1),                       -- 'M' / 'F'
  nation text references nation,
  photo_path text                       -- relative to ISU's CDN container
);

create table relay_team (
  id int generated always as identity primary key,
  isu_id int not null unique,
  api_id uuid,
  slug text,
  name text not null,
  nation text references nation,
  gender text
);

create table entry (                     -- one skater or relay team in one heat
  id bigint generated always as identity primary key,
  isu_id int not null unique,
  heat_id int not null references heat on delete cascade,
  skater_id int references skater,
  team_id int references relay_team,
  nation text references nation,        -- started_for_nf_code
  bib smallint,
  start_position smallint,
  rank smallint,                        -- null until results are in
  time_ms int,                          -- null for 'no time' / 'PEN'
  time_text text,                       -- as ISU shows it: '1:24.537', 'PEN'
  status text,                          -- ISU result_status: 'Penalty', ...
  qualification text,                   -- Q, q (on time), ADV (advanced by referee), QA/QB (to Final A/B); also seen: p, qA
  record text,                          -- 'WR', 'OR', ...
  check ((skater_id is null) <> (team_id is null))
);
create index on entry (heat_id);
create index on entry (skater_id);
create index on entry (team_id);

create table relay_member (              -- ISU often leaves this empty
  entry_id bigint references entry on delete cascade,
  skater_id int references skater,
  primary key (entry_id, skater_id)
);

create table lap (
  entry_id bigint references entry on delete cascade,
  lap_no smallint,
  lap_ms int,                           -- this lap's split
  elapsed_ms int,                       -- race time at the end of this lap
  position smallint,                    -- place in the race at the end of this lap
  gap_ms int,                           -- behind the leader at the end of this lap
  primary key (entry_id, lap_no)
);

-- Raw API responses, stored only when the body changes. Lets you re-parse
-- (for example after fixing time zone handling) without re-fetching from ISU,
-- and records how a heat's result changed (unofficial -> penalty -> official).
create table api_snapshot (
  id bigint generated always as identity primary key,
  fetched_at timestamptz not null default now(),
  endpoint text not null,
  params jsonb not null,
  body_hash text not null,
  body jsonb not null,
  unique (endpoint, params, body_hash)
);
