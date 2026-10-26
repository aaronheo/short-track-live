// ISU time conventions (checked against WT1 Vancouver 2026):
//   schedule start_time and round.date are real UTC;
//   heat.date is the venue's wall-clock time with a fake "Z" suffix;
//   event from_date/to_date are local midnights with a "Z" suffix.

/**
 * ISU's time zone for a venue is often wrong, sometimes by hours: Montréal is
 * listed as America/Halifax, Salt Lake City as America/Chicago, Shanghai as
 * UTC. Heat times are converted with this zone, so we decide it ourselves:
 * the city for countries with several zones, else the country, else ISU's.
 */
const CITY_ZONES: Record<string, string> = {
  montreal: 'America/Toronto', quebec: 'America/Toronto', toronto: 'America/Toronto',
  calgary: 'America/Edmonton', vancouver: 'America/Vancouver',
  'salt lake city': 'America/Denver', kearns: 'America/Denver',
  milwaukee: 'America/Chicago', 'lake placid': 'America/New_York',
};

const COUNTRY_ZONES: Record<string, string> = { // IOC code; single-zone countries only
  CHN: 'Asia/Shanghai', KOR: 'Asia/Seoul', JPN: 'Asia/Tokyo', TPE: 'Asia/Taipei',
  ITA: 'Europe/Rome', NED: 'Europe/Amsterdam', GER: 'Europe/Berlin', POL: 'Europe/Warsaw',
  HUN: 'Europe/Budapest', FRA: 'Europe/Paris', BEL: 'Europe/Brussels', GBR: 'Europe/London',
  AUT: 'Europe/Vienna', SUI: 'Europe/Zurich', CZE: 'Europe/Prague', NOR: 'Europe/Oslo',
  SWE: 'Europe/Stockholm', FIN: 'Europe/Helsinki', LAT: 'Europe/Riga', BUL: 'Europe/Sofia',
  TUR: 'Europe/Istanbul',
};

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export function venueTimeZone(city: string | null | undefined, country: string | null | undefined, isuZone: string): string {
  return CITY_ZONES[plain(city ?? '')] ?? COUNTRY_ZONES[country ?? ''] ?? isuZone;
}

export function utc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Offset of `tz` from UTC at `instant`, in minutes (e.g. -420 for PDT). */
function offsetMinutes(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant) / 60000);
}

/** An ISU timestamp that is really wall-clock time in `tz` → the real instant. */
export function localWallClockToUtc(s: string | null | undefined, tz: string): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!, se!);
  // Two passes settle the offset across DST changes.
  let guess = naive - offsetMinutes(naive, tz) * 60000;
  guess = naive - offsetMinutes(guess, tz) * 60000;
  return new Date(guess);
}

/** "YYYY-MM-DD" of a local-midnight-with-Z ISU date. */
export function isuLocalDate(s: string): string {
  return s.slice(0, 10);
}

function parts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), wd: get('weekday') };
}

/** "16:41" in `tz`. */
export function clock(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.h}:${p.mi}`;
}

/** "2026-10-23" in `tz`. */
export function dayKey(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.y}-${p.mo}-${p.d}`;
}

/** "Fri 23" in `tz`. */
export function dayLabel(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.wd} ${Number(p.d)}`;
}

/** "1:24.537" → 84537 ms, "+0.520" → 520; "PEN", "no time", "" → null. */
export function millis(text: string | null | undefined): number | null {
  const m = /^[+-]?(?:(\d+):)?(\d+)\.(\d{1,3})$/.exec((text ?? '').trim());
  if (!m) return null;
  const [, min, sec, frac] = m;
  return (Number(min ?? 0) * 60 + Number(sec)) * 1000 + Number(frac!.padEnd(3, '0'));
}

/** Laps in a short track race (111.12 m track): 500 → 5, 1000 → 9, 1500 → 14. */
export function lapsFor(distanceM: number | null): number | null {
  return distanceM ? Math.ceil(distanceM / 111.12) : null;
}
