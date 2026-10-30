import type { Db } from './pool.js';
import { isRelay } from '../isu/client.js';
import type { EventTree, IsuCompetition, IsuEvent, IsuHeat, IsuRound, IsuScheduleItem, IsuSkater } from '../isu/types.js';
import { iso2, shortCountry } from '../domain/codes.js';
import { cleanCity, eventNames } from '../domain/format.js';
import { competitionName, genderName, heatName, heatState, normalizeEntries, roundName, titleName, type Entry } from '../domain/normalize.js';
import { parseRule } from '../domain/rules.js';
import { heatTimes, isuLocalDate, utc, venueTimeZone } from '../domain/time.js';

type EventState = 'upcoming' | 'live' | 'finished';
const EVENT_STATE: Record<string, EventState> = {
  On: 'upcoming', Scheduled: 'upcoming', Upcoming: 'upcoming',
  Live: 'live', 'In Progress': 'live', Finished: 'finished',
};
/** Days after an event ends until ISU stops correcting its results. */
export const SETTLE_DAYS = 7;
export const eventState = (s: string | null | undefined): EventState => EVENT_STATE[s ?? ''] ?? 'upcoming';

// Events ISU names by their slug, by ISU event id.
const EVENT_NAMES: Record<number, string> = { 4103: 'ISU World Junior Short Track Speed Skating Championships' }; // "wjc2022"
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9]/g, '');

type Col = [name: string, sqlType: string];

/**
 * Upserts many rows in one statement via jsonb_to_recordset, keyed on `key`.
 * Table and column names are constants from this file, never user input.
 */
async function upsertMany(
  db: Db, table: string, cols: Col[], rows: Record<string, unknown>[], key = 'isu_id',
): Promise<Map<number, number>> {
  const ids = new Map<number, number>();
  if (rows.length === 0) return ids;
  const names = cols.map(([n]) => `"${n}"`).join(', ');
  const defs = cols.map(([n, t]) => `"${n}" ${t}`).join(', ');
  const updates = cols.filter(([n]) => n !== key).map(([n]) => `"${n}" = excluded."${n}"`).join(', ');
  const res = await db.query<{ id: number; isu_id: number }>(
    `insert into ${table} (${names}) select ${names} from jsonb_to_recordset($1::jsonb) as x(${defs})
     on conflict ("${key}") do update set ${updates} returning id, isu_id`,
    [JSON.stringify(rows)],
  );
  for (const r of res.rows) ids.set(r.isu_id, r.id);
  return ids;
}

export interface LoadedEvent { eventId: number; timeZone: string }

export class Ingest {
  private knownNations = new Set<string>();

  constructor(private readonly db: Db) {}

  /** Whole event: metadata, every competition/round/heat, and the schedule. */
  async loadTree(tree: EventTree): Promise<LoadedEvent> {
    const loaded = await this.upsertEvent(tree.event);
    const roundIds = new Map<number, number>(); // ISU round id -> ours
    const roundKeys = new Map<string, number>(); // competition + round name -> ours (unlinked schedules)
    const named: { title: string; label: string; roundId: number }[] = [];

    // ISU's schedule times are real UTC; they tell us how to read the heat times.
    const scheduled = new Map(tree.schedule.flatMap((si) => (si.event_result_round_id && utc(si.start_time)
      ? [[si.event_result_round_id, utc(si.start_time)!] as const] : [])));
    for (const comp of tree.competitions) {
      const compId = await this.upsertCompetition(loaded.eventId, comp);
      const ids = await this.upsertRounds(compId, comp.rounds);
      for (const rnd of comp.rounds) {
        const rid = ids.get(rnd.event_result_round_id)!;
        roundIds.set(rnd.event_result_round_id, rid);
        roundKeys.set(norm(comp.name) + '|' + norm(rnd.name), rid);
        named.push({ title: competitionName(comp.name, comp.gender, isRelay(comp)), label: roundName(rnd.name), roundId: rid });
        await this.loadHeats(rid, loaded.timeZone, rnd.heats, isRelay(comp), {
          round: roundName(rnd.name), eventFinished: eventState(tree.event.state) === 'finished',
          scheduledAt: scheduled.get(rnd.event_result_round_id) ?? null,
        });
      }
    }
    const derived = await this.withStarts(named);
    await this.rebuildSchedule(loaded.eventId, tree.schedule, roundIds, roundKeys, derived);
    return loaded;
  }

  /** Round start times from the database (after syncRoundStarts), for a derived schedule. */
  async withStarts<T extends { roundId: number }>(rounds: T[]): Promise<(T & { startsAt: Date })[]> {
    const res = await this.db.query<{ id: number; starts_at: Date | null }>(
      'select id, starts_at from round where id = any($1)', [rounds.map((r) => r.roundId)]);
    const starts = new Map(res.rows.map((r) => [r.id, r.starts_at]));
    return rounds.flatMap((r) => {
      const startsAt = starts.get(r.roundId);
      return startsAt ? [{ ...r, startsAt }] : [];
    });
  }

  /**
   * A round starts with its first heat. ISU's round.date can't be trusted:
   * in the 2025/26 data it's the venue's local time with a "Z" (hours off),
   * in 2026/27 it's real UTC. Heat times are consistent, so they win.
   */
  private async syncRoundStarts(roundIds: number[]): Promise<void> {
    if (!roundIds.length) return;
    await this.db.query(
      `update round r set starts_at = h.first
       from (select round_id, min(starts_at) as first from heat
             where round_id = any($1) and starts_at is not null group by round_id) h
       where r.id = h.round_id and r.starts_at is distinct from h.first`, [roundIds]);
  }

  /** Season + event row only (the daily event-list refresh). */
  async upsertEvent(ev: IsuEvent): Promise<LoadedEvent> {
    const first = Number(ev.season.slice(0, 4));
    const seasonIds = await upsertMany(this.db, 'season',
      [['isu_id', 'int'], ['title', 'text'], ['starts_on', 'date'], ['ends_on', 'date']],
      [{ isu_id: Number(ev.season_id), title: ev.season, starts_on: `${first}-07-01`, ends_on: `${first + 1}-06-30` }]);
    await this.nations([[ev.country_code, ev.country_name]]);
    const city = cleanCity(ev.city);
    const timeZone = venueTimeZone(city, ev.country_code, ev.time_zone);
    const ids = await upsertMany(this.db, 'event', [
      ['isu_id', 'int'], ['api_id', 'uuid'], ['slug', 'text'], ['season_id', 'smallint'], ['name', 'text'],
      ['series', 'text'], ['city', 'text'], ['country_code', 'text'], ['time_zone', 'text'],
      ['starts_on', 'date'], ['ends_on', 'date'], ['state', 'event_state'],
    ], [{
      isu_id: Number(ev.event_id ?? ev.id), api_id: ev.api_id || null, slug: ev.slug,
      season_id: seasonIds.get(Number(ev.season_id)), name: EVENT_NAMES[Number(ev.event_id ?? ev.id)] ?? ev.name, series: ev.event_sub_type_name ?? null,
      city, country_code: ev.country_code || null, time_zone: timeZone,
      starts_on: isuLocalDate(ev.from_date), ends_on: isuLocalDate(ev.to_date), state: eventState(ev.state),
    }]);
    await this.nameSeason(seasonIds.get(Number(ev.season_id))!);
    return { eventId: [...ids.values()][0]!, timeZone };
  }

  /** short_name for every event in a season (stops are numbered in date order). */
  async nameSeason(seasonId: number): Promise<void> {
    const events = (await this.db.query<{ id: number; name: string; series: string | null }>(
      'select id, name, series from event where season_id = $1 order by starts_on, id', [seasonId])).rows;
    const names = eventNames(events);
    await this.db.query(
      `update event e set short_name = x.name from unnest($1::int[], $2::text[]) as x(id, name)
       where e.id = x.id and e.short_name is distinct from x.name`, [events.map((e) => e.id), names]);
  }

  async upsertCompetition(eventId: number, comp: IsuCompetition): Promise<number> {
    const dist = comp.discipline_distance ?? '';
    const ids = await upsertMany(this.db, 'competition', [
      ['isu_id', 'int'], ['api_id', 'uuid'], ['event_id', 'int'], ['name', 'text'], ['gender', 'text'],
      ['distance_m', 'int'], ['is_relay', 'bool'], ['display_order', 'smallint'], ['state', 'event_state'],
    ], [{
      isu_id: comp.event_result_id, api_id: comp.api_id || null, event_id: eventId,
      name: competitionName(comp.name, comp.gender, isRelay(comp)), gender: genderName(comp.gender), distance_m: /^\d+$/.test(dist) ? Number(dist) : null, is_relay: isRelay(comp),
      display_order: comp.display_order, state: eventState(comp.status),
    }]);
    return ids.get(comp.event_result_id)!;
  }

  async upsertRounds(competitionId: number, rounds: IsuRound[]): Promise<Map<number, number>> {
    return upsertMany(this.db, 'round', [
      ['isu_id', 'int'], ['competition_id', 'int'], ['name', 'text'], ['display_order', 'smallint'],
      ['qualification_rule', 'text'], ['auto_places', 'smallint'], ['time_spots', 'smallint'],
      ['time_place', 'smallint'], ['destination', 'text'], ['starts_at', 'timestamptz'], ['state', 'event_state'],
    ], rounds.map((r) => {
      const rule = parseRule(r.qualification_rule);
      return {
        isu_id: r.event_result_round_id, competition_id: competitionId, name: roundName(r.name),
        display_order: r.display_order, qualification_rule: r.qualification_rule || null,
        auto_places: rule?.autoPlaces ?? null, time_spots: rule?.timeSpots ?? null,
        time_place: rule?.timePlace ?? null, destination: rule?.destination ?? null,
        starts_at: utc(r.date)?.toISOString() ?? null, state: eventState(r.status),
      };
    })).then(async (ids) => {
      await this.syncRoundStarts([...ids.values()]);
      return ids;
    });
  }

  /** Live polling: refresh one round's heats. */
  async loadRoundHeats(roundIsuId: number, heats: IsuHeat[], relay: boolean): Promise<void> {
    const res = await this.db.query<{ id: number; name: string; time_zone: string; finished: boolean; scheduled_at: Date | null }>(
      `select r.id, r.name, e.time_zone, e.state = 'finished' as finished,
         (select min(si.starts_at) from schedule_item si where si.round_id = r.id and si.source = 'isu') as scheduled_at
       from round r join competition c on c.id = r.competition_id
       join event e on e.id = c.event_id where r.isu_id = $1`, [roundIsuId]);
    const row = res.rows[0];
    if (row) {
      await this.loadHeats(row.id, row.time_zone, heats, relay,
        { round: row.name, eventFinished: row.finished, scheduledAt: row.scheduled_at });
    }
  }

  async loadHeats(
    roundId: number, tz: string, heats: IsuHeat[], relay: boolean,
    opts: { round: string; eventFinished: boolean; scheduledAt?: Date | null },
  ): Promise<void> {
    if (heats.length === 0) return;
    const startOf = heatTimes(heats.map((h) => h.date), tz, opts.scheduledAt ?? null);
    // heat.date is the planned time until the heat starts, then the actual
    // start. Raced heats go first by actual time, then the rest by plan.
    const raceKey = (h: IsuHeat) => `${h.status === 'Scheduled' ? 1 : 0}|${h.date ?? ''}|${String(h.display_order).padStart(3, '0')}`;
    const order = [...heats].sort((a, b) => raceKey(a).localeCompare(raceKey(b)));
    const heatIds = await upsertMany(this.db, 'heat', [
      ['isu_id', 'int'], ['round_id', 'int'], ['name', 'text'], ['display_order', 'smallint'],
      ['run_order', 'smallint'], ['starts_at', 'timestamptz'], ['state', 'heat_state'], ['source_updated_at', 'timestamptz'],
    ], heats.map((h) => ({
      isu_id: h.event_result_round_heats_id, round_id: roundId,
      name: heatName(h.name, opts.round, h.display_order, heats.length), display_order: h.display_order,
      run_order: order.indexOf(h) + 1, starts_at: startOf(h.date)?.toISOString() ?? null,
      state: heatState(h, opts.eventFinished), source_updated_at: utc(h.updated_at)?.toISOString() ?? null,
    })));

    const perHeat = heats.map((h) => ({ heatId: heatIds.get(h.event_result_round_heats_id)!, entries: normalizeEntries(h.event_result_round_heats_competitors) }));
    const previous = await this.db.query<{ heat_id: number; entries: number }>(
      `select h.id as heat_id, count(e.id)::int as entries
       from heat h left join entry e on e.heat_id = h.id
       where h.id = any($1::int[]) group by h.id`, [perHeat.map((h) => h.heatId)]);
    const previousEntries = new Map(previous.rows.map((r) => [r.heat_id, r.entries]));
    const wasStartList = (h: IsuHeat) => h.result_status === 'Start List';
    const incomingTotal = perHeat.reduce((total, h) => total + h.entries.length, 0);
    const previousTotal = previous.rows.reduce((total, h) => total + h.entries, 0);
    // ISU occasionally drops most of an entire start list from a live response.
    // Keep the roster we already have until ISU sends a credible replacement.
    const partialStartList = previousTotal > 0 && incomingTotal * 2 < previousTotal
      && heats.every(wasStartList);
    const protectedHeats = new Set(partialStartList
      ? perHeat.filter((h, i) => wasStartList(heats[i]!) && h.entries.length < (previousEntries.get(h.heatId) ?? 0)).map((h) => h.heatId)
      : []);
    const all = perHeat.flatMap((h) => h.entries);
    await this.nations(all.flatMap((e) => [[e.nat, null], [e.skater?.nationality_code, null], [e.team?.nf_organization_code, null]] as [string | null | undefined, string | null][]));
    const skaterIds = await this.skaters([...all.flatMap((e) => (e.skater ? [e.skater] : [])), ...all.flatMap((e) => e.members)]);
    const teamIds = await upsertMany(this.db, 'relay_team',
      [['isu_id', 'int'], ['api_id', 'uuid'], ['slug', 'text'], ['name', 'text'], ['nation', 'text']],
      dedupe(all.flatMap((e) => (e.team ? [e.team] : [])), (t) => t.id).map((t) => ({
        isu_id: t.id, api_id: t.api_id || null, slug: t.slug ?? null, name: shortCountry(t.name), nation: t.nf_organization_code || null,
      })));

    const entryRows = perHeat.flatMap(({ heatId, entries }) => entries.map((e) => entryRow(heatId, e, skaterIds, teamIds)))
      .filter((r) => r.skater_id != null || r.team_id != null);
    const entryIds = await upsertMany(this.db, 'entry', [
      ['isu_id', 'int'], ['heat_id', 'int'], ['skater_id', 'int'], ['team_id', 'int'], ['nation', 'text'],
      ['bib', 'smallint'], ['start_position', 'smallint'], ['rank', 'smallint'], ['time_ms', 'int'],
      ['time_text', 'text'], ['status', 'text'], ['qualification', 'text'], ['record', 'text'],
    ], entryRows);

    // Drop entries ISU no longer lists (a start list that changed, a duplicate we skipped),
    // except for a start list that ISU has clearly returned only in part.
    const heatsToPrune = perHeat.filter((h) => !protectedHeats.has(h.heatId)).map((h) => h.heatId);
    if (heatsToPrune.length) {
      await this.db.query(`delete from entry where heat_id = any($1::int[]) and not (id = any($2::bigint[]))`,
        [heatsToPrune, [...entryIds.values()]]);
    }

    const ids = [...entryIds.values()];
    await this.db.query('delete from lap where entry_id = any($1::bigint[])', [ids]);
    const laps = all.flatMap((e) => {
      const entryId = entryIds.get(e.isuId);
      return entryId ? e.laps.map((l) => ({ entry_id: entryId, lap_no: l.lap, lap_ms: l.lapMs, elapsed_ms: l.elapsedMs, position: l.pos, gap_ms: l.gapMs })) : [];
    });
    if (laps.length) {
      await this.db.query(
        `insert into lap (entry_id, lap_no, lap_ms, elapsed_ms, position, gap_ms)
         select * from jsonb_to_recordset($1::jsonb) as x(entry_id bigint, lap_no smallint, lap_ms int, elapsed_ms int, position smallint, gap_ms int)
         on conflict do nothing`, [JSON.stringify(laps)]);
    }

    if (relay) {
      await this.db.query('delete from relay_member where entry_id = any($1::bigint[])', [ids]);
      const members = all.flatMap((e) => {
        const entryId = entryIds.get(e.isuId);
        return entryId ? e.members.map((m) => ({ entry_id: entryId, skater_id: skaterIds.get(m.id) })) : [];
      }).filter((m) => m.skater_id != null);
      if (members.length) {
        await this.db.query(
          `insert into relay_member (entry_id, skater_id) select * from jsonb_to_recordset($1::jsonb) as x(entry_id bigint, skater_id int)
           on conflict do nothing`, [JSON.stringify(members)]);
      }
    }
    await this.syncRoundStarts([roundId]);
  }

  private async skaters(list: IsuSkater[]): Promise<Map<number, number>> {
    return upsertMany(this.db, 'skater', [
      ['isu_id', 'int'], ['api_id', 'uuid'], ['slug', 'text'], ['first_name', 'text'], ['last_name', 'text'],
      ['gender', 'text'], ['nation', 'text'], ['photo_path', 'text'],
    ], dedupe(list, (s) => s.id).map((s) => ({
      isu_id: s.id, api_id: s.api_id || null, slug: s.slug ?? null, first_name: s.first_name?.trim() || null,
      last_name: titleName(s.last_name ?? s.full_name ?? '?'), gender: s.gender?.slice(0, 1) ?? null,
      nation: s.nationality_code || null, photo_path: s.thumbnail_image || null,
    })));
  }

  /** Make sure every nation code exists; fills in a real name when ISU gives one. */
  private async nations(pairs: [string | null | undefined, string | null | undefined][]): Promise<void> {
    const rows = new Map<string, string | null>();
    for (const [code, name] of pairs) {
      if (!code) continue;
      if (this.knownNations.has(code) && !name) continue;
      if (!rows.get(code)) rows.set(code, name ?? null);
    }
    if (rows.size === 0) return;
    await this.db.query(
      `insert into nation (code, name, iso2)
       select code, coalesce(name, code), iso2 from jsonb_to_recordset($1::jsonb) as x(code text, name text, iso2 text)
       on conflict (code) do update set
         name = case when nation.name = nation.code and excluded.name <> excluded.code then excluded.name else nation.name end,
         iso2 = excluded.iso2`,
      [JSON.stringify([...rows].map(([code, name]) => ({ code, name, iso2: iso2(code) })))]);
    for (const code of rows.keys()) this.knownNations.add(code);
  }

  async rebuildSchedule(
    eventId: number, schedule: IsuScheduleItem[], roundIds: Map<number, number>,
    roundKeys: Map<string, number>, derived: { startsAt: Date; title: string; label: string; roundId: number }[],
  ): Promise<void> {
    const items = schedule.length
      ? schedule.map((s) => ({
        event_id: eventId,
        round_id: (s.event_result_round_id != null ? roundIds.get(s.event_result_round_id) : undefined)
          ?? roundKeys.get(norm(s.event_schedule_title) + '|' + norm(s.round_information)) ?? null,
        starts_at: utc(s.start_time)?.toISOString(), title: s.event_schedule_title, round_label: s.round_information, source: 'isu',
      }))
      : derived.map((d) => ({
        event_id: eventId, round_id: d.roundId, starts_at: d.startsAt.toISOString(), title: d.title, round_label: d.label, source: 'derived',
      }));
    await this.db.query('delete from schedule_item where event_id = $1', [eventId]);
    const valid = items.filter((i) => i.starts_at);
    if (valid.length) {
      await this.db.query(
        `insert into schedule_item (event_id, round_id, starts_at, title, round_label, source)
         select * from jsonb_to_recordset($1::jsonb)
           as x(event_id int, round_id int, starts_at timestamptz, title text, round_label text, source schedule_source)`,
        [JSON.stringify(valid)]);
    }
  }

  /**
   * A finished event settles a week after it ends: until then ISU keeps
   * entering penalties and renumbering entries (World Tour #1 2026), so it's
   * fetched again; a settled event never is. Gaps ISU leaves in a settled
   * event are reported but kept (they show as "No time"); only an event with
   * no results at all (cancelled, or never published) is left out.
   */
  async markSynced(eventId: number): Promise<{ complete: boolean; gaps: string | null; noResults: boolean }> {
    const res = await this.db.query<{ complete: boolean }>(
      `update event set synced_at = now(), results_complete = (state = 'finished' and ends_on < current_date - $2::int)
       where id = $1 returning results_complete as complete`, [eventId, SETTLE_DAYS]);
    const complete = res.rows[0]?.complete ?? false;
    if (!complete) return { complete, gaps: null, noResults: false };
    const noResults = !(await this.db.query(
      `select 1 from entry x join heat h on h.id = x.heat_id join round r on r.id = h.round_id
       join competition c on c.id = r.competition_id
       where c.event_id = $1 and (x.rank is not null or x.time_ms is not null or x.status is not null or x.qualification is not null)
       limit 1`, [eventId])).rowCount;
    if (noResults) {
      // Start lists at most: nothing worth keeping.
      await this.db.query('delete from schedule_item where event_id = $1', [eventId]);
      await this.db.query('delete from competition where event_id = $1', [eventId]);
      await this.db.query(`delete from skater k where not exists (select 1 from entry x where x.skater_id = k.id)
        and not exists (select 1 from relay_member m where m.skater_id = k.id)`);
    }
    await this.db.query('update event set no_results = $2 where id = $1', [eventId, noResults]);
    return { complete, gaps: noResults ? null : await this.gaps(eventId), noResults };
  }

  /**
   * What ISU is missing for an event, or null: skaters with no place, time,
   * status or advancement; races with places beyond their skaters (3rd, 4th
   * and 5th of three: the others are gone); distances without a final (or one
   * with a single entry); races with places but no times. A lone skater
   * placed without a time is a walkover, and one placed untimed among timed
   * ones fell. A penalized skater keeps a place number at some events, so
   * 1, 2, 4 and a PEN is a whole race.
   */
  async gaps(eventId: number): Promise<string | null> {
    const res = await this.db.query<{ results: string; short: string; finals: string; untimed: string }>(
      `with h as (
         select c.id as comp_id, h.id, h.name,
           (select count(*) from entry x where x.heat_id = h.id) as entries,
           (select count(*) from entry x where x.heat_id = h.id and x.rank is not null) as placed,
           (select count(*) from entry x where x.heat_id = h.id and x.time_ms is not null) as timed,
           (select max(x.rank) from entry x where x.heat_id = h.id) as top
         from competition c join round r on r.competition_id = c.id join heat h on h.round_id = r.id where c.event_id = $1)
       select
         (select count(*) from entry x join h on h.id = x.heat_id
          where x.rank is null and x.time_ms is null and x.status is null and x.qualification is null) as results,
         (select count(*) from h where h.top > h.entries) as short,
         (select count(*) from competition c where c.event_id = $1 and not exists (
            select 1 from h where h.comp_id = c.id and h.name in ('Final', 'Final A', 'Super Final') and h.entries >= 2)) as finals,
         (select count(*) from h where h.placed >= 2 and h.timed = 0) as untimed`, [eventId]);
    const { results, short, finals, untimed } = res.rows[0]!;
    const parts = [
      Number(results) && `${results} skaters without a result`,
      Number(short) && `${short} races with skaters left out`,
      Number(finals) && `${finals} distances without a final`,
      Number(untimed) && `${untimed} races without times`,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
}

function entryRow(heatId: number, e: Entry, skaterIds: Map<number, number>, teamIds: Map<number, number>) {
  return {
    isu_id: e.isuId, heat_id: heatId,
    skater_id: e.skater ? skaterIds.get(e.skater.id) ?? null : null,
    team_id: !e.skater && e.team ? teamIds.get(e.team.id) ?? null : null,
    nation: e.nat || null, bib: e.bib, start_position: e.start, rank: e.rank, time_ms: e.timeMs,
    time_text: e.time, status: e.status, qualification: e.code, record: e.record,
  };
}

function dedupe<T>(items: T[], key: (t: T) => number): T[] {
  const seen = new Map<number, T>();
  for (const t of items) if (!seen.has(key(t))) seen.set(key(t), t);
  return [...seen.values()];
}
