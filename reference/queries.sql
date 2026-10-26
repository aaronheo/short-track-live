-- Queries behind the core screens. Run with psql, e.g.:
--   psql -v slug=isu-short-track-world-tour-1 -v round_id=1 -f queries.sql

-- 1. Event screen: the schedule in running order, with progress per round.
select si.starts_at at time zone e.time_zone as local_time,
       si.title,
       si.round_label,
       r.state,
       count(h.id) as heats,
       count(h.id) filter (where h.state in ('unofficial', 'official')) as heats_done,
       coalesce(bool_or(h.state = 'running'), false) as racing_now,
       si.round_id
from event e
join schedule_item si on si.event_id = e.id
left join round r on r.id = si.round_id
left join heat h on h.round_id = r.id
where e.slug = :'slug'
group by si.id, e.time_zone, r.state
order by si.starts_at, si.id;

-- 2. Round screen: every heat in the order it was raced, skaters in finishing
--    order (start position until results are in).
select h.run_order,
       h.name as heat,
       h.state,
       en.rank,
       coalesce(s.first_name || ' ' || s.last_name, t.name) as skater,
       en.nation,
       en.start_position as start,
       en.time_text as time,
       en.status,
       en.qualification as q,
       (select count(*) from lap where lap.entry_id = en.id) as laps
from heat h
join entry en on en.heat_id = h.id
left join skater s on s.id = en.skater_id
left join relay_team t on t.id = en.team_id
where h.round_id = :round_id
order by h.run_order, en.rank nulls last, en.start_position;

-- 3. "On now" banner: the first round on the schedule that isn't finished.
select si.title, si.round_label, r.state, si.round_id
from event e
join schedule_item si on si.event_id = e.id
join round r on r.id = si.round_id
where e.slug = :'slug' and r.state <> 'finished'
order by si.starts_at
limit 1;
