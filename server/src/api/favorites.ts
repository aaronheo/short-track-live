// Favorite skaters: their races around now (for notifications) and who to
// suggest adding. Favorites live on the phone; the app sends their ids.

import type { Db } from '../db/pool.js';
import { medalNote, result, upNext, type AlertRace, type AlertSkater, type AlertText } from '../domain/alerts.js';
import { shortEventName } from '../domain/format.js';
import type { HeatRow } from './repo.js';

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
  skaters: { id: number; name: string; last: string; nat: string | null; iso2: string | null; gender: 'Men' | 'Women' | null; note: string }[];
}

interface Row {
  heat_id: number; round_id: number; heat: string; state: HeatRow['state']; starts_at: Date | null;
  round: string; destination: string | null; competition: string; distance_m: number | null;
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
   * Individual races of these skaters from a day and a half ago to four days
   * ahead. Relays aren't included yet.
   */
  async races(skaterIds: number[], now: Date): Promise<FavoritesResponse> {
    if (!skaterIds.length) return { races: [] };
    const rows = (await this.db.query<Row>(
      `select h.id as heat_id, h.round_id, h.name as heat, h.state, h.starts_at,
         r.name as round, r.destination, c.name as competition, c.distance_m,
         e.slug, e.name as event_name, e.city,
         s.id as skater_id, s.first_name, s.last_name,
         en.rank, en.time_text, en.status, en.qualification
       from entry en
       join skater s on s.id = en.skater_id
       join heat h on h.id = en.heat_id
       join round r on r.id = h.round_id
       join competition c on c.id = r.competition_id
       join event e on e.id = c.event_id
       where en.skater_id = any($1::int[]) and not c.is_relay
         and h.starts_at between $2::timestamptz - interval '36 hours' and $2::timestamptz + interval '4 days'
       order by h.starts_at, h.id, en.rank nulls last, s.last_name`, [skaterIds, now])).rows;

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
          competition: h.competition, distanceM: h.distance_m, round: h.round, heat: h.heat,
          destination: h.destination, event: [shortEventName(h.event_name), h.city].filter(Boolean).join(', '),
        };
        const skaters: AlertSkater[] = heatRows.map((r) => ({
          name: r.first_name ? `${r.first_name} ${r.last_name}` : r.last_name, last: r.last_name,
          rank: r.rank, time: r.status ? null : r.time_text, status: r.status, qualification: r.qualification,
        }));
        const soon = h.starts_at != null && h.starts_at.getTime() - now.getTime() <= UP_NEXT_WINDOW_MIN * 60_000;
        return {
          heatId: h.heat_id, roundId: h.round_id, event: h.slug,
          startsAt: h.starts_at?.toISOString() ?? null, state: h.state,
          upNext: next.has(h.heat_id) && soon,
          skaters: heatRows.map((r) => r.skater_id),
          start: upNext(race, skaters),
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
      rank: number; distance_m: number; event_name: string;
    }>(
      `with latest as (
         select e.id, e.name from event e
         where exists (select 1 from competition c join round r on r.competition_id = c.id join heat h on h.round_id = r.id
                       join entry en on en.heat_id = h.id
                       where c.event_id = e.id and h.state = 'official' and ${FINAL})
         order by e.ends_on desc, e.id desc limit 1)
       select s.id, s.first_name, s.last_name, s.gender, s.nation, n.iso2, en.rank, c.distance_m, l.name as event_name
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
            nat: s.nation, iso2: s.iso2, gender: GENDER[s.gender ?? ''] ?? null,
            note: medalNote(rs.map((r) => ({ place: r.rank, distanceM: r.distance_m }))),
          };
        }),
    };
  }
}
