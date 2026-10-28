// Parses ISU's qualification_rule sentences. They come in several styles, e.g.
//   "The first and second placed skaters from each race and up to a maximum of
//    five fastest third place skaters qualify for Semifinals."
//   "The 2 best athletes in each Heat (Q) and the 4 fastest 3rd placed athletes
//    (q) qualify for the quarterfinals."
//   "The 1st and 2nd teams in each Semifinal qualify for Final A and the 3rd and
//    4th teams qualify for Final B."

export interface QualRule {
  /** Places per heat that qualify outright. */
  autoPlaces: number;
  /** Extra places decided on time ("up to a maximum of N"); 0 when none. */
  timeSpots: number;
  /** Which finishing place competes for the time spots (3 = third places). */
  timePlace: number | null;
  /** "Semifinals", "Final A", ... */
  destination: string | null;
}

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
};
const ORD = '(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)';
const DESTINATION = /qualify for (?:the )?((?:rep\.? )?(?:final [ab]\b|final\b|semifinals|quarterfinals|heats))/i;

export function parseRule(text: string | null | undefined): QualRule | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  let autoPlaces: number | null = null;
  const best = /^The (\d+) best\b/i.exec(t);
  const listed = new RegExp(`^The (${ORD}(?:(?:, | and )${ORD})*)\\b`, 'i').exec(t);
  if (best) autoPlaces = Number(best[1]);
  else if (listed) autoPlaces = listed[1]!.split(/, | and /i).length;
  if (!autoPlaces) return null;

  let timeSpots = 0;
  let timePlace: number | null = null;
  const fastest = new RegExp(`(?:\\b(\\w+) )?fastest (${ORD}|\\d(?:st|nd|rd|th)) place`, 'i').exec(t);
  if (fastest) {
    const count = fastest[1]?.toLowerCase();
    timeSpots = count && /^\d+$/.test(count) ? Number(count) : NUMBERS[count ?? ''] ?? 1; // "the fastest 3rd placed athlete" = 1
    timePlace = ORDINALS[fastest[2]!.toLowerCase()] ?? null;
  }

  const dest = DESTINATION.exec(t)?.[1] ?? null;
  return { autoPlaces, timeSpots, timePlace, destination: dest ? titleCase(dest) : null };
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const ORDINAL_WORDS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

/** "Top 2 in each heat, plus the 5 fastest third places" */
export function describeRule(rule: QualRule): string {
  const top = rule.autoPlaces === 1 ? 'Winner of each heat' : `Top ${rule.autoPlaces} in each heat`;
  if (!rule.timeSpots || !rule.timePlace) return top;
  const place = ORDINAL_WORDS[rule.timePlace] ?? `${rule.timePlace}th`;
  return rule.timeSpots === 1
    ? `${top}, plus the fastest ${place} place`
    : `${top}, plus the ${rule.timeSpots} fastest ${place} places`;
}

export function ordinalWord(n: number): string {
  return ORDINAL_WORDS[n] ?? `${n}th`;
}
