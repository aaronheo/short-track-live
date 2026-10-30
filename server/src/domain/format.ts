/** 8640 → "8.640", 84537 → "1:24.537" (ISU style, thousandths). */
export function raceTime(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(3);
  return min ? `${min}:${sec.padStart(6, '0')}` : sec;
}

/**
 * The time to show for a skater: ISU's, or "No time" once the race is over
 * and ISU has none (a fall, or results it never published). A status (PEN,
 * DNS) shows instead; a race still to come shows nothing.
 */
export function shownTime(timeText: string | null, status: string | null, heatState: string): string | null {
  const over = heatState === 'official' || heatState === 'unofficial';
  return timeText ?? (over && !status ? 'No time' : null);
}

/**
 * Three-letter codes for a race's skaters, as on TV graphics: "NAD" for
 * Nadalini. Skaters who'd share one also get their first initial ("VAN J"
 * and "VAN M" for the Van 't Wouts); relay teams use their nation's code.
 */
export function raceCodes(skaters: { name: string; last: string; nation: string | null }[], relay: boolean): string[] {
  const letters = (s: string) => s.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase();
  const codes = skaters.map((s) => (relay && s.nation ? s.nation : letters(s.last).slice(0, 3)));
  return codes.map((code, i) => {
    if (relay || codes.filter((c) => c === code).length < 2) return code;
    const initial = letters(skaters[i]!.name.replace(skaters[i]!.last, '')).charAt(0);
    return initial ? `${code} ${initial}` : code;
  });
}

/** 317 → "+0.317" */
export function gap(ms: number | null | undefined): string | null {
  return ms == null ? null : `+${(ms / 1000).toFixed(3)}`;
}

/**
 * "ISU Short Track World Tour #1" → "World Tour #1",
 * "ISU CNSG Short Track World Championships" → "World Championships" (drops sponsors),
 * "Olympic Winter Games 2026 Short Track Speed Skating" → "Olympic Winter Games 2026".
 */
/** Event kinds that count their stops in a season ("World Cup #3"). */
const SERIES = ['Junior World Cup', 'World Tour', 'World Cup'] as const;

/** Championships named by ISU's series, whatever the event's own (sponsored, dated) name says. */
const CHAMPIONSHIPS: Record<string, string> = {
  'World Championships': 'World Championships',
  'European Championships': 'European Championships',
  'Four Continents Championships': 'Four Continents Championships',
  'World Junior Championships': 'Junior World Championships',
};

/**
 * Names for one season's events, in date order: "World Cup #3", "World Tour #1",
 * "European Championships". ISU's older names are "ISU World Cup 2019/20 -
 * Salt Lake City (USA)" or just "ISU World Cup Short Track Speed Skating", so
 * stops are numbered by their order in the season unless the name has "#n".
 */
export function eventNames(events: { name: string; series: string | null }[]): string[] {
  const counts = new Map<string, number>();
  return events.map(({ name, series }) => {
    const kind = SERIES.find((k) => name.includes(k) || (k !== 'World Tour' && series?.includes(k)));
    if (kind) {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      return `${kind} #${/#(\d+)/.exec(name)?.[1] ?? n}`;
    }
    return CHAMPIONSHIPS[series ?? ''] ?? shortEventName(name);
  });
}

/** ISU's city, without the arena ("Salt Lake City, Utah Olympic Oval") and with a few fixes. */
export function cleanCity(city: string | null | undefined): string | null {
  const first = city?.split(',')[0]?.trim();
  if (!first) return null;
  return CITY_FIXES[first.toLowerCase()] ?? first;
}

const CITY_FIXES: Record<string, string> = { dordrech: 'Dordrecht', montreal: 'Montréal' };

export function shortEventName(name: string): string {
  const short = name
    .replace(/\bShort Track( Speed Skating)?\b/gi, '')
    .replace(/\b[A-Z]{2,}\b/g, '') // ISU, sponsor acronyms
    .replace(/\s+/g, ' ')
    .trim();
  return short || name;
}

/**
 * What an athlete's race list shows for a competition: "1000 m" for
 * individual races (ISU writes "Men 1000 m" or, at the Olympics, "Men's
 * 1000m"), the relay's name without the gender for relays ("5000 m Relay",
 * "Mixed Team Relay").
 */
export function distanceLabel(competition: string, distanceM: number | null, relay: boolean): string {
  if (!relay && distanceM) return `${distanceM} m`;
  return competition
    .replace(/^(Men|Women)('s)?\s+/i, '')
    .replace(/^Mixed's\s+/i, 'Mixed ')
    .replace(/(\d+)\s*m\b/i, '$1 m')
    .trim();
}

/**
 * "Final", "Final A", "Heat 4", "Semifinal · Heat 1", "Semifinal 2"
 * (Olympic heat names already say the round).
 */
export function roundLabel(round: string, heat: string): string {
  if (/^final/i.test(heat)) return heat;
  const single = round.replace(/Preliminaries/i, 'Preliminary').replace(/(\w)s\b/g, '$1');
  if (/^heats?$/i.test(round) || heat.toLowerCase().startsWith(single.toLowerCase())) return heat;
  return `${single} · ${heat}`;
}

/** 1, 2 or 3 for a podium place in an A final (or a single final); else null. */
export function medal(heat: string, rank: number | null): number | null {
  return rank != null && rank <= 3 && /^final( a\b|$)/i.test(heat.trim()) ? rank : null;
}
