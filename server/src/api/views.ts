// Screen-shaped JSON for the iOS app. These types are the API contract; the
// Swift models in ios/ShortTrackLive/Models mirror them.

import { QUALIFIED_CODES } from '../domain/codes.js';
import { gap, raceCodes, raceTime, shortEventName, shownTime } from '../domain/format.js';
import type { HeatState } from '../domain/normalize.js';
import { placesCard, type PlacesCard } from '../domain/places.js';
import type { QualRule } from '../domain/rules.js';
import { summarize } from '../domain/summary.js';
import { clock, dayKey, dayLabel, lapsFor } from '../domain/time.js';
import type { EntryRow, EventRow, HeatRow, LapRow, MemberRow, RoundRow, ScheduleRow } from './repo.js';

type State = 'upcoming' | 'live' | 'finished';

export interface EventSummary {
  slug: string; name: string; shortName: string; series: string | null; city: string | null; countryName: string | null;
  iso2: string | null; startsOn: string; endsOn: string; state: State;
}
export interface OnTheIce { roundId: number; competition: string; round: string; heat: string | null; lap: string | null }
export interface EventsResponse {
  season: string; seasons: string[];
  live: (EventSummary & { day: number; days: number; onTheIce: OnTheIce | null }) | null;
  events: EventSummary[];
}

export interface ScheduleItem {
  id: number; roundId: number | null; startsAt: string; venueTime: string; title: string; round: string;
  state: State; isFinal: boolean; liveDetail: string | null;
}
export interface ScheduleResponse {
  event: EventSummary & { timeZone: string };
  days: { key: string; label: string; live: boolean; items: ScheduleItem[] }[];
}

export interface EntryView {
  id: number; athleteId: number | null; rank: number | null; name: string; last: string; nat: string | null; iso2: string | null;
  startPosition: number | null; time: string | null; gap: string | null; status: string | null;
  /** Helmet cover number (ISU's bib): the skater's place in last season's World Tour. */
  helmet: number | null;
  badge: string | null; lastLap: string | null; laps: number;
  /** Relays (heat detail only): who skated for the team. */
  members?: RelayMember[];
}
export interface RelayMember { id: number; name: string; short: string }
export interface HeatBlock {
  id: number; name: string; state: HeatState; runOrder: number | null; startsAt: string | null;
  lap: { current: number; total: number | null } | null;
  qualified: { last: string; iso2: string | null; badge: string }[];
  sanctions: string | null; entries: EntryView[];
}
export interface RoundResponse {
  round: { id: number; name: string; competition: string; state: State; startsAt: string | null; venueTime: string | null; isRelay: boolean };
  event: { slug: string; name: string; timeZone: string };
  siblings: { id: number; name: string; current: boolean }[];
  progress: { finished: number; total: number; running: number | null };
  places: PlacesCard | null;
  heats: HeatBlock[];
}

export interface HeatResponse {
  heat: { id: number; name: string; state: HeatState; roundId: number; round: string; competition: string; event: string; isRelay: boolean };
  results: EntryView[];
  summary: string[];
  chart: { laps: number; series: { last: string; code: string; iso2: string | null; positions: (number | null)[] }[]; winner: string | null; climber: string | null } | null;
  lapTable: { columns: { last: string; iso2: string | null }[]; rows: { lap: number; cells: { time: string | null; best: boolean; fastest: boolean }[] }[] } | null;
  notes: string[];
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function eventSummary(e: EventRow): EventSummary {
  return {
    slug: e.slug, name: e.name, shortName: shortEventName(e.name), series: e.series, city: e.city, countryName: e.country_name, iso2: e.iso2,
    startsOn: e.starts_on, endsOn: e.ends_on, state: e.state,
  };
}

export function dayOfEvent(e: EventRow, now: Date): { day: number; days: number } {
  const start = Date.parse(`${e.starts_on}T00:00:00Z`);
  const end = Date.parse(`${e.ends_on}T00:00:00Z`);
  const today = Date.parse(`${dayKey(now, e.time_zone)}T00:00:00Z`);
  const days = Math.round((end - start) / 86400000) + 1;
  return { day: Math.min(days, Math.max(1, Math.round((today - start) / 86400000) + 1)), days };
}

export function scheduleView(event: EventRow, rows: ScheduleRow[]): ScheduleResponse {
  const days = new Map<string, ScheduleResponse['days'][number]>();
  for (const r of rows) {
    const key = dayKey(r.starts_at, event.time_zone);
    const day = days.get(key) ?? { key, label: dayLabel(r.starts_at, event.time_zone), live: false, items: [] };
    const state: State = r.state ?? 'upcoming';
    const liveDetail = state === 'live' && r.heats
      ? `Heat ${r.running ?? Math.min(r.done + 1, r.heats)} of ${r.heats}` : null;
    day.items.push({
      id: r.id, roundId: r.round_id, startsAt: r.starts_at.toISOString(), venueTime: clock(r.starts_at, event.time_zone),
      title: r.title, round: r.round_label, state, isFinal: /^finals?$/i.test(r.round_label.trim()), liveDetail,
    });
    day.live ||= state === 'live';
    days.set(key, day);
  }
  return { event: { ...eventSummary(event), timeZone: event.time_zone }, days: [...days.values()] };
}

function entryView(e: EntryRow, winnerMs: number | null, running: boolean, state: HeatState): EntryView {
  return {
    id: e.id, athleteId: e.skater_id, rank: running ? e.last_position : e.rank, name: e.name, last: e.last, nat: e.nation, iso2: e.iso2,
    startPosition: e.start_position, helmet: e.helmet,
    time: running ? null : shownTime(e.time_text, e.status, state),
    gap: !running && e.time_ms != null && winnerMs != null && e.time_ms > winnerMs ? gap(e.time_ms - winnerMs) : null,
    status: e.status, badge: running ? null : e.qualification, lastLap: raceTime(e.last_lap_ms), laps: e.lap_count,
  };
}

function sortEntries(entries: EntryRow[], state: HeatState): EntryRow[] {
  const big = 1e6;
  const key = (e: EntryRow) => (state === 'running' ? e.last_position ?? big
    : state === 'unofficial' || state === 'official' ? e.rank ?? big : e.start_position ?? big);
  return [...entries].sort((a, b) => key(a) - key(b) || (a.start_position ?? big) - (b.start_position ?? big));
}

function sanctions(entries: EntryRow[]): string | null {
  const parts = ['PEN', 'YC', 'RC'].flatMap((code) => {
    const n = entries.filter((e) => e.status === code).length;
    if (!n) return [];
    return [code === 'PEN' || n > 1 ? `${n} ${code}` : code];
  });
  return parts.length ? parts.join(' · ') : null;
}

export function roundRule(r: RoundRow): QualRule | null {
  return r.auto_places
    ? { autoPlaces: r.auto_places, timeSpots: r.time_spots ?? 0, timePlace: r.time_place, destination: r.destination }
    : null;
}

export function roundView(
  r: RoundRow, siblings: { id: number; name: string }[], heats: HeatRow[], entries: EntryRow[],
): RoundResponse {
  const byHeat = new Map<number, EntryRow[]>();
  for (const e of entries) byHeat.set(e.heat_id, [...(byHeat.get(e.heat_id) ?? []), e]);
  const totalLaps = lapsFor(r.distance_m);

  const blocks: HeatBlock[] = heats.map((h) => {
    const list = sortEntries(byHeat.get(h.id) ?? [], h.state);
    const running = h.state === 'running';
    const winnerMs = list.find((e) => e.rank === 1)?.time_ms ?? null;
    return {
      id: h.id, name: h.name, state: h.state, runOrder: h.run_order, startsAt: iso(h.starts_at),
      lap: running ? { current: Math.max(0, ...list.map((e) => e.last_lap_no ?? 0)), total: totalLaps } : null,
      qualified: running ? [] : list.filter((e) => e.qualification && QUALIFIED_CODES.has(e.qualification))
        .map((e) => ({ last: e.last, iso2: e.iso2, badge: e.qualification! })),
      sanctions: running ? null : sanctions(list),
      entries: list.map((e) => entryView(e, winnerMs, running, h.state)),
    };
  });

  const finished = heats.filter((h) => h.state === 'unofficial' || h.state === 'official').length;
  const places = placesCard(roundRule(r), heats.map((h) => ({
    name: h.name, state: h.state,
    entries: (byHeat.get(h.id) ?? []).map((e) => ({
      rank: e.rank, last: e.last, nat: e.nation, iso2: e.iso2, timeMs: e.time_ms, time: e.time_text, code: e.qualification,
    })),
  })), heats.length);

  return {
    round: {
      id: r.id, name: r.name, competition: r.competition, state: r.state, startsAt: iso(r.starts_at),
      venueTime: r.starts_at ? clock(r.starts_at, r.time_zone) : null, isRelay: r.is_relay,
    },
    event: { slug: r.event_slug, name: r.event_name, timeZone: r.time_zone },
    siblings: siblings.map((s) => ({ id: s.id, name: s.name, current: s.id === r.id })),
    progress: { finished, total: heats.length, running: heats.find((h) => h.state === 'running')?.run_order ?? null },
    places,
    heats: blocks,
  };
}

export function onTheIce(view: RoundResponse): OnTheIce {
  const running = view.heats.find((h) => h.state === 'running');
  const next = running ?? view.heats.find((h) => h.state === 'start_list' || h.state === 'scheduled');
  const index = next ? view.heats.indexOf(next) + 1 : null;
  return {
    roundId: view.round.id, competition: view.round.competition, round: view.round.name,
    heat: index ? `Heat ${index} of ${view.heats.length}` : null,
    lap: running?.lap ? `Lap ${running.lap.current} of ${running.lap.total ?? '?'}` : null,
  };
}

/**
 * A relay team's skaters, by surname; "J. Van 't Wout" and "M. Van 't Wout"
 * when two share one.
 */
export function relayMembers(rows: MemberRow[]): RelayMember[] {
  return rows.map((m) => {
    const twin = rows.some((o) => o !== m && o.last_name === m.last_name);
    const initial = m.first_name?.trim().charAt(0);
    return {
      id: m.id, name: m.first_name ? `${m.first_name} ${m.last_name}` : m.last_name,
      short: twin && initial ? `${initial}. ${m.last_name}` : m.last_name,
    };
  });
}

export function heatView(r: RoundRow, h: HeatRow, entries: EntryRow[], laps: LapRow[], members: MemberRow[] = []): HeatResponse {
  const list = sortEntries(entries, h.state === 'running' ? 'running' : 'official');
  const winnerMs = list.find((e) => e.rank === 1)?.time_ms ?? null;
  const lapsByEntry = new Map<number, LapRow[]>();
  for (const l of laps) lapsByEntry.set(l.entry_id, [...(lapsByEntry.get(l.entry_id) ?? []), l]);

  const finishers = list.filter((e) => e.rank != null && (lapsByEntry.get(e.id)?.length ?? 0) > 0);
  const total = Math.max(0, ...finishers.map((e) => lapsByEntry.get(e.id)!.length));
  const summaryInput = finishers.map((e) => ({
    last: e.last, rank: e.rank,
    laps: (lapsByEntry.get(e.id) ?? []).map((l) => ({ lap: l.lap_no, pos: l.position, lapMs: l.lap_ms })),
  }));

  // No chart or lap table when ISU is missing a placed skater's laps: one
  // line short, they'd quietly misstate the race.
  const lapsWhole = total > 0 && list.every((e) => e.rank == null || lapsByEntry.has(e.id));
  let chart: HeatResponse['chart'] = null;
  let lapTable: HeatResponse['lapTable'] = null;
  if (lapsWhole) {
    const climber = summarize(summaryInput).find((f) => / was \d+\w+ with \d+ laps to go/.test(f))?.split(' was ')[0] ?? null;
    // Codes, not surnames, tell skaters apart (two Van 't Wouts in one race).
    const codes = raceCodes(finishers, r.is_relay);
    chart = {
      laps: total,
      series: finishers.map((e, i) => {
        const byLap = new Map((lapsByEntry.get(e.id) ?? []).map((l) => [l.lap_no, l.position]));
        return { last: e.last, code: codes[i]!, iso2: e.iso2, positions: Array.from({ length: total }, (_, i) => byLap.get(i + 1) ?? null) };
      }),
      winner: codes[0] ?? null,
      climber: climber == null ? null : codes[finishers.findIndex((e) => e.last === climber)] ?? null,
    };
    const all = finishers.flatMap((e) => (lapsByEntry.get(e.id) ?? []).map((l) => l.lap_ms ?? Infinity));
    const fastest = Math.min(...all);
    const best = new Map(finishers.map((e) => [e.id, Math.min(...(lapsByEntry.get(e.id) ?? []).map((l) => l.lap_ms ?? Infinity))]));
    lapTable = {
      columns: finishers.map((e) => ({ last: e.last, iso2: e.iso2 })),
      rows: Array.from({ length: total }, (_, i) => ({
        lap: i + 1,
        cells: finishers.map((e) => {
          const ms = (lapsByEntry.get(e.id) ?? []).find((l) => l.lap_no === i + 1)?.lap_ms ?? null;
          return { time: raceTime(ms), fastest: ms === fastest, best: ms != null && ms !== fastest && ms === best.get(e.id) };
        }),
      })),
    };
  }

  // ISU removes the laps of a skater who is penalized or carded, which leaves
  // a gap in every lap's positions.
  const sanctioned: Record<string, string> = { PEN: 'was penalized', YC: 'got a yellow card', RC: 'got a red card' };
  const notes = list.filter((e) => e.status && sanctioned[e.status] && (lapsByEntry.get(e.id)?.length ?? 0) === 0 && lapsWhole)
    .map((e) => `${e.last}${e.nation ? ` (${e.nation})` : ''} ${sanctioned[e.status!]}. ISU removes their laps, so one place on each lap has no line.`);

  return {
    heat: { id: h.id, name: h.name, state: h.state, roundId: r.id, round: r.name, competition: r.competition, event: r.event_name, isRelay: r.is_relay },
    results: list.map((e) => {
      const view = entryView(e, winnerMs, false, h.state);
      return r.is_relay ? { ...view, members: relayMembers(members.filter((m) => m.entry_id === e.id)) } : view;
    }),
    summary: h.state === 'official' || h.state === 'unofficial' ? summarize(summaryInput) : [],
    chart, lapTable, notes,
  };
}
