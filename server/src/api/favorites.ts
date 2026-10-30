// Favorite skaters: their races around now (for notifications) and who to
// suggest adding. Favorites live on the phone; the app sends their ids.

import type { Db } from '../db/pool.js';
import { medalNote, result, upNext, type AlertRace, type AlertSkater, type AlertText } from '../domain/alerts.js';
import { shortEventName } from '../domain/format.js';
import type { HeatRow } from './repo.js';
import { helmetSql } from './helmet.js';

export interface FavoriteRace {
  heatId: number;
  roundId: number;
  event: string; // slug
  /** Planned start until the heat is raced, then ISU's actual start. */
  startsAt: string | null;
  state: HeatRow['state'];
  /** The next heat on the ice at a live event, due within a few minutes. */
  upNext: boolean;
  /** The favorites in it (ids from the request). */
  skaters: number[];
  start: AlertText;
  /** Once the heat is official. */
  result: AlertText | null;
}

export interface FavoritesResponse { races: FavoriteRace[] }

export interface SuggestedResponse {
  event: string | null; // "World Tour #1"
  skaters: { id: number; name: string; last: string; nat: string | null; iso2: string | null; gender: 'Men' | 'Women' | null; helmet: number | null; note: string }[];
}

interface Row {
  heat_id: number; round_id: number; heat: string; state: HeatRow['state']; starts_at: Date | null;
  round: string; destination: string | null; competition: string; distance_m: number | null; is_relay: boolean;
  entry_id: number; team: string | null;
  /** False for a relay still to come: ISU doesn't name the skaters until it's raced. */
  named: boolean;
  slug: string; event_name: string; city: string | null;
  skater_id: number; first_name: string | null; last_name: string;
  rank: number | null; time_text: string | null; status: string | null; qualification: string | null;
}

/** How long before its planned start a heat can count as up next. */
const UP_NEXT_WINDOW_MIN = 20;
const GENDER: Record<string, 'Men' | 'Women'> = { M: 'Men', F: 'Women' };

export class Favorites {
  constructor(private readonly db: Db) {}

  /**
   * Races of these skaters from a day and a half ago to four days ahead:
   * their own, and their relays. ISU names a relay's skaters only once it's
   * raced, so a relay still to come counts if they skated that relay for
   * that nation in the past year (ISU's team ids change every event).
   */
  async races(skaterIds: number[], now: Date): Promise<FavoritesResponse> {
    if (!skaterIds.length) return { races: [] };
    const rows = (await this.db.query<Row>(
      `with mine as (
         select en.id as entry_id, en.skater_id, true as named from entry en where en.skater_id = any($1::int[])
         union
         select rm.entry_id, rm.skater_id, true from relay_member rm where rm.skater_id = any($1::int[])
         union
         select en.id, rm.skater_id, false
         from entry en
         join heat h on h.id = en.heat_id join round r on r.id = h.round_id join competition c on c.id = r.competition_id
         join entry past on past.nation = en.nation and past.team_id is not null
         join relay_member rm on rm.entry_id = past.id and rm.skater_id = any($1::int[])
         join heat ph on ph.id = past.heat_id join round pr on pr.id = ph.round_id join competition pc on pc.id = pr.competition_id
         where c.is_relay and h.state in ('scheduled', 'start_list')
           and h.starts_at between $2::timestamptz and $2::timestamptz + interval '4 days'
           and not exists (select 1 from relay_member named where named.entry_id = en.id)
           and pc.name = c.name and ph.starts_at between h.starts_at - interval '1 year' and h.starts_at)
       select h.id as heat_id, h.round_id, h.name as heat, h.state, h.starts_at,
         r.name as round, r.destination, c.name as competition, c.distance_m, c.is_relay,
         e.slug, e.name as event_name, e.city,
         en.id as entry_id, t.name as team, m.named, s.id as skater_id, s.first_name, s.last_name,
         en.rank, en.time_text, en.status, en.qualification
       from mine m
       join entry en on en.id = m.entry_id
       join skater s on s.id = m.skater_id
       left join relay_team t on t.id = en.team_id
       join heat h on h.id = en.heat_id
       join round r on r.id = h.round_id
       join competition c on c.id = r.competition_id
       join event e on e.id = c.event_id
       where h.starts_at between $2::timestamptz - interval '36 hours' and $2::timestamptz + interval '4 days'
       order by h.starts_at, h.id, en.rank nulls last, en.id, s.last_name`, [skaterIds, now])).rows;

    // The first heat still to race at each live event.
    const next = new Set((await this.db.query<{ id: number }>(
      `select distinct on (c.event_id) h.id
       from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id
       join event e on e.id = c.event_id
       where e.state = 'live' and h.state in ('scheduled', 'start_list') and h.starts_at is not null
       order by c.event_id, h.starts_at, h.run_order nulls last, h.id`)).rows.map((r) => r.id));

    const byHeat = new Map<number, Row[]>();
    for (const row of rows) byHeat.set(row.heat_id, [...(byHeat.get(row.heat_id) ?? []), row]);
    return {
      races: [...byHeat.values()].map((heatRows) => {
        const h = heatRows[0]!;
        const race: AlertRace = {
          competition: h.competition, distanceM: h.distance_m, relay: h.is_relay, round: h.round, heat: h.heat,
          destination: h.destination, event: [shortEventName(h.event_name), h.city].filter(Boolean).join(', '),
        };
        const full = (r: Row) => (r.first_name ? `${r.first_name} ${r.last_name}` : r.last_name);
        const people = heatRows.map((r) => ({ name: full(r), last: r.last_name }));
        // One line per entry: the skater, or the team with its favorites.
        const byEntry = new Map<number, Row[]>();
        for (const r of heatRows) byEntry.set(r.entry_id, [...(byEntry.get(r.entry_id) ?? []), r]);
        const skaters: AlertSkater[] = [...byEntry.values()].map((rs) => {
          const r = rs[0]!;
          const result = { rank: r.rank, time: r.status ? null : r.time_text, status: r.status, qualification: r.qualification };
          return h.is_relay && r.team
            ? { name: r.team, last: r.team, with: rs.map(full), ...result }
            : { name: full(r), last: r.last_name, ...result };
        });
        const teams = h.is_relay ? [...new Set(heatRows.flatMap((r) => (r.team ? [r.team] : [])))] : [];
        const soon = h.starts_at != null && h.starts_at.getTime() - now.getTime() <= UP_NEXT_WINDOW_MIN * 60_000;
        return {
          heatId: h.heat_id, roundId: h.round_id, event: h.slug,
          startsAt: h.starts_at?.toISOString() ?? null, state: h.state,
          upNext: next.has(h.heat_id) && soon,
          skaters: [...new Set(heatRows.map((r) => r.skater_id))],
          start: upNext(race, people, teams, heatRows.every((r) => r.named)),
          result: h.state === 'official' ? result(race, skaters) : null,
        };
      }),
    };
  }

  /** The individual medalists of the latest event with medals, most medals first. */
  async suggested(): Promise<SuggestedResponse> {
    const FINAL = `not c.is_relay and r.name ilike 'final%' and (h.name ~* '^final( a\\M|$)') and en.rank between 1 and 3`;
    const rows = (await this.db.query<{
      id: number; first_name: string | null; last_name: string; gender: string | null; nation: string | null; iso2: string | null;
      rank: number; distance_m: number; event_name: string; helmet: number | null;
    }>(
      `with latest as (
         select e.id, e.name from event e
         where exists (select 1 from competition c join round r on r.competition_id = c.id join heat h on h.round_id = r.id
                       join entry en on en.heat_id = h.id
                       where c.event_id = e.id and h.state = 'official' and ${FINAL})
         order by e.ends_on desc, e.id desc limit 1)
       select s.id, s.first_name, s.last_name, s.gender, s.nation, n.iso2, en.rank, c.distance_m, l.name as event_name,
         ${helmetSql('s.id')} as helmet
       from latest l
       join competition c on c.event_id = l.id
       join round r on r.competition_id = c.id
       join heat h on h.round_id = r.id
       join entry en on en.heat_id = h.id
       join skater s on s.id = en.skater_id
       left join nation n on n.code = s.nation
       where h.state = 'official' and ${FINAL}`)).rows;
    const bySkater = new Map<number, typeof rows>();
    for (const row of rows) bySkater.set(row.id, [...(bySkater.get(row.id) ?? []), row]);
    const score = (rs: typeof rows) => rs.length * 100 - rs.reduce((sum, r) => sum + r.rank, 0);
    return {
      event: rows[0] ? shortEventName(rows[0].event_name) : null,
      skaters: [...bySkater.values()]
        .sort((a, b) => score(b) - score(a) || Math.min(...a.map((r) => r.rank)) - Math.min(...b.map((r) => r.rank))
          || a[0]!.last_name.localeCompare(b[0]!.last_name))
        .map((rs) => {
          const s = rs[0]!;
          return {
            id: s.id, name: s.first_name ? `${s.first_name} ${s.last_name}` : s.last_name, last: s.last_name,
            nat: s.nation, iso2: s.iso2, gender: GENDER[s.gender ?? ''] ?? null, helmet: s.helmet,
            note: medalNote(rs.map((r) => ({ place: r.rank, distanceM: r.distance_m }))),
          };
        }),
    };
  }
}
