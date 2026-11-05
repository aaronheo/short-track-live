// What a favorite's Live Activity shows: up next, then racing lap by lap
// (top three plus the favorite), then the result. The app's widget decodes
// these as RaceActivityAttributes and its ContentState, so the keys match.

import { ordinal, raceName, result, type AlertRace } from './alerts.js';
import { lapTotalLabel } from './time.js';

/** "Women 1500 m · Final A", "Men 500 m · Semifinal, Heat 2". */
export function activityRaceTitle(race: AlertRace): string {
  return raceName(race).replace(`${race.competition} `, `${race.competition} · `);
}

export interface ActivityAttributes {
  heatId: number;
  event: string; // "World Tour #2 · Montréal"
  race: string; // "Women 1500 m · Final A"
  favorite: string; // "Velzeboer"
  iso2: string | null;
}

export interface ActivityRow { pos: number; name: string; iso2: string | null; gap: string | null; mine: boolean }

export interface ActivityState {
  phase: 'upNext' | 'racing' | 'unofficial' | 'official';
  lap: number | null;
  laps: string; // "13½"
  progress: number; // 0…1
  headline: string;
  detail: string;
  rows: ActivityRow[];
}

export interface ActivityEntry {
  skater_id: number | null; name: string; last: string; iso2: string | null;
  start_position: number | null; last_position: number | null; last_gap_ms: number | null; lap_count: number;
  rank: number | null; time_text: string | null; status: string | null; qualification: string | null;
}

export type ActivityHeatState = 'scheduled' | 'start_list' | 'running' | 'unofficial' | 'official';

/** The favorite this activity is about: the first of them in the heat, by start position. */
export function activityFavorite(entries: ActivityEntry[], favorites: Set<number>): ActivityEntry | null {
  return [...entries].filter((e) => e.skater_id != null && favorites.has(e.skater_id))
    .sort((a, b) => (a.start_position ?? 99) - (b.start_position ?? 99))[0] ?? null;
}

export function activityState(race: AlertRace, state: ActivityHeatState, entries: ActivityEntry[], favorites: Set<number>,
  totalLaps: number | null): ActivityState | null {
  const me = activityFavorite(entries, favorites);
  if (!me) return null;
  const mine = (e: ActivityEntry) => e.skater_id != null && favorites.has(e.skater_id);
  const laps = lapTotalLabel(totalLaps);
  const base = { laps, lap: null, progress: 0 };

  if (state === 'scheduled' || state === 'start_list') {
    const start = me.start_position ? `start ${me.start_position} of ${entries.length}` : `${entries.length} skaters`;
    return { ...base, phase: 'upNext', headline: `${me.last} is up next`, detail: start, rows: [] };
  }

  if (state === 'running') {
    const lap = Math.max(0, ...entries.map((e) => e.lap_count));
    const placed = entries.filter((e) => e.last_position != null).sort((a, b) => a.last_position! - b.last_position!);
    const rows = placed.filter((e, i) => i < 3 || mine(e)).map((e) => ({
      pos: e.last_position!, name: e.last, iso2: e.iso2, mine: mine(e),
      gap: e.last_position === 1 ? 'Leader' : e.last_gap_ms != null ? `+${(e.last_gap_ms / 1000).toFixed(2)}` : null,
    }));
    return {
      phase: 'racing', laps, lap: lap || null, progress: totalLaps ? Math.min(1, lap / totalLaps) : 0,
      headline: me.last_position ? `${me.last} ${ordinal(me.last_position)}` : `${me.last} is racing`,
      detail: race.competition, rows,
    };
  }

  const text = result(race, [{
    name: me.name, last: me.last, rank: me.rank, time: me.status ? null : me.time_text, status: me.status, qualification: me.qualification,
  }]);
  const ranked = entries.filter((e) => e.rank != null).sort((a, b) => a.rank! - b.rank!);
  const rows = ranked.filter((e, i) => i < 3 || mine(e)).map((e) => ({
    pos: e.rank!, name: e.last, iso2: e.iso2, mine: mine(e), gap: e.status ?? e.time_text,
  }));
  return { phase: state, laps, lap: null, progress: 1, headline: text.title, detail: text.body, rows };
}
