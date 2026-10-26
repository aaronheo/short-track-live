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
