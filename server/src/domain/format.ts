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

/** 317 → "+0.317" */
export function gap(ms: number | null | undefined): string | null {
  return ms == null ? null : `+${(ms / 1000).toFixed(3)}`;
}

/**
 * "ISU Short Track World Tour #1" → "World Tour #1",
 * "ISU CNSG Short Track World Championships" → "World Championships" (drops sponsors),
 * "Olympic Winter Games 2026 Short Track Speed Skating" → "Olympic Winter Games 2026".
 */
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
