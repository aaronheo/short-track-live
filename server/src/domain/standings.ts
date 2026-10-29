// ISU's World Tour standings: which published list is which, and the points
// a place at one World Tour stop is worth.

import type { IsuStandingList } from '../isu/types.js';

/** overall: the Crystal Globe (500, 1000 and 1500 m together). nations: the team classification. */
export type StandingKind = 'overall' | 'distance' | 'nations';
/** '500' | '1000' | '1500' | 'relay' (men 5000 m, women 3000 m) | 'mixed' (mixed team relay). */
export type StandingDistance = '500' | '1000' | '1500' | 'relay' | 'mixed';

export interface StandingInfo {
  kind: StandingKind;
  gender: 'Men' | 'Women' | 'Mixed';
  distance: StandingDistance | null;
}

/**
 * The World Tour classifications (ISU types WCO, WCT, WCD); null for the
 * World Ranking lists (WR*), which we leave out.
 */
export function classifyStanding(list: Pick<IsuStandingList, 'type' | 'gender' | 'discipline_name'>): StandingInfo | null {
  const gender = /^women/i.test(list.gender) ? 'Women' : /^men/i.test(list.gender) ? 'Men' : 'Mixed';
  if (list.type === 'WCO') return gender === 'Mixed' ? null : { kind: 'overall', gender, distance: null };
  if (list.type === 'WCT') return { kind: 'nations', gender: 'Mixed', distance: null };
  if (list.type !== 'WCD') return null;
  const name = list.discipline_name.toLowerCase();
  if (name.includes('mixed')) return { kind: 'distance', gender: 'Mixed', distance: 'mixed' };
  if (name.includes('relay')) return { kind: 'distance', gender, distance: 'relay' };
  const m = name.match(/\b(500|1000|1500)\b/);
  return m ? { kind: 'distance', gender, distance: m[1] as StandingDistance } : null;
}

/**
 * Points for a place in one distance at one World Tour stop, 1st first. Read
 * from ISU's 2026/27 standings (100, 80, 70 … 4 for 21st); the last three are
 * our guess at how it continues.
 */
export const WORLD_TOUR_POINTS = [100, 80, 70, 60, 50, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1];

/** "ISU Short Track World Tour 2026/27 - Vancouver (CAN)" → "Vancouver". */
export function standingEventCity(name: string): string | null {
  return name.match(/-\s*([^-()]+?)\s*\([A-Z]{3}\)\s*$/)?.[1] ?? null;
}

/** ISU writes surnames in capitals: "SANTOS-GRISWOLD" → "Santos-Griswold", "VAN 'T WOUT" → "Van 't Wout". */
export function titleCaseName(name: string): string {
  return name.toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}
