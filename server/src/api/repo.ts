import type { Db } from '../db/pool.js';

// SQL for the app API. Each function returns plain rows; views.ts shapes them.

export interface EventRow {
  id: number; slug: string; name: string; short_name: string | null; series: string | null; city: string | null;
  country_name: string | null; iso2: string | null; time_zone: string;
  starts_on: string; ends_on: string; state: 'upcoming' | 'live' | 'finished';
}

export interface RoundRow {
  id: number; name: string; display_order: number; state: 'upcoming' | 'live' | 'finished';
  starts_at: Date | null; auto_places: number | null; time_spots: number | null; time_place: number | null;
  destination: string | null; qualification_rule: string | null;
  competition_id: number; competition: string; distance_m: number | null; is_relay: boolean;
  event_id: number; event_slug: string; event_name: string; time_zone: string;
}

export interface HeatRow {
  id: number; round_id: number; name: string; run_order: number | null; display_order: number;
  starts_at: Date | null; state: 'scheduled' | 'start_list' | 'running' | 'unofficial' | 'official';
}

export interface EntryRow {
  id: number; heat_id: number; skater_id: number | null; rank: number | null; time_ms: number | null; time_text: string | null;
  status: string | null; qualification: string | null; start_position: number | null; helmet: number | null;
  nation: string | null; iso2: string | null; name: string; last: string;
  lap_count: number; last_lap_no: number | null; last_lap_ms: number | null; last_position: number | null; last_gap_ms: number | null;
}

export interface MemberRow { entry_id: number; id: number; first_name: string | null; last_name: string }

export interface LapRow { entry_id: number; lap_no: number; lap_ms: number | null; elapsed_ms: number | null; position: number | null; gap_ms: number | null }

export interface ScheduleRow {
  id: number; round_id: number | null; starts_at: Date; title: string; round_label: string;
  state: 'upcoming' | 'live' | 'finished' | null; heats: number; done: number; running: number | null;
}

const ENTRY_SELECT = `
  select en.id, en.heat_id, en.skater_id, en.rank, en.time_ms, en.time_text, en.status, en.qualification,
    en.start_position, case when en.skater_id is not null then en.bib end as helmet, en.nation, n.iso2,
    coalesce(s.first_name || ' ' || s.last_name, s.last_name, t.name) as name,
    coalesce(s.last_name, t.name) as last,
    coalesce(ll.lap_count, 0)::int as lap_count, ll.lap_no as last_lap_no, ll.lap_ms as last_lap_ms,
    ll.position as last_position, ll.gap_ms as last_gap_ms
  from entry en
  join heat h on h.id = en.heat_id
  left join skater s on s.id = en.skater_id
  left join relay_team t on t.id = en.team_id
  left join nation n on n.code = en.nation
  left join lateral (
    select l.lap_no, l.lap_ms, l.position, l.gap_ms, (select count(*) from lap c where c.entry_id = en.id) as lap_count
    from lap l where l.entry_id = en.id order by l.lap_no desc limit 1
  ) ll on true`;

export class Repo {
  constructor(private readonly db: Db) {}

  async seasons(): Promise<{ title: string; starts_on: string; ends_on: string }[]> {
    const res = await this.db.query(
      `select title, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on
       from season order by starts_on desc`);
    return res.rows;
  }

  async events(seasonTitle: string): Promise<EventRow[]> {
    const res = await this.db.query<EventRow>(
      `select e.id, e.slug, e.name, e.short_name, e.series, e.city, n.name as country_name, n.iso2, e.time_zone,
         to_char(e.starts_on, 'YYYY-MM-DD') as starts_on, to_char(e.ends_on, 'YYYY-MM-DD') as ends_on, e.state
       from event e join season s on s.id = e.season_id left join nation n on n.code = e.country_code
       where s.title = $1
         -- ISU lists events it has no results for (cancelled ones, mostly in 2020/21).
         and not e.no_results
         and (e.ends_on >= current_date or exists (select 1 from competition c where c.event_id = e.id))
       order by e.starts_on, e.id`, [seasonTitle]);
    return res.rows;
  }

  async event(slug: string): Promise<EventRow | null> {
    const res = await this.db.query<EventRow>(
      `select e.id, e.slug, e.name, e.short_name, e.series, e.city, n.name as country_name, n.iso2, e.time_zone,
         to_char(e.starts_on, 'YYYY-MM-DD') as starts_on, to_char(e.ends_on, 'YYYY-MM-DD') as ends_on, e.state
       from event e left join nation n on n.code = e.country_code where e.slug = $1 and not e.no_results`, [slug]);
    return res.rows[0] ?? null;
  }

  async schedule(eventId: number): Promise<ScheduleRow[]> {
    const res = await this.db.query<ScheduleRow>(
      `select si.id, si.round_id, si.starts_at, si.title, si.round_label, r.state,
         (select count(*) from heat h where h.round_id = si.round_id)::int as heats,
         (select count(*) from heat h where h.round_id = si.round_id and h.state in ('unofficial', 'official'))::int as done,
         (select h.run_order from heat h where h.round_id = si.round_id and h.state = 'running' order by h.run_order limit 1) as running
       from schedule_item si left join round r on r.id = si.round_id
       where si.event_id = $1 order by si.starts_at, si.id`, [eventId]);
    return res.rows;
  }

  async round(id: number): Promise<RoundRow | null> {
    const res = await this.db.query<RoundRow>(
      `select r.id, r.name, r.display_order, r.state, r.starts_at, r.auto_places, r.time_spots, r.time_place,
         r.destination, r.qualification_rule, c.id as competition_id, c.name as competition, c.distance_m, c.is_relay,
         e.id as event_id, e.slug as event_slug, coalesce(e.short_name, e.name) as event_name, e.time_zone
       from round r join competition c on c.id = r.competition_id join event e on e.id = c.event_id
       where r.id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  async siblingRounds(competitionId: number): Promise<{ id: number; name: string; state: string }[]> {
    const res = await this.db.query(
      `select id, name, state from round where competition_id = $1 order by starts_at nulls last, display_order`,
      [competitionId]);
    return res.rows;
  }

  async heats(roundId: number): Promise<HeatRow[]> {
    const res = await this.db.query<HeatRow>(
      `select id, round_id, name, run_order, display_order, starts_at, state from heat
       where round_id = $1 order by run_order nulls last, display_order`, [roundId]);
    return res.rows;
  }

  async heat(id: number): Promise<HeatRow | null> {
    const res = await this.db.query<HeatRow>(
      `select id, round_id, name, run_order, display_order, starts_at, state from heat where id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  async entriesForRound(roundId: number): Promise<EntryRow[]> {
    return (await this.db.query<EntryRow>(`${ENTRY_SELECT} where h.round_id = $1`, [roundId])).rows;
  }

  async entriesForHeat(heatId: number): Promise<EntryRow[]> {
    return (await this.db.query<EntryRow>(`${ENTRY_SELECT} where en.heat_id = $1`, [heatId])).rows;
  }

  /** Who skated for each relay team in the heat. */
  async relayMembersForHeat(heatId: number): Promise<MemberRow[]> {
    const res = await this.db.query<MemberRow>(
      `select rm.entry_id, s.id, s.first_name, s.last_name
       from relay_member rm join entry en on en.id = rm.entry_id join skater s on s.id = rm.skater_id
       where en.heat_id = $1 order by rm.entry_id, s.last_name, s.first_name`, [heatId]);
    return res.rows;
  }

  async lapsForHeat(heatId: number): Promise<LapRow[]> {
    const res = await this.db.query<LapRow>(
      `select l.entry_id, l.lap_no, l.lap_ms, l.elapsed_ms, l.position, l.gap_ms
       from lap l join entry en on en.id = l.entry_id where en.heat_id = $1 order by l.entry_id, l.lap_no`, [heatId]);
    return res.rows;
  }

  async lapsForRound(roundId: number): Promise<LapRow[]> {
    const res = await this.db.query<LapRow>(
      `select l.entry_id, l.lap_no, l.lap_ms, l.elapsed_ms, l.position, l.gap_ms
       from lap l join entry en on en.id = l.entry_id join heat h on h.id = en.heat_id
       where h.round_id = $1 order by l.entry_id, l.lap_no`, [roundId]);
    return res.rows;
  }

  /** The round on the ice at a live event, falling back to its next scheduled round. */
  async onTheIce(eventId: number): Promise<{ round_id: number } | null> {
    const res = await this.db.query<{ round_id: number }>(
      `select r.id as round_id from round r join competition c on c.id = r.competition_id
       left join heat h on h.round_id = r.id and h.state = 'running'
       where c.event_id = $1 and (h.id is not null
         or exists (select 1 from heat next where next.round_id = r.id and next.state in ('scheduled', 'start_list')))
       order by
         case when h.id is not null then 0 when r.state = 'live' then 1 else 2 end,
         r.starts_at asc nulls last
       limit 1`, [eventId]);
    return res.rows[0] ?? null;
  }
}
