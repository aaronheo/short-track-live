// Which pushes a device is due: "up next" when a favorite's heat is next on the
// ice, the result once it's official, and "Picks are open" per round. The same
// rules the phone used for its local alerts (RaceAlerts.swift), minus the
// scheduling: the server sends each one when it happens.

import type { AlertText } from './alerts.js';

export interface PushRace {
  heatId: number;
  startsAt: string | null;
  state: string;
  upNext: boolean;
  skaters: number[];
  start: AlertText;
  result: AlertText | null;
}

export interface PushOpenPick { heatId: number; title: string; round: string | null; race: string; picked: boolean }

export interface PushAlert extends AlertText {
  id: string; // "start-<heat>", "result-<heat>", "picks-<heat>"
  /** What a tap opens: shorttrack://<link>/<heatId>. */
  link: 'heat' | 'pick';
  heatId: number;
  /** Groups an event's alerts in Notification Center. */
  thread: string;
  /** Other alert ids this one stands for (a round's other races), marked sent with it. */
  covers?: string[];
}

export interface PushDeviceSettings { starts: boolean; results: boolean; picks: boolean }

/** Results older than this aren't worth a notification any more. */
export const RESULTS_FOR_MS = 6 * 3600_000;

export function raceAlerts<R extends PushRace>(races: R[], added: Map<number, Date>, settings: PushDeviceSettings,
  sent: Set<string>, now: Date, thread: (race: R) => string): PushAlert[] {
  const out: PushAlert[] = [];
  for (const race of races) {
    if (!race.startsAt) continue;
    const startsAt = new Date(race.startsAt);
    const since = Math.min(...race.skaters.map((id) => added.get(id)?.getTime() ?? Infinity));
    if (!(startsAt.getTime() > since)) continue; // raced before they were a favorite
    const base = { heatId: race.heatId, link: 'heat' as const, thread: thread(race) };
    const startId = `start-${race.heatId}`;
    if (settings.starts && race.upNext && (race.state === 'scheduled' || race.state === 'start_list') && !sent.has(startId)) {
      out.push({ id: startId, ...race.start, ...base });
    }
    const resultId = `result-${race.heatId}`;
    if (settings.results && race.result && !sent.has(resultId) && now.getTime() - startsAt.getTime() < RESULTS_FOR_MS) {
      out.push({ id: resultId, ...race.result, ...base });
    }
  }
  return out;
}

/** One "Picks are open" per round whose races aren't picked or announced yet. */
export function picksAlerts(open: PushOpenPick[], event: { name: string; city: string | null } | null, sent: Set<string>): PushAlert[] {
  const rounds = new Map<string, PushOpenPick[]>();
  for (const race of open) {
    if (race.picked || sent.has(`picks-${race.heatId}`)) continue;
    const name = [race.title, race.round?.toLowerCase()].filter(Boolean).join(' ');
    rounds.set(name, [...(rounds.get(name) ?? []), race]);
  }
  const place = event ? ` · ${event.city ?? event.name}` : '';
  return [...rounds].map(([name, races]) => ({
    id: `picks-${races[0]!.heatId}`,
    title: `Picks are open: ${name}`,
    body: `${races.length === 1 ? races[0]!.race : `${races.length} races`}${place}. Lock in your order before the start.`,
    heatId: races[0]!.heatId, link: 'pick' as const, thread: 'picks',
    covers: races.slice(1).map((r) => `picks-${r.heatId}`),
  }));
}
