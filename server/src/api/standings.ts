// The Standings tab: ISU's standings for a season (World Tour, or World Cup
// before 2024/25), with each skater linked to our results and each column to
// its stop.

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
  /** For each `perEvent` column, its index in the season's `events` (World Cup stops sometimes raced a distance twice). */
  eventIndex: number[];
  entries: StandingEntryView[];
}

export interface StandingsResponse {
  season: string | null; // "2026/2027"
  /** Every season with standings, newest first (the season menu). */
  seasons: string[];
  series: 'World Tour' | 'World Cup';
  /** The season's stops in order (lists' `eventIndex` point here); empty when ISU doesn't break the points down. */
  events: { code: string; name: string; city: string | null; slug: string | null; raced: boolean }[];
  /** Points for 1st, 2nd, … in one distance at one stop; null for World Cup seasons, which scored differently. */
  pointsPerPlace: number[] | null;
  lists: StandingListView[];
}

const DAY = 86_400_000;

/** The season's event in `country` closest to `day` (ISU's dates can be weeks off); -1 when it has none there. */
function nearest(tour: { country_code: string | null; starts_on: string; ends_on: string }[], country: string, day: string): number {
  const t = Date.parse(day);
  const gap = (e: (typeof tour)[number]) => Math.max(0, Date.parse(e.starts_on) - t, t - Date.parse(e.ends_on)) / DAY;
  let best = -1;
  tour.forEach((e, i) => {
    if (e.country_code === country && (best < 0 || gap(e) < gap(tour[best]!))) best = i;
  });
  return best;
}

const TITLE: Record<string, string> = { '500': '500 m', '1000': '1000 m', '1500': '1500 m', relay: 'Relay', mixed: 'Mixed relay' };
const ORDER = ['overall', '500', '1000', '1500', 'relay', 'mixed', 'nations'];

interface Row {
  id: number; name: string; kind: StandingKind; gender: 'Men' | 'Women' | 'Mixed'; distance: StandingDistance | null;
  events: { code: string; name: string | null; date: string | null }[]; isu_updated_at: Date | null;
  entries: { rank: number; points: number; skater_id: number | null; name: string; first_name: string | null; last_name: string | null;
    nation: string | null; nation_name: string | null; iso2: string | null; per_event: (number | null)[] }[];
}

export class Standings {
  constructor(private readonly db: Db) {}

  /** `seasonTitle` null: the latest season that has standings. */
  async season(seasonTitle: string | null): Promise<StandingsResponse> {
    const seasons = (await this.db.query<{ id: number; title: string }>(
      `select s.id, s.title from season s
       where exists (select 1 from standing st where st.season_id = s.id)
       order by s.starts_on desc`)).rows;
    const season = seasonTitle ? seasons.find((s) => s.title === seasonTitle) : seasons[0];
    const titles = seasons.map((s) => s.title);
    if (!season) return { season: seasonTitle, seasons: titles, series: 'World Tour', events: [], pointsPerPlace: WORLD_TOUR_POINTS, lists: [] };

    const rows = (await this.db.query<Row>(
      `select st.id, st.name, st.kind, st.gender, st.distance, st.events, st.isu_updated_at,
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

    // Each list's columns point at our World Tour (World Cup) events: the
    // column's country, nearest its date, or by
    // order for the stops still to come (no date yet).
    const tour = (await this.db.query<{ slug: string; name: string; city: string | null; country_code: string | null; starts_on: string; ends_on: string }>(
      `select slug, coalesce(short_name, name) as name, city, country_code, starts_on::text, ends_on::text from event
       where season_id = $1 and series in ('ISU World Tour', 'ISU World Cup') order by starts_on, id`,
      [season.id])).rows;
    type Stop = StandingsResponse['events'][number] & { key: string; sort: string };
    const stops: Stop[] = [];
    // `seen`: this list's columns so far. Two can share a stop (a World Cup
    // stop that raced a distance twice) only on nearby days.
    const stopFor = (c: Row['events'][number], i: number, seen: Map<string, string>): Stop => {
      const day = c.date?.slice(0, 10);
      let at = day ? nearest(tour, c.code.replace(/\d+$/, ''), day) : i < tour.length ? i : -1;
      const before = tour[at] && seen.get(tour[at]!.slug);
      if (day && before && Math.abs(Date.parse(before) - Date.parse(day)) > 4 * DAY) at = -1;
      if (day && tour[at]) seen.set(tour[at]!.slug, day);
      const event = tour[at];
      const country = c.code.replace(/\d+$/, '');
      // A stop we don't have: the same one in every list (by its place in the
      // order until raced, then its country and a date within ten days).
      let stop = event ? stops.find((x) => x.key === event.slug)
        : !day ? stops.find((x) => x.key === `#${i}`)
          : stops.find((x) => x.key.startsWith(`${country}|`) && Math.abs(Date.parse(x.key.slice(country.length + 1)) - Date.parse(day)) <= 10 * DAY);
      const key = event?.slug ?? (day ? `${country}|${day}` : `#${i}`);
      if (!stop) {
        // Older event names have no number: "World Cup" → "World Cup #3".
        const name = event ? shortEventName(event.name) : c.code;
        stop = {
          key, sort: event?.starts_on ?? day ?? `9999 ${String(i).padStart(2, '0')}`,
          code: c.code, name: event && !/#\d/.test(name) ? `${name} #${at + 1}` : name,
          city: event?.city ?? (c.name ? standingEventCity(c.name) : null), slug: event?.slug ?? null, raced: false,
        };
        stops.push(stop);
      }
      if (c.name) stop.raced = true;
      return stop;
    };
    const columns = new Map(rows.map((r) => {
      const seen = new Map<string, string>();
      return [r.id, r.events.map((c, i) => stopFor(c, i, seen))];
    }));
    stops.sort((a, b) => a.sort.localeCompare(b.sort));
    const events = stops.map(({ key: _k, sort: _s, ...e }) => e);
    const series = rows.some((r) => /world tour/i.test(r.name)) ? 'World Tour' : 'World Cup';

    const genderOrder = (g: string) => ['Women', 'Men', 'Mixed'].indexOf(g);
    const key = (r: Row) => ORDER.indexOf(r.kind === 'distance' ? r.distance! : r.kind);
    const lists = rows
      .sort((a, b) => genderOrder(a.gender) - genderOrder(b.gender) || key(a) - key(b))
      .map((r): StandingListView => ({
        id: r.id, kind: r.kind, gender: r.gender, distance: r.distance,
        title: r.kind === 'overall' ? 'Crystal Globe' : r.kind === 'nations' ? 'Nations' : TITLE[r.distance!] ?? r.distance!,
        updatedAt: r.isu_updated_at?.toISOString() ?? null,
        eventIndex: columns.get(r.id)!.map((stop) => stops.indexOf(stop)),
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
    return {
      season: season.title, seasons: titles, series, events,
      pointsPerPlace: series === 'World Tour' ? WORLD_TOUR_POINTS : null, lists,
    };
  }
}
