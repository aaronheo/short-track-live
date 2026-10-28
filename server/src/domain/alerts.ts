// Notification text for favorite skaters: "up next" before a race and the
// result once it's official. Several favorites in one race share one alert.

import { distanceLabel, medal, roundLabel } from './format.js';

export interface AlertRace {
  competition: string; // "Women 1000 m"
  distanceM: number | null;
  round: string; // "Semifinals"
  heat: string; // "Heat 2", "Final", "Final B"
  /** Where Q goes from this round ("Semifinals", "Final A"); null if ISU doesn't say. */
  destination: string | null;
  event: string; // "World Tour #1, Vancouver"
}

export interface AlertSkater {
  name: string; // "Courtney Sarault"
  last: string;
  rank: number | null;
  time: string | null; // "2:28.091", or null for no time
  status: string | null; // PEN | YC | RC | DNF | DNS
  qualification: string | null; // Q | q | QA | QB | qA | qB | ADV ...
}

export interface AlertText { title: string; body: string }

/** "Women 1000 m Semifinal, Heat 2", "Women 1500 m Final", "Men 500 m Heat 4". */
export function raceName(r: AlertRace): string {
  return `${r.competition} ${roundLabel(r.round, r.heat).replace(' · ', ', ')}`;
}

export function upNext(r: AlertRace, skaters: Pick<AlertSkater, 'name' | 'last'>[]): AlertText {
  const who = skaters.length === 1 ? skaters[0]!.name : list(skaters.map((s) => s.last));
  return { title: `${who} ${skaters.length === 1 ? 'is' : 'are'} up next`, body: `${raceName(r)} · ${r.event}` };
}

export function result(r: AlertRace, skaters: AlertSkater[]): AlertText {
  const final = /^final/i.test(r.heat.trim());
  const distance = distanceLabel(r.competition, r.distanceM, false);
  if (skaters.length === 1) {
    const s = skaters[0]!;
    if (s.status && STATUS[s.status]) return { title: `${s.name} ${STATUS[s.status]}`, body: `${raceName(r)} · ${r.event}` };
    if (s.rank == null) return { title: `Results are in for ${s.name}`, body: `${raceName(r)} · ${r.event}` };
    const title = final && s.rank === 1 && medal(r.heat, s.rank) ? `${s.name} won the ${distance} ${r.heat}`
      : final ? `${s.name} ${ordinal(s.rank)} in the ${distance} ${r.heat}`
      : `${s.name} ${ordinal(s.rank)} in ${roundLabel(r.round, r.heat).replace(' · ', ', ')}`;
    const advance = final ? null : advanceText(s.qualification, r.destination);
    return { title, body: [s.time, advance, final ? `${r.competition} · ${r.event}` : r.competition].filter(Boolean).join(' · ') };
  }
  const ordered = [...skaters].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const title = ordered.map((s) => `${s.last} ${s.status ?? (s.rank != null ? ordinal(s.rank) : 'no place')}`).join(', ');
  // "Velzeboer and Kim qualified for the final, Sarault for Final B"
  const groups = new Map<string, string[]>();
  if (!final) {
    for (const s of ordered) {
      const where = destinationOf(s.qualification, r.destination);
      if (where != null) groups.set(where, [...(groups.get(where) ?? []), s.last]);
    }
  }
  const advance = [...groups].map(([where, names], i) => `${list(names)}${i === 0 ? ' qualified' : ''}${where ? ` for ${where}` : ''}`).join(', ');
  return { title, body: [advance || null, raceName(r), final ? r.event : null].filter(Boolean).join(' · ') };
}

const STATUS: Record<string, string> = {
  PEN: 'was penalized', YC: 'got a yellow card', RC: 'got a red card', DNF: 'did not finish', DNS: 'did not start',
};

/** "Qualified for the semifinals", "Qualified for Final B", "Advanced by the referee"; null when not through. */
function advanceText(code: string | null, destination: string | null): string | null {
  if (code && /^ADV/.test(code)) return 'Advanced by the referee';
  const where = destinationOf(code, destination);
  if (where == null) return null;
  return where ? `Qualified for ${where}` : 'Qualified';
}

/** "the semifinals", "Final B", "" (qualified, round unknown) or null (not qualified). */
function destinationOf(code: string | null, destination: string | null): string | null {
  if (!code) return null;
  if (/^ADV/.test(code)) return code.endsWith('B') ? 'Final B' : destination ? named(destination) : '';
  if (/^(Q|q)A$/.test(code)) return 'Final A';
  if (/^(Q|q)B$/.test(code)) return 'Final B';
  if (code === 'Q' || code === 'q') return destination ? named(destination) : '';
  return null;
}

/** "Semifinals" → "the semifinals", "Final A" stays, "Finals" → "the final". */
function named(destination: string): string {
  const d = destination.trim();
  if (/^final [a-z]$/i.test(d)) return d;
  return `the ${d.toLowerCase().replace(/^finals$/, 'final')}`;
}

export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "A", "A and B", "A, B and C" */
export function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Medalists' line in the suggestions: "Gold 500, 1000 and 1500 m", "Gold 1500 m, silver 500 m". */
export function medalNote(medals: { place: number; distanceM: number }[]): string {
  const colors = ['gold', 'silver', 'bronze'];
  return colors.flatMap((color, i) => {
    const ds = medals.filter((m) => m.place === i + 1).map((m) => m.distanceM).sort((a, b) => a - b);
    return ds.length ? [`${color} ${list(ds.map(String))} m`] : [];
  }).join(', ').replace(/^./, (c) => c.toUpperCase());
}
