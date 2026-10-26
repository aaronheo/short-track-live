/** 8640 → "8.640", 84537 → "1:24.537" (ISU style, thousandths). */
export function raceTime(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(3);
  return min ? `${min}:${sec.padStart(6, '0')}` : sec;
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
