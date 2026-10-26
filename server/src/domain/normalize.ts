import type { IsuCompetitor, IsuHeat, IsuSkater, IsuTeam } from '../isu/types.js';
import { iso2, statusCode } from './codes.js';
import { millis } from './time.js';

export type HeatState = 'scheduled' | 'start_list' | 'running' | 'unofficial' | 'official';

// ISU heat status / result_status → our state.
const HEAT_STATE: Record<string, HeatState> = {
  'Scheduled|': 'scheduled',
  'Scheduled|Start List': 'start_list',
  'Live|Live': 'running',
  'Finished|Live': 'unofficial',
  'Finished|Official': 'official',
};

export function heatState(h: Pick<IsuHeat, 'status' | 'result_status'>): HeatState {
  const known = HEAT_STATE[`${h.status}|${h.result_status ?? ''}`];
  if (known) return known;
  if (h.status === 'Finished') return 'unofficial';
  if (h.status === 'Live') return 'running';
  return 'scheduled';
}

export interface Lap {
  lap: number;
  lapMs: number | null;
  elapsedMs: number | null;
  /** Place in the race at the end of this lap (among all starters). */
  pos: number | null;
  gapMs: number | null;
}

export interface Entry {
  isuId: number;
  skater: IsuSkater | null;
  team: IsuTeam | null;
  members: IsuSkater[];
  name: string;
  last: string;
  nat: string | null;
  iso2: string | null;
  bib: number | null;
  start: number | null;
  rank: number | null;
  timeMs: number | null;
  /** As ISU shows it ("1:24.537", "PEN"), null for "no time". */
  time: string | null;
  status: string | null; // PEN | YC | RC | DNF | DNS
  code: string | null; // Q | q | p | QA | ... | ADV
  record: string | null;
  laps: Lap[];
}

function names(c: IsuCompetitor): { name: string; last: string } {
  if (c.skaters) {
    const last = titleName(c.skaters.last_name ?? c.skaters.full_name ?? '');
    const first = c.skaters.first_name?.trim() ?? '';
    return { name: first ? `${first} ${last}` : last, last };
  }
  const team = c.skaters_team?.name ?? c.started_for_nf_country_name ?? c.started_for_nf_code ?? 'Team';
  return { name: team, last: team };
}

/**
 * ISU writes most surnames in capitals ("VAN 'T WOUT", "GAGNON-LAMARCHE").
 * Show them in title case ("Van 't Wout", "Gagnon-Lamarche"); names ISU already
 * writes in mixed case ("Sighel") are kept as they are.
 */
export function titleName(s: string): string {
  if (s !== s.toUpperCase()) return s.trim();
  return s.trim().toLowerCase().split(/(\s+|-)/)
    .map((part) => (part === "'t" ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

export function normalizeEntry(c: IsuCompetitor): Entry {
  const { name, last } = names(c);
  const text = (c.final_result ?? '').trim();
  return {
    isuId: c.event_result_round_heats_competitors_id,
    skater: c.skaters,
    team: c.skaters_team,
    members: (c.event_result_round_heats_competitors_team_members ?? []).flatMap((m) => (m.skaters ? [m.skaters] : [])),
    name, last,
    nat: c.started_for_nf_code,
    iso2: iso2(c.started_for_nf_code),
    bib: c.bib_number,
    start: c.starting_position,
    rank: c.final_rank,
    timeMs: millis(text),
    time: text && text !== 'no time' ? text : null,
    status: statusCode(c.result_status, text),
    code: c.qualification_code || null,
    record: c.record_flag || null,
    laps: (c.lap ?? []).map((l) => ({
      lap: Number(l.LapNumber),
      lapMs: millis(l.LapTime),
      elapsedMs: millis(l.Time),
      pos: l.Rank ?? null,
      gapMs: millis(l.ResultDiff),
    })),
  };
}

/**
 * ISU occasionally lists the same skater twice in one heat (seen in WT1 2026
 * Women 500 m Heats, Heat 5: once ranked, once with "no time"). Keep one entry
 * per skater or team, preferring the ranked one.
 */
export function normalizeEntries(competitors: IsuCompetitor[] | null): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const c of competitors ?? []) {
    const e = normalizeEntry(c);
    const key = c.skaters_id ? `s${c.skaters_id}` : c.skaters_team_id ? `t${c.skaters_team_id}` : `e${e.isuId}`;
    const prev = byKey.get(key);
    if (!prev || (prev.rank == null && e.rank != null)) byKey.set(key, e);
  }
  return [...byKey.values()];
}
