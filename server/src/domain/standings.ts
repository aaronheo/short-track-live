// ISU's standings: which published list is which, and the points a place at
// one World Tour stop is worth. The World Tour began in 2024/25; before that it
// was the World Cup, with other points (and no overall list before 2022/23).

import type { IsuStandingList } from '../isu/types.js';

/** overall: the Crystal Globe (500, 1000 and 1500 m together). nations: the team classification. */
export type StandingKind = 'overall' | 'distance' | 'nations';
/** '500' | '1000' | '1500' | 'relay' (men 5000 m, women 3000 m) | 'mixed' (mixed team relay). */
export type StandingDistance = '500' | '1000' | '1500' | 'relay' | 'mixed';

export type StandingGender = 'Men' | 'Women' | 'Mixed';

export interface StandingInfo {
  kind: StandingKind;
  /** null: an overall list that doesn't say (World Cup years); its skaters do (genderOfSkaters). */
  gender: StandingGender | null;
  distance: StandingDistance | null;
}

const genderIn = (text: string): StandingGender | null =>
  /^women/i.test(text) ? 'Women' : /^men/i.test(text) ? 'Men' : /^mixed/i.test(text) ? 'Mixed' : null;

/**
 * The World Tour / World Cup classifications (ISU types WCO, WCT, WCD); null
 * for the World Ranking lists (WR*) and the Junior World Cup's, which we leave out.
 */
export function classifyStanding(list: Pick<IsuStandingList, 'type' | 'gender' | 'discipline_name' | 'name'>): StandingInfo | null {
  if (/junior/i.test(list.name)) return null;
  const gender = genderIn(list.gender) ?? genderIn(list.discipline_name);
  if (list.type === 'WCO') return gender === 'Mixed' ? null : { kind: 'overall', gender, distance: null };
  if (list.type === 'WCT') return { kind: 'nations', gender: 'Mixed', distance: null };
  if (list.type !== 'WCD' || !gender) return null;
  const name = list.discipline_name.toLowerCase();
  if (name.includes('mixed')) return { kind: 'distance', gender: 'Mixed', distance: 'mixed' };
  if (name.includes('relay')) return { kind: 'distance', gender, distance: 'relay' };
  const m = name.match(/\b(500|1000|1500)\b/);
  return m ? { kind: 'distance', gender, distance: m[1] as StandingDistance } : null;
}

/** An overall list's category from its skaters ('M' / 'F'), when ISU doesn't say. */
export function genderOfSkaters(genders: (string | null | undefined)[]): 'Men' | 'Women' | null {
  const men = genders.filter((g) => g === 'M').length, women = genders.filter((g) => g === 'F').length;
  return men > women ? 'Men' : women > men ? 'Women' : null;
}

/** A stop's points: "100" → 100; "" (nothing there) and "(60)" (a dropped result) → null. */
export function standingPoints(result: string | null | undefined): number | null {
  return result && /^\d+$/.test(result.trim()) ? Number(result) : null;
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
