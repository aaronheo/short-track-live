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

export interface PushOpenPick { heatId: number; roundId: number; title: string; round: string | null; race: string; picked: boolean }

export interface PushAlert extends AlertText {
  id: string; // "start-<heat>", "result-<heat>", "picks-round-<round>"
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

/**
 * One "Picks are open" per round, ever: for its open races not yet picked,
 * and never again once sent, however its races come into the open list
 * (start lists arrive heat by heat). Alerts sent before they were kept per
 * round were "picks-<heat>" for each of the round's races; any of those
 * counts as the round's alert too.
 */
export function picksAlerts(open: PushOpenPick[], event: { name: string; city: string | null } | null, sent: Set<string>): PushAlert[] {
  const rounds = new Map<number, PushOpenPick[]>();
  const done = new Set<number>();
  for (const race of open) {
    if (sent.has(`picks-${race.heatId}`) || sent.has(`picks-round-${race.roundId}`)) done.add(race.roundId);
    if (race.picked) continue;
    rounds.set(race.roundId, [...(rounds.get(race.roundId) ?? []), race]);
  }
  const place = event ? ` · ${event.city ?? event.name}` : '';
  return [...rounds].filter(([roundId]) => !done.has(roundId)).map(([roundId, races]) => {
    const name = [races[0]!.title, races[0]!.round?.toLowerCase()].filter(Boolean).join(' ');
    return {
      id: `picks-round-${roundId}`,
      title: `Picks are open: ${name}`,
      body: `${races.length === 1 ? races[0]!.race : `${races.length} races`}${place}. Lock in your order before the start.`,
      heatId: races[0]!.heatId, link: 'pick' as const, thread: 'picks',
    };
  });
}
