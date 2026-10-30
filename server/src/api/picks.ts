// Picks: the Picks tab, one heat's pick (with how everyone picked and the
// score once official), saving a pick, and the event's leaderboard. Scores are
// worked out when read, so a corrected result rescores everyone.

import type { Db } from '../db/pool.js';
import { roundLabel, shortEventName } from '../domain/format.js';
import { PICKABLE_ROUNDS, cutLine, scorePick, validPick, type PickInput, type ResultEntry, type Score } from '../domain/picks.js';

type HeatState = 'scheduled' | 'start_list' | 'running' | 'unofficial' | 'official';

export interface PickSummary {
  heatId: number;
  title: string; // "Women 1000 m"
  race: string; // "Semifinal · Heat 2", "Final A"
  round: string; // "Semifinals": picks-open alerts come one per round
  startsAt: string | null;
  timeZone: string; // the venue's, for showing startsAt
  state: HeatState;
  picked: boolean;
  /** Once official. */
  points: number | null;
  max: number | null;
}

export interface PicksHome {
  signedIn: boolean;
  nickname: string | null;
  event: { slug: string; name: string; city: string | null; state: string } | null;
  /** Heats still open to pick, soonest first. */
  open: PickSummary[];
  /** Your picks at this event, latest first. */
  mine: PickSummary[];
  me: { points: number; picked: number; rank: number | null } | null;
  players: number;
  leaderboard: { rank: number; nickname: string; points: number; me: boolean }[];
}

export interface PickHeatView {
  heatId: number;
  event: string; // "World Tour #1, Vancouver"
  title: string;
  race: string;
  startsAt: string | null;
  state: HeatState;
  /** Earlier of the race state and its fair-play lock time. */
  locked: boolean;
  /** Picks normally close when the race two places ahead begins. */
  locksAt: string | null;
  /** Where the dashed line goes: after this many places. */
  cut: { after: number; label: string } | null;
  /** In start order. */
  entries: { entryId: number; name: string; last: string; nat: string | null; iso2: string | null; start: number | null; helmet: number | null }[];
  myPick: PickInput | null;
  /** How everyone picked: once you've picked, or once the race has started. */
  crowd: {
    picks: number;
    /** Per entry: % who put them 1st, 2nd, … and % who picked a penalty. */
    entries: { entryId: number; places: number[]; penalized: number }[];
    mostPicked: (PickInput & { share: number }) | null;
  } | null;
  /** Once official. */
  result: { entries: (ResultEntry & { time: string | null })[]; score: Score | null } | null;
}

export type SaveResult = PickHeatView | 'not_found' | 'locked' | 'invalid' | 'needs_nickname';

interface HeatRow {
  id: number; name: string; state: HeatState; starts_at: Date | null; round: string; auto_places: number | null; destination: string | null;
  competition: string; event_id: number; event_name: string; city: string | null; time_zone: string;
}

const OPEN: HeatState[] = ['scheduled', 'start_list'];
const RACES_AHEAD = 2;
const BREAK_GAP_MS = 10 * 60_000;
const BREAK_LOCK_LEAD_MS = 3 * 60_000;
const ids = (xs: (string | number)[] | null) => (xs ?? []).map(Number);
const summaryTitle = (h: { competition: string; round: string; name: string }) => ({
  title: h.competition, race: roundLabel(h.round, h.name),
});

export class Picks {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  /**
   * Close each pick when the race two places before it begins. The first race
   * after a sizable break instead closes three minutes before its own listed
   * start, so a session break doesn't make it lock far too early.
   */
  private lockTimes(heats: Pick<HeatRow, 'id' | 'starts_at'>[]): Map<number, Date | null> {
    return new Map(heats.map((heat, i) => {
      const previous = heats[i - 1];
      const earlyRace = heats[i - RACES_AHEAD];
      const firstAfterBreak = !previous?.starts_at || !heat.starts_at
        || heat.starts_at.getTime() - previous.starts_at.getTime() >= BREAK_GAP_MS;
      // Don't use a race before a break as the two-races-ahead anchor.
      const earlyRaceIsBeforeBreak = !!earlyRace?.starts_at && !!previous?.starts_at
        && previous.starts_at.getTime() - earlyRace.starts_at.getTime() >= BREAK_GAP_MS;
      const locksAt = firstAfterBreak
        ? heat.starts_at && new Date(heat.starts_at.getTime() - BREAK_LOCK_LEAD_MS)
        : earlyRaceIsBeforeBreak ? previous?.starts_at ?? heat.starts_at
          : earlyRace?.starts_at ?? previous?.starts_at ?? heat.starts_at;
      return [heat.id, locksAt];
    }));
  }

  private isLocked(heat: Pick<HeatRow, 'state'>, locksAt: Date | null | undefined): boolean {
    return !OPEN.includes(heat.state) || (locksAt != null && locksAt <= this.now());
  }

  async home(accountId: number | null, now: Date): Promise<PicksHome> {
    const nickname = accountId ? (await this.db.query<{ nickname: string | null }>(
      'select nickname from account where id = $1', [accountId])).rows[0]?.nickname ?? null : null;
    // The live event; else one that ended in the last 3 days (for scores); else the next one.
    const event = (await this.db.query<{ id: number; slug: string; name: string; city: string | null; state: string }>(
      `select e.id, e.slug, coalesce(e.short_name, e.name) as name, e.city, e.state from event e
       where exists (select 1 from competition c join round r on r.competition_id = c.id where c.event_id = e.id and r.name = any($2))
       order by (e.state = 'live') desc,
         (e.ends_on between $1::date - 3 and $1::date) desc,
         (e.starts_on >= $1::date) desc,
         case when e.starts_on >= $1::date then e.starts_on end asc,
         e.ends_on desc
       limit 1`, [now.toISOString().slice(0, 10), PICKABLE_ROUNDS])).rows[0];
    const base: PicksHome = {
      signedIn: accountId != null, nickname, event: null, open: [], mine: [], me: null, players: 0, leaderboard: [],
    };
    // Picks are for signed-in people only.
    if (!event || accountId == null) return base;

    const heats = (await this.db.query<HeatRow & { entries: number }>(
      `select h.id, h.name, h.state, h.starts_at, r.name as round, r.auto_places, r.destination, c.name as competition,
         c.event_id, coalesce(e.short_name, e.name) as event_name, e.city, e.time_zone, (select count(*) from entry en where en.heat_id = h.id)::int as entries
       from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id join event e on e.id = c.event_id
       where c.event_id = $1 and r.name = any($2)
       order by h.starts_at nulls last, h.run_order nulls last, h.id`, [event.id, PICKABLE_ROUNDS])).rows;
    const locks = this.lockTimes(heats);
    const scores = await this.scores(event.id);
    const mine = new Map((accountId ? scores.filter((s) => s.accountId === accountId) : []).map((s) => [s.heatId, s]));
    const summary = (h: HeatRow): PickSummary => {
      const s = mine.get(h.id);
      return {
        heatId: h.id, ...summaryTitle(h), round: h.round, startsAt: h.starts_at?.toISOString() ?? null, timeZone: h.time_zone, state: h.state,
        picked: !!s, points: s?.score?.points ?? null, max: s?.score?.max ?? null,
      };
    };

    // Leaderboard: everyone's points from official heats; ties share a rank.
    const totals = new Map<number, { nickname: string; points: number }>();
    for (const s of scores) {
      const t = totals.get(s.accountId) ?? { nickname: s.nickname ?? '', points: 0 };
      t.points += s.score?.points ?? 0;
      totals.set(s.accountId, t);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1].points - a[1].points || a[1].nickname.localeCompare(b[1].nickname))
      .map(([id, t], i, all) => ({ id, ...t, rank: i > 0 && all[i - 1]![1].points === t.points ? -1 : i + 1 }));
    for (let i = 0; i < ranked.length; i++) if (ranked[i]!.rank === -1) ranked[i]!.rank = ranked[i - 1]!.rank;
    const meRow = ranked.find((r) => r.id === accountId);
    const board = ranked.slice(0, 20);
    if (meRow && !board.includes(meRow)) board.push(meRow);

    return {
      ...base,
      event: { slug: event.slug, name: shortEventName(event.name), city: event.city, state: event.state },
      // Once someone has made a pick, keep the heat in their editable picks
      // rather than also offering it again in the next-pick queue.
      open: heats.filter((h) => !this.isLocked(h, locks.get(h.id)) && h.entries >= 2 && !mine.has(h.id)).slice(0, 12).map(summary),
      mine: heats.filter((h) => mine.has(h.id)).reverse().map(summary),
      me: accountId ? { points: meRow?.points ?? 0, picked: mine.size, rank: meRow?.rank ?? null } : null,
      players: totals.size,
      leaderboard: board.map((r) => ({ rank: r.rank, nickname: r.nickname, points: r.points, me: r.id === accountId })),
    };
  }

  async heat(heatId: number, accountId: number | null): Promise<PickHeatView | null> {
    const h = await this.heatRow(heatId);
    if (!h) return null;
    const locksAt = await this.lockAt(h);
    const entries = (await this.db.query<{
      id: number; name: string; last: string; nation: string | null; iso2: string | null; start_position: number | null; helmet: number | null;
      rank: number | null; status: string | null; time_text: string | null;
    }>(
      `select en.id, coalesce(s.first_name || ' ' || s.last_name, s.last_name, t.name) as name, coalesce(s.last_name, t.name) as last,
         en.nation, n.iso2, en.start_position, case when en.skater_id is not null then en.bib end as helmet, en.rank, en.status, en.time_text
       from entry en left join skater s on s.id = en.skater_id left join relay_team t on t.id = en.team_id
       left join nation n on n.code = en.nation
       where en.heat_id = $1 order by en.start_position nulls last, en.id`, [heatId])).rows;
    const picks = (await this.db.query<{ account_id: number; finish: string[]; penalized: string[] }>(
      'select account_id, finish, penalized from pick where heat_id = $1', [heatId])).rows
      .map((p) => ({ accountId: Number(p.account_id), finish: ids(p.finish), penalized: ids(p.penalized) }));
    const mine = picks.find((p) => p.accountId === accountId);
    const locked = this.isLocked(h, locksAt);
    const official = h.state === 'official';
    const results = entries.map((e) => ({ entryId: e.id, rank: e.rank, status: e.status }));

    let crowd: PickHeatView['crowd'] = null;
    if ((mine || locked) && picks.length) {
      const pct = (n: number) => Math.round((n / picks.length) * 100);
      const combos = new Map<string, { pick: PickInput; n: number }>();
      for (const p of picks) {
        const key = `${p.finish.join(',')}|${[...p.penalized].sort().join(',')}`;
        combos.set(key, { pick: { finish: p.finish, penalized: p.penalized }, n: (combos.get(key)?.n ?? 0) + 1 });
      }
      const top = [...combos.values()].sort((a, b) => b.n - a.n)[0]!;
      crowd = {
        picks: picks.length,
        entries: entries.map((e) => ({
          entryId: e.id,
          places: entries.map((_, i) => pct(picks.filter((p) => p.finish[i] === e.id).length)),
          penalized: pct(picks.filter((p) => p.penalized.includes(e.id)).length),
        })),
        mostPicked: { ...top.pick, share: pct(top.n) },
      };
    }

    return {
      heatId: h.id,
      event: [shortEventName(h.event_name), h.city].filter(Boolean).join(', '),
      ...summaryTitle(h),
      startsAt: h.starts_at?.toISOString() ?? null,
      state: h.state,
      locked,
      locksAt: locksAt?.toISOString() ?? null,
      cut: cutLine({ name: h.round, auto_places: h.auto_places, destination: h.destination }, h.name),
      entries: entries.map((e) => ({ entryId: e.id, name: e.name, last: e.last, nat: e.nation, iso2: e.iso2, start: e.start_position, helmet: e.helmet })),
      myPick: mine ? { finish: mine.finish, penalized: mine.penalized } : null,
      crowd,
      result: official ? {
        entries: entries.map((e) => ({ entryId: e.id, rank: e.rank, status: e.status, time: e.status ? null : e.time_text }))
          .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
        score: mine ? scorePick(mine, results) : null,
      } : null,
    };
  }

  /** Saves (or replaces) a pick while the race hasn't started. */
  async save(accountId: number, heatId: number, pick: PickInput): Promise<SaveResult> {
    const h = await this.heatRow(heatId);
    if (!h) return 'not_found';
    if (this.isLocked(h, await this.lockAt(h))) return 'locked';
    const nickname = (await this.db.query<{ nickname: string | null }>('select nickname from account where id = $1', [accountId])).rows[0]?.nickname;
    if (!nickname) return 'needs_nickname';
    const entryIds = (await this.db.query<{ id: number }>('select id from entry where heat_id = $1', [heatId])).rows.map((r) => Number(r.id));
    if (entryIds.length < 2 || !validPick(pick, entryIds)) return 'invalid';
    await this.db.query(
      `insert into pick (account_id, heat_id, finish, penalized) values ($1, $2, $3, $4)
       on conflict (account_id, heat_id) do update set finish = excluded.finish, penalized = excluded.penalized, updated_at = now()`,
      [accountId, heatId, pick.finish, pick.penalized]);
    return (await this.heat(heatId, accountId))!;
  }

  private async heatRow(heatId: number): Promise<HeatRow | null> {
    return (await this.db.query<HeatRow>(
      `select h.id, h.name, h.state, h.starts_at, r.name as round, r.auto_places, r.destination, c.name as competition,
         c.event_id, coalesce(e.short_name, e.name) as event_name, e.city, e.time_zone
       from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id join event e on e.id = c.event_id
       where h.id = $1 and r.name = any($2)`, [heatId, PICKABLE_ROUNDS])).rows[0] ?? null;
  }

  private async lockAt(heat: HeatRow): Promise<Date | null> {
    const heats = (await this.db.query<Pick<HeatRow, 'id' | 'starts_at'>>(
      `select h.id, h.starts_at from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id
       where c.event_id = $1 and r.name = any($2)
       order by h.starts_at nulls last, h.run_order nulls last, h.id`, [heat.event_id, PICKABLE_ROUNDS])).rows;
    return this.lockTimes(heats).get(heat.id) ?? null;
  }

  /** Every pick at an event, scored where the heat is official. */
  private async scores(eventId: number) {
    const picks = (await this.db.query<{ account_id: number; heat_id: number; finish: string[]; penalized: string[]; nickname: string | null; state: HeatState }>(
      `select p.account_id, p.heat_id, p.finish, p.penalized, a.nickname, h.state
       from pick p join account a on a.id = p.account_id join heat h on h.id = p.heat_id
       join round r on r.id = h.round_id join competition c on c.id = r.competition_id
       where c.event_id = $1`, [eventId])).rows;
    const official = [...new Set(picks.filter((p) => p.state === 'official').map((p) => p.heat_id))];
    const results = new Map<number, ResultEntry[]>();
    for (const r of (await this.db.query<{ id: number; heat_id: number; rank: number | null; status: string | null }>(
      'select id, heat_id, rank, status from entry where heat_id = any($1)', [official])).rows) {
      results.set(r.heat_id, [...(results.get(r.heat_id) ?? []), { entryId: Number(r.id), rank: r.rank, status: r.status }]);
    }
    return picks.map((p) => {
      const pick = { finish: ids(p.finish), penalized: ids(p.penalized) };
      return {
        accountId: Number(p.account_id), heatId: p.heat_id, nickname: p.nickname,
        score: p.state === 'official' ? scorePick(pick, results.get(p.heat_id) ?? []) : null,
      };
    });
  }
}
