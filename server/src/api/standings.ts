// The Standings tab: ISU's World Tour standings for a season, with each
// skater linked to our results and each column to its World Tour stop.

import type { Db } from '../db/pool.js';
import { shortEventName } from '../domain/format.js';
import { WORLD_TOUR_POINTS, standingEventCity, type StandingDistance, type StandingKind } from '../domain/standings.js';

export interface StandingEntryView {
  rank: number;
  points: number;
  /** Our skater id; null for teams and for skaters we haven't stored. */
  skaterId: number | null;
  name: string; // "Courtney Sarault", "Canada"
  last: string;
  nat: string | null;
  iso2: string | null;
  /** Points at each World Tour stop, in `events` order; null where none. */
  perEvent: (number | null)[];
}

export interface StandingListView {
  id: number;
  kind: StandingKind;
  gender: 'Men' | 'Women' | 'Mixed';
  distance: StandingDistance | null;
  title: string; // "Crystal Globe", "500 m", "Relay", "Mixed relay", "Nations"
  updatedAt: string | null;
  entries: StandingEntryView[];
}

export interface StandingsResponse {
  season: string | null; // "2026/2027"
  /** The season's World Tour stops in order, matching every `perEvent`. */
  events: { code: string; name: string; city: string | null; slug: string | null; raced: boolean }[];
  /** Points for 1st, 2nd, … in one distance at one stop. */
  pointsPerPlace: number[];
  lists: StandingListView[];
}

const TITLE: Record<string, string> = { '500': '500 m', '1000': '1000 m', '1500': '1500 m', relay: 'Relay', mixed: 'Mixed relay' };
const ORDER = ['overall', '500', '1000', '1500', 'relay', 'mixed', 'nations'];

interface Row {
  id: number; kind: StandingKind; gender: 'Men' | 'Women' | 'Mixed'; distance: StandingDistance | null;
  events: { code: string; name: string | null; date: string | null }[]; isu_updated_at: Date | null;
  entries: { rank: number; points: number; skater_id: number | null; name: string; first_name: string | null; last_name: string | null;
    nation: string | null; nation_name: string | null; iso2: string | null; per_event: (number | null)[] }[];
}

export class Standings {
  constructor(private readonly db: Db) {}

  /** `seasonTitle` null: the latest season that has standings. */
  async season(seasonTitle: string | null): Promise<StandingsResponse> {
    const season = (await this.db.query<{ id: number; title: string }>(
      `select s.id, s.title from season s
       where ($1::text is null or s.title = $1) and exists (select 1 from standing st where st.season_id = s.id)
       order by s.starts_on desc limit 1`, [seasonTitle])).rows[0];
    if (!season) return { season: seasonTitle, events: [], pointsPerPlace: WORLD_TOUR_POINTS, lists: [] };

    const rows = (await this.db.query<Row>(
      `select st.id, st.kind, st.gender, st.distance, st.events, st.isu_updated_at,
         coalesce(json_agg(json_build_object(
           'rank', se.rank, 'points', se.points, 'skater_id', se.skater_id, 'name', se.name,
           'first_name', sk.first_name, 'last_name', sk.last_name, 'nation', se.nation, 'nation_name', n.name, 'iso2', n.iso2,
           'per_event', se.per_event)
           order by se.position) filter (where se.standing_id is not null), '[]') as entries
       from standing st
       left join standing_entry se on se.standing_id = st.id
       left join skater sk on sk.id = se.skater_id
       left join nation n on n.code = se.nation
       where st.season_id = $1
       group by st.id`, [season.id])).rows;

    const tour = (await this.db.query<{ slug: string; name: string; city: string | null }>(
      `select slug, name, city from event where season_id = $1 and series = 'ISU World Tour' order by starts_on, id`,
      [season.id])).rows;
    const columns = rows[0]?.events ?? [];
    const events = columns.map((c, i) => ({
      code: c.code,
      name: tour[i] ? shortEventName(tour[i]!.name) : c.code,
      city: tour[i]?.city ?? (c.name ? standingEventCity(c.name) : null),
      slug: tour[i]?.slug ?? null,
      raced: rows.some((r) => r.events[i]?.name),
    }));

    const genderOrder = (g: string) => ['Women', 'Men', 'Mixed'].indexOf(g);
    const key = (r: Row) => ORDER.indexOf(r.kind === 'distance' ? r.distance! : r.kind);
    const lists = rows
      .sort((a, b) => genderOrder(a.gender) - genderOrder(b.gender) || key(a) - key(b))
      .map((r): StandingListView => ({
        id: r.id, kind: r.kind, gender: r.gender, distance: r.distance,
        title: r.kind === 'overall' ? 'Crystal Globe' : r.kind === 'nations' ? 'Nations' : TITLE[r.distance!] ?? r.distance!,
        updatedAt: r.isu_updated_at?.toISOString() ?? null,
        entries: r.entries.map((e) => {
          // Teams go by our nation name ("Korea", where ISU says "Republic of Korea").
          const team = r.kind === 'nations' || r.distance === 'relay' || r.distance === 'mixed';
          const name = team ? e.nation_name ?? e.name
            : e.last_name ? [e.first_name, e.last_name].filter(Boolean).join(' ') : e.name;
          return {
            rank: e.rank, points: e.points, skaterId: e.skater_id, name,
            last: team ? name : e.last_name ?? (name.split(' ').slice(1).join(' ') || name),
            nat: e.nation, iso2: e.iso2, perEvent: e.per_event,
          };
        }),
      }));
    return { season: season.title, events, pointsPerPlace: WORLD_TOUR_POINTS, lists };
  }
}
