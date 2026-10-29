// Picks: guess the finishing order of a quarterfinal, semifinal or final, and
// who gets penalized. 3 points for an exact place, 1 for one place off, 3 for
// a penalty called right.

/** Rounds people can pick (not heats, repechages or relays' ranking finals). */
export const PICKABLE_ROUNDS = ['Quarterfinals', 'Semifinals', 'Finals'];

export const POINTS = { exact: 3, oneOff: 1, penalty: 3 } as const;

/** ISU statuses that count as a penalty for picks: a penalty and both cards. */
const PENALTIES = new Set(['PEN', 'YC', 'RC']);

export interface PickInput {
  /** Entry ids, predicted finishing order. */
  finish: number[];
  /** Entry ids predicted to be penalized. */
  penalized: number[];
}

export interface ResultEntry { entryId: number; rank: number | null; status: string | null }

export interface ScoredEntry {
  entryId: number;
  /** 1-based predicted place, or null when predicted penalized. */
  picked: number | null;
  points: number;
}

export interface Score { points: number; max: number; entries: ScoredEntry[] }

export function scorePick(pick: PickInput, results: ResultEntry[]): Score {
  const byId = new Map(results.map((r) => [r.entryId, r]));
  const entries: ScoredEntry[] = [
    ...pick.finish.map((entryId, i) => {
      const rank = byId.get(entryId)?.rank ?? null;
      const off = rank == null ? null : Math.abs(rank - (i + 1));
      return { entryId, picked: i + 1, points: off === 0 ? POINTS.exact : off === 1 ? POINTS.oneOff : 0 };
    }),
    ...pick.penalized.map((entryId) => ({
      entryId, picked: null,
      points: PENALTIES.has(byId.get(entryId)?.status ?? '') ? POINTS.penalty : 0,
    })),
  ];
  return { points: entries.reduce((sum, e) => sum + e.points, 0), max: results.length * POINTS.exact, entries };
}

/** A pick must place or penalize every skater in the heat exactly once. */
export function validPick(pick: PickInput, entryIds: number[]): boolean {
  const all = [...pick.finish, ...pick.penalized];
  return all.length === entryIds.length && new Set(all).size === all.length && all.every((id) => entryIds.includes(id));
}

/** 2–20 letters, digits, spaces and . _ ' -; null when it doesn't fit. */
export function cleanNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 20 && /^[\p{L}\p{N} ._'-]+$/u.test(name) ? name : null;
}

/** Where the line goes in a pick: "To the semifinals" after the qualifying places, "Podium" after 3rd in an A final. */
export function cutLine(round: { name: string; auto_places: number | null; destination: string | null }, heatName: string):
  { after: number; label: string } | null {
  if (round.name === 'Finals') return /^final( a)?$/i.test(heatName.trim()) ? { after: 3, label: 'Podium' } : null;
  if (!round.auto_places) return null;
  const to = round.destination?.trim();
  const label = !to ? 'Through'
    : /^final [ab]$/i.test(to) ? `To ${to}`
      : `To the ${to.toLowerCase().replace(/^finals$/, 'final')}`;
  return { after: round.auto_places, label };
}
