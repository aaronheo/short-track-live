// Keeps ISU's World Tour standings for the current season. ISU recalculates
// them after each day of racing; a list whose updated_at hasn't changed isn't
// fetched again.

import type pg from 'pg';
import { classifyStanding, titleCaseName, type StandingInfo } from '../domain/standings.js';
import type { IsuStandingEntry, IsuStandingList } from '../isu/types.js';

export interface StandingsSource {
  standingLists(seasonId: number): Promise<IsuStandingList[]>;
  standing(id: number, team: boolean): Promise<IsuStandingEntry[]>;
}

type Log = (msg: string) => void;

export class StandingsSync {
  constructor(
    private readonly isu: StandingsSource,
    private readonly pool: pg.Pool,
    private readonly log: Log = (m) => console.log(`[standings] ${m}`),
  ) {}

  /** The latest season we have. Returns how many lists were (re)loaded. */
  async refresh(): Promise<number> {
    const season = (await this.pool.query<{ id: number; isu_id: number; title: string }>(
      'select id, isu_id, title from season order by starts_on desc limit 1')).rows[0];
    if (!season) return 0;
    const stored = new Map((await this.pool.query<{ id: number; isu_updated_at: Date | null }>(
      'select id, isu_updated_at from standing where season_id = $1', [season.id])).rows
      .map((r) => [r.id, r.isu_updated_at?.getTime() ?? 0]));
    let loaded = 0;
    for (const list of await this.isu.standingLists(season.isu_id)) {
      const info = classifyStanding(list);
      if (!info || stored.get(list.world_standings_list_fsk_id) === Date.parse(list.updated_at)) continue;
      const entries = await this.isu.standing(list.world_standings_list_fsk_id, list.team_type === 'Couples');
      await this.save(season.id, list, info, entries);
      loaded++;
    }
    if (loaded) this.log(`${season.title}: loaded ${loaded} standings`);
    return loaded;
  }

  /** Replaces one list and everyone in it. */
  async save(seasonId: number, list: IsuStandingList, info: StandingInfo, entries: IsuStandingEntry[]): Promise<void> {
    const columns = [...(entries[0]?.world_standings_list_stk_competitors_competition_points ?? [])]
      .sort((a, b) => a.display_order - b.display_order);
    // A stop's name and date come with any entry that scored there.
    const events = columns.map((c) => {
      const raced = entries.flatMap((e) => e.world_standings_list_stk_competitors_competition_points)
        .find((p) => p.country === c.country && p.name);
      return { code: c.country, name: raced?.name || null, date: raced?.date ?? null };
    });
    const apiIds = entries.flatMap((e) => (e.skaters?.api_id ? [e.skaters.api_id] : []));
    const known = new Map((await this.pool.query<{ id: number; api_id: string }>(
      'select id, api_id::text from skater where api_id = any($1::uuid[])', [apiIds])).rows.map((r) => [r.api_id, r.id]));
    const rows = entries.map((e) => {
      const points = new Map(e.world_standings_list_stk_competitors_competition_points.map((p) => [p.country, p.result]));
      const s = e.skaters;
      return {
        position: e.rank_index, rank: e.rank, points: e.points,
        skater: s?.api_id ? known.get(s.api_id) ?? null : null,
        nation: e.nf_for_country_code ?? s?.nationality_code ?? e.skaters_team?.nf_organization_code ?? null,
        name: s ? [s.first_name, titleCaseName(s.last_name)].filter(Boolean).join(' ') : e.skaters_team?.name ?? '',
        perEvent: `{${columns.map((c) => (points.get(c.country) ? Number(points.get(c.country)) : 'NULL')).join(',')}}`,
      };
    });

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into standing (id, season_id, kind, gender, distance, name, events, calculated_at, isu_updated_at, synced_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         on conflict (id) do update set season_id = excluded.season_id, kind = excluded.kind, gender = excluded.gender,
           distance = excluded.distance, name = excluded.name, events = excluded.events,
           calculated_at = excluded.calculated_at, isu_updated_at = excluded.isu_updated_at, synced_at = now()`,
        [list.world_standings_list_fsk_id, seasonId, info.kind, info.gender, info.distance, list.name.trim(),
          JSON.stringify(events), list.calculation_date, list.updated_at]);
      await client.query('delete from standing_entry where standing_id = $1', [list.world_standings_list_fsk_id]);
      await client.query(
        `insert into standing_entry (standing_id, position, rank, points, skater_id, nation, name, per_event)
         select $1, t.position, t.rank, t.points, t.skater_id, t.nation, t.name, t.per_event::int[]
         from unnest($2::smallint[], $3::smallint[], $4::int[], $5::int[], $6::text[], $7::text[], $8::text[])
           as t(position, rank, points, skater_id, nation, name, per_event)`,
        [list.world_standings_list_fsk_id, rows.map((r) => r.position), rows.map((r) => r.rank), rows.map((r) => r.points),
          rows.map((r) => r.skater), rows.map((r) => r.nation), rows.map((r) => r.name), rows.map((r) => r.perEvent)]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}
