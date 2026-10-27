// Athlete search and race history: SQL and the JSON the app gets.
// An athlete's races include relays they skated in (relay_member).

import type { Db } from '../db/pool.js';
import { distanceLabel, medal, raceTime, roundLabel, shortEventName } from '../domain/format.js';
import { weekdayMonthDay } from '../domain/time.js';

export interface AthleteHit {
  id: number; name: string; last: string; nat: string | null; iso2: string | null;
  gender: 'Men' | 'Women' | null; races: number;
}

export interface AthleteResponse {
  athlete: { id: number; name: string; first: string | null; last: string; nat: string | null; iso2: string | null; gender: 'Men' | 'Women' | null };
  stats: { races: number; events: number; gold: number; silver: number; bronze: number; since: string | null };
  bests: { distance: string; time: string; event: string; round: string; heatId: number }[];
}

export interface AthleteRace {
  entryId: number; heatId: number; roundId: number; season: string;
  event: { slug: string; name: string; city: string | null; startsOn: string; endsOn: string };
  distance: string; round: string; day: string; startsAt: string;
  rank: number | null; time: string | null; badge: string | null; status: string | null;
  medal: number | null; team: string | null;
}

export interface Facet { value: string; label: string; count: number }
export interface Facets { seasons: Facet[]; events: (Facet & { season: string })[]; distances: Facet[] }

export interface RacesResponse {
  /** Races matching the filters (first page only; null after). */
  total: number | null;
  races: AthleteRace[];
  nextCursor: string | null;
  /** Counts for each filter's options, each with the other filters applied (first page only). */
  facets: Facets | null;
}

export interface RaceFilters {
  season?: string | null; // "2025/2026"
  event?: string | null; // slug
  distance?: string | null; // "500", "1000", "1500", "relay"
}

type Dimension = keyof RaceFilters;

const GENDER: Record<string, 'Men' | 'Women'> = { M: 'Men', F: 'Women' };
const fullName = (first: string | null, last: string) => (first ? `${first} ${last}` : last);

// One row per race the athlete skated, individual or relay.
const MINE = `
  select en.id as entry_id, en.rank, en.time_text, en.time_ms, en.qualification, en.status,
    h.id as heat_id, h.name as heat, coalesce(h.starts_at, e.starts_on::timestamptz) as at,
    r.id as round_id, r.name as round, c.name as competition, c.distance_m, c.is_relay,
    e.slug, e.name as event_name, e.city, e.time_zone,
    to_char(e.starts_on, 'YYYY-MM-DD') as starts_on, to_char(e.ends_on, 'YYYY-MM-DD') as ends_on,
    se.title as season, t.name as team
  from entry en
  join heat h on h.id = en.heat_id
  join round r on r.id = h.round_id
  join competition c on c.id = r.competition_id
  join event e on e.id = c.event_id
  join season se on se.id = e.season_id
  left join relay_team t on t.id = en.team_id
  where en.skater_id = $1 or en.id in (select entry_id from relay_member where skater_id = $1)`;

interface MineRow {
  entry_id: number; rank: number | null; time_text: string | null; time_ms: number | null;
  qualification: string | null; status: string | null; heat_id: number; heat: string; at: Date;
  round_id: number; round: string; competition: string; distance_m: number | null; is_relay: boolean;
  slug: string; event_name: string; city: string | null; time_zone: string; starts_on: string; ends_on: string;
  season: string; team: string | null;
}

/** "where" clauses for the filters, leaving out `skip` (for facet counts). Params start at $2. */
function filterSql(f: RaceFilters, skip?: Dimension): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace('?', `$${params.length + 1}`)); };
  if (f.season && skip !== 'season') add('season = ?', f.season);
  if (f.event && skip !== 'event') add('slug = ?', f.event);
  if (f.distance && skip !== 'distance') {
    if (f.distance === 'relay') clauses.push('is_relay');
    else add('(not is_relay and distance_m = ?::int)', Number(f.distance));
  }
  return { sql: clauses.length ? `where ${clauses.join(' and ')}` : '', params };
}

const encodeCursor = (at: Date, id: number) => Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');

function decodeCursor(cursor: string | null | undefined): [string, number] | null {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, number];
    return typeof at === 'string' && Number.isInteger(id) ? [at, id] : null;
  } catch {
    return null;
  }
}

export class Athletes {
  constructor(private readonly db: Db) {}

  /** Name contains the query, most races first. */
  async search(q: string, limit = 30): Promise<AthleteHit[]> {
    const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const res = await this.db.query<{ id: number; first_name: string | null; last_name: string; gender: string | null; nation: string | null; iso2: string | null; races: number }>(
      `select s.id, s.first_name, s.last_name, s.gender, s.nation, n.iso2,
         ((select count(*) from entry en where en.skater_id = s.id)
           + (select count(*) from relay_member rm where rm.skater_id = s.id))::int as races
       from skater s left join nation n on n.code = s.nation
       where coalesce(s.first_name || ' ', '') || s.last_name ilike $1
          or s.last_name || coalesce(' ' || s.first_name, '') ilike $1
       order by races desc, s.last_name, s.first_name limit $2`, [like, limit]);
    return res.rows.map((r) => ({
      id: r.id, name: fullName(r.first_name, r.last_name), last: r.last_name, nat: r.nation, iso2: r.iso2,
      gender: GENDER[r.gender ?? ''] ?? null, races: r.races,
    }));
  }

  async athlete(id: number): Promise<AthleteResponse | null> {
    const res = await this.db.query<{ id: number; first_name: string | null; last_name: string; gender: string | null; nation: string | null; iso2: string | null }>(
      `select s.id, s.first_name, s.last_name, s.gender, s.nation, n.iso2
       from skater s left join nation n on n.code = s.nation where s.id = $1`, [id]);
    const s = res.rows[0];
    if (!s) return null;
    const stats = await this.db.query<{ races: number; events: number; gold: number; silver: number; bronze: number; since: string | null }>(
      `with mine as (${MINE})
       select count(*)::int as races, count(distinct slug)::int as events,
         count(*) filter (where rank = 1 and (heat = 'Final' or heat ilike 'Final A%'))::int as gold,
         count(*) filter (where rank = 2 and (heat = 'Final' or heat ilike 'Final A%'))::int as silver,
         count(*) filter (where rank = 3 and (heat = 'Final' or heat ilike 'Final A%'))::int as bronze,
         min(starts_on) as since
       from mine`, [id]);
    const bests = await this.db.query<MineRow>(
      `with mine as (${MINE})
       select distinct on (distance_m) * from mine
       where not is_relay and time_ms is not null and distance_m is not null
       order by distance_m, time_ms, at`, [id]);
    return {
      athlete: {
        id: s.id, name: fullName(s.first_name, s.last_name), first: s.first_name, last: s.last_name,
        nat: s.nation, iso2: s.iso2, gender: GENDER[s.gender ?? ''] ?? null,
      },
      stats: stats.rows[0]!,
      bests: bests.rows.map((b) => ({
        distance: distanceLabel(b.competition, b.distance_m, false), time: raceTime(b.time_ms)!,
        event: shortEventName(b.event_name), round: roundLabel(b.round, b.heat), heatId: b.heat_id,
      })),
    };
  }

  /** One page of races, newest (or oldest) first; pass the last page's nextCursor for the next. */
  async races(id: number, f: RaceFilters, opts: { sort?: 'asc' | 'desc'; cursor?: string | null; limit?: number } = {}): Promise<RacesResponse> {
    const asc = opts.sort === 'asc';
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const { sql: where, params } = filterSql(f);
    const after = decodeCursor(opts.cursor);
    const cursorSql = after
      ? `${where ? 'and' : 'where'} (at, entry_id) ${asc ? '>' : '<'} ($${params.length + 2}::timestamptz, $${params.length + 3}::bigint)`
      : '';
    const page = await this.db.query<MineRow>(
      `with mine as (${MINE}) select * from mine ${where} ${cursorSql}
       order by at ${asc ? 'asc' : 'desc'}, entry_id ${asc ? 'asc' : 'desc'} limit ${limit + 1}`,
      [id, ...params, ...(after ?? [])]);
    const rows = page.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    const first = !after;
    return {
      total: first ? await this.count(id, f) : null,
      races: rows.map(raceView),
      nextCursor: page.rows.length > limit && last ? encodeCursor(last.at, last.entry_id) : null,
      facets: first ? await this.facets(id, f) : null,
    };
  }

  private async count(id: number, f: RaceFilters): Promise<number> {
    const { sql, params } = filterSql(f);
    const res = await this.db.query<{ n: number }>(`with mine as (${MINE}) select count(*)::int as n from mine ${sql}`, [id, ...params]);
    return res.rows[0]!.n;
  }

  private async facets(id: number, f: RaceFilters): Promise<Facets> {
    const run = async <T extends object>(skip: Dimension, select: string, groupOrder: string) => {
      const { sql, params } = filterSql(f, skip);
      return (await this.db.query<T>(`with mine as (${MINE}) select ${select}, count(*)::int as count from mine ${sql} ${groupOrder}`, [id, ...params])).rows;
    };
    const seasons = await run<{ season: string; count: number }>('season', 'season', 'group by season order by season desc');
    const events = await run<{ slug: string; event_name: string; city: string | null; season: string; count: number }>(
      'event', 'slug, event_name, city, season', 'group by slug, event_name, city, season order by min(starts_on) desc');
    const distances = await run<{ relay: boolean; distance_m: number | null; count: number }>(
      'distance', 'is_relay as relay, case when is_relay then null else distance_m end as distance_m',
      'group by 1, 2 order by 1, 2');
    return {
      seasons: seasons.map((s) => ({ value: s.season, label: shortSeason(s.season), count: s.count })),
      events: events.map((e) => ({
        value: e.slug, label: [shortEventName(e.event_name), e.city].filter(Boolean).join(' · '), season: e.season, count: e.count,
      })),
      distances: distances.map((d) => d.relay
        ? { value: 'relay', label: 'Relays', count: d.count }
        : { value: String(d.distance_m), label: `${d.distance_m} m`, count: d.count }),
    };
  }
}

/** "2025/2026" → "2025/26" */
export const shortSeason = (title: string) => title.replace(/^(\d{4})\/\d{2}(\d{2})$/, '$1/$2');

function raceView(r: MineRow): AthleteRace {
  return {
    entryId: r.entry_id, heatId: r.heat_id, roundId: r.round_id, season: r.season,
    event: { slug: r.slug, name: shortEventName(r.event_name), city: r.city, startsOn: r.starts_on, endsOn: r.ends_on },
    distance: distanceLabel(r.competition, r.distance_m, r.is_relay),
    round: roundLabel(r.round, r.heat),
    day: weekdayMonthDay(r.at, r.time_zone),
    startsAt: r.at.toISOString(),
    rank: r.rank, time: r.time_text, badge: r.qualification, status: r.status,
    medal: medal(r.heat, r.rank), team: r.is_relay ? r.team : null,
  };
}
