// Dev only: with REPLAY_HEAT=<our heat id>, the API serves that finished heat
// as if it were racing now, lap by lap at real speed, then repeats. Heats
// after it in the round go back to start lists. Lets us test the live UI when
// no event is on.

import type { EntryRow, HeatRow, LapRow } from '../api/repo.js';

const PAUSE_MS = 20_000; // between the finish and the next replay

export interface Replayed { heats: HeatRow[]; entries: EntryRow[]; live: boolean }

export function replayRound(
  heats: HeatRow[], entries: EntryRow[], laps: LapRow[], heatId: number, now: number, startedAt: number,
): Replayed | null {
  const target = heats.find((h) => h.id === heatId);
  if (!target) return null;
  const targetEntries = new Set(entries.filter((e) => e.heat_id === heatId).map((e) => e.id));
  const raceMs = Math.max(0, ...laps.filter((l) => targetEntries.has(l.entry_id)).map((l) => l.elapsed_ms ?? 0));
  if (!raceMs) return null;

  const t = (now - startedAt) % (raceMs + PAUSE_MS);
  const racing = t < raceMs;
  const later = new Set(heats.filter((h) => (h.run_order ?? 0) > (target.run_order ?? 0)).map((h) => h.id));

  const outHeats = heats.map((h) => (h.id === heatId ? { ...h, state: racing ? 'running' as const : 'unofficial' as const }
    : later.has(h.id) ? { ...h, state: 'start_list' as const } : h));

  const outEntries = entries.map((e) => {
    if (later.has(e.heat_id)) {
      return { ...e, rank: null, time_ms: null, time_text: null, status: null, qualification: null,
        lap_count: 0, last_lap_no: null, last_lap_ms: null, last_position: null, last_gap_ms: null };
    }
    if (e.heat_id !== heatId || !racing) return e;
    const seen = laps.filter((l) => l.entry_id === e.id && (l.elapsed_ms ?? Infinity) <= t);
    const last = seen.at(-1);
    return { ...e, rank: null, time_ms: null, time_text: null, qualification: null, status: null,
      lap_count: seen.length, last_lap_no: last?.lap_no ?? null, last_lap_ms: last?.lap_ms ?? null,
      last_position: last?.position ?? null, last_gap_ms: last?.gap_ms ?? null };
  });
  return { heats: outHeats, entries: outEntries, live: true };
}
