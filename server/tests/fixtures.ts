import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { EventTree } from '../src/isu/types.js';
import { heatState, normalizeEntries } from '../src/domain/normalize.js';
import type { PlaceHeat } from '../src/domain/places.js';

const DATA = path.resolve(import.meta.dirname, '../../data');

/** Real ISU responses saved during research (see data/). */
export const tree = (slug: string): EventTree =>
  JSON.parse(readFileSync(path.join(DATA, `${slug}.json`), 'utf8')) as EventTree;

export const WT1_2026 = 'isu-short-track-world-tour-1'; // Vancouver, pulled mid-event (Men 1500 m QF Heat 5 racing)
export const WT1_2025 = 'isu-short-track-world-tour-14';
export const OLYMPICS = 'olympic-winter-games-2026-short-track-skating';
export const WORLDS = 'isu-world-short-track-speed-skating-championships-2';

export function round(t: EventTree, competition: string, roundName: string) {
  const comp = t.competitions.find((c) => c.name === competition);
  const rnd = comp?.rounds.find((r) => r.name === roundName);
  if (!comp || !rnd) throw new Error(`no ${competition} / ${roundName}`);
  return { comp, rnd };
}

export function placeHeats(rnd: EventTree['competitions'][number]['rounds'][number]): PlaceHeat[] {
  return rnd.heats.map((h) => ({
    name: h.name,
    state: heatState(h),
    entries: normalizeEntries(h.event_result_round_heats_competitors).map((e) => ({
      rank: e.rank, last: e.last, nat: e.nat, iso2: e.iso2, timeMs: e.timeMs, time: e.time, code: e.code,
    })),
  }));
}
