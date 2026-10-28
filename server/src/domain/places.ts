import { ADVANCED_CODES, AUTO_CODES, TIME_CODES } from './codes.js';
import type { HeatState } from './normalize.js';
import { describeRule, ordinalWord, type QualRule } from './rules.js';

export interface PlaceEntry {
  rank: number | null;
  last: string;
  nat: string | null;
  iso2: string | null;
  timeMs: number | null;
  time: string | null;
  code: string | null;
}

export interface PlaceHeat {
  name: string;
  state: HeatState;
  entries: PlaceEntry[];
}

export interface PlaceSkater { last: string; nat: string | null; iso2: string | null }

export interface TimeRow {
  kind: 'advanced' | 'in' | 'out' | 'open';
  pos: string;
  last?: string;
  nat?: string | null;
  iso2?: string | null;
  heat?: string;
  time?: string | null;
  badge?: string | null;
}

export interface PlacesCard {
  title: string; // "Semifinal places"
  rule: string | null; // "Top 2 in each heat, plus the 5 fastest third places"
  qualified: { count: number; total: number | null; skaters: PlaceSkater[] };
  time: null | { label: string; filled: number; total: number; note: string; rows: TimeRow[] };
}

const FINISHED: HeatState[] = ['unofficial', 'official'];

function placeTitle(destination: string | null): string {
  if (!destination) return 'Qualified';
  if (/^final/i.test(destination)) return `${destination} places`;
  const single = destination.replace(/s$/, '').replace(/^Rep\.? /, 'Rep. ');
  return `${single} places`; // "Semifinal places", "Rep. Quarterfinal places"
}

/**
 * The running qualification card at the top of a round.
 * Automatic places are top N in every heat. Time spots go to the fastest
 * Xth places, minus one per skater advanced by the referee (ISU did this in
 * 11 of the 12 rounds we checked). Once ISU publishes q codes, they decide.
 */
export function placesCard(rule: QualRule | null, heats: PlaceHeat[], totalHeats: number): PlacesCard | null {
  const done = heats.filter((h) => FINISHED.includes(h.state));
  // A round that's over with no results from ISU has no places to show.
  if (heats.length && done.length === heats.length && done.every((h) => h.entries.every((e) => e.rank == null))) return null;
  const skaters = done.flatMap((h) => h.entries.filter((e) => e.code && AUTO_CODES.has(e.code)));
  if (!rule && skaters.length === 0) return null;

  const card: PlacesCard = {
    title: placeTitle(rule?.destination ?? null),
    rule: rule ? describeRule(rule) : null,
    qualified: {
      count: skaters.length,
      total: rule ? rule.autoPlaces * totalHeats : null,
      skaters: skaters.map(({ last, nat, iso2 }) => ({ last, nat, iso2 })),
    },
    time: null,
  };
  if (!rule?.timeSpots || !rule.timePlace) return card;

  const withHeat = (pick: (e: PlaceEntry) => boolean) =>
    done.flatMap((h) => h.entries.filter(pick).map((e) => ({ ...e, heat: h.name })));
  const advanced = withHeat((e) => !!e.code && ADVANCED_CODES.has(e.code));
  const candidates = withHeat((e) => e.rank === rule.timePlace && !(e.code && ADVANCED_CODES.has(e.code)))
    .sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));

  const officialCodes = candidates.some((e) => e.code && TIME_CODES.has(e.code));
  const timeSpots = Math.max(0, rule.timeSpots - advanced.length);
  const taken = (e: PlaceEntry, i: number) => (officialCodes ? !!e.code && TIME_CODES.has(e.code) : i < timeSpots);

  const rows: TimeRow[] = advanced.map((e) => ({
    kind: 'advanced', pos: '–', last: e.last, nat: e.nat, iso2: e.iso2, heat: e.heat, time: e.time, badge: e.code,
  }));
  let takenCount = 0;
  let lastTaken: string | null = null;
  candidates.forEach((e, i) => {
    const isIn = taken(e, i);
    if (isIn) { takenCount++; lastTaken = e.time; }
    rows.push({
      kind: isIn ? 'in' : 'out', pos: String(i + 1), last: e.last, nat: e.nat, iso2: e.iso2,
      heat: e.heat, time: e.time, badge: isIn ? (e.code ?? 'p') : null,
    });
  });
  const open = officialCodes ? 0 : Math.max(0, timeSpots - candidates.length);
  for (let i = 0; i < open; i++) rows.push({ kind: 'open', pos: String(candidates.length + i + 1) });

  const allDone = done.length === totalHeats;
  const note = open > 0
    ? `${open} ${open === 1 ? 'spot' : 'spots'} open`
    : allDone ? 'Round finished'
      : timeSpots > 0 && lastTaken ? `Time to beat ${lastTaken}` : 'Taken by advanced skaters';

  card.time = {
    label: `Fastest ${ordinalWord(rule.timePlace)} places`,
    filled: Math.min(rule.timeSpots, advanced.length + takenCount),
    total: rule.timeSpots,
    note,
    rows,
  };
  return card;
}
