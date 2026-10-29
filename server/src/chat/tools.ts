// The data tools the Ask model can call. Each returns JSON for the model and
// a short line the app shows while it works ("Searched athletes for “van”").

import type pg from 'pg';
import { Athletes } from '../api/athletes.js';
import { Repo } from '../api/repo.js';
import { heatView } from '../api/views.js';
import { shortEventName } from '../domain/format.js';

export interface ToolResult {
  /** What the model reads. */
  data: unknown;
  /** One line for the app, e.g. "Looked up 500 m A finals since Oct 2025". */
  step: string;
}

type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

const SCHEMA = `Tables (Postgres):
- season(id, title)  -- title like '2025/2026'
- event(id, slug, name, series, city, country_code, starts_on date, ends_on date, season_id, state)  -- junior events have 'Junior' in name
- competition(id, event_id, name, gender ['Men','Women','Mixed'], distance_m, is_relay)  -- e.g. 'Men 500 m', "Women's 1000m" (Olympics)
- round(id, competition_id, name, starts_at)  -- 'Heats', 'Quarterfinals', 'Semifinals', 'Finals', 'Rep. Heats', ...
- heat(id, round_id, name, starts_at, state)  -- name 'Heat 3', 'Final A', 'Final B', 'Final' (single final), 'Semifinal 2' (Olympics)
- entry(id, heat_id, skater_id, team_id, nation, rank, time_ms, time_text, status, qualification)  -- one skater or relay team in one heat; rank null if penalized (status 'PEN'), DNS, DNF, YC, RC
- skater(id, first_name, last_name, gender ['M','F'], nation)
- relay_team(id, name, nation); relay_member(entry_id, skater_id)  -- skaters in a relay entry
- lap(entry_id, lap_no, lap_ms, position)
- nation(code, name, iso2)  -- IOC codes: CAN, KOR, NED
- standing(id, season_id, kind ['overall','distance','nations'], gender ['Men','Women','Mixed'], distance ['500','1000','1500','relay','mixed' or null], name, events jsonb)  -- ISU standings per season since 2019/20 (World Tour from 2024/25, World Cup before; 2019/20–2021/22 have no overall); overall = Crystal Globe
- standing_entry(standing_id, rank, points, skater_id, nation, name, per_event int[])  -- skater_id null for relay teams and nations
Conventions: an A final is heat.name in ('Final', 'Final A'); medals are ranks 1-3 in an A final. Times: time_ms (number) and time_text ('40.064', '1:24.537').`;

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_athletes',
      description: 'Find skaters by any part of their name. Returns ids for the other tools and for links.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string', description: 'Part of a first or last name, e.g. "sarault"' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'athlete_races',
      description: "An athlete's races (relays included), newest first, with event, distance, round, place, time and the heat id. Use after search_athletes.",
      parameters: {
        type: 'object', additionalProperties: false, required: ['athlete_id'],
        properties: {
          athlete_id: { type: 'integer' },
          season: { type: 'string', description: "e.g. '2025/2026'" },
          event_slug: { type: 'string' },
          distance: { type: 'string', enum: ['500', '1000', '1500', 'relay'] },
          oldest_first: { type: 'boolean' },
          limit: { type: 'integer', description: 'Up to 100; default 50' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_events',
      description: 'Events (World Tour, Championships, Olympics, junior events) with slug, city and dates.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { season: { type: 'string', description: "e.g. '2025/2026'; omit for all seasons" } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'event_finals',
      description: 'Every final (A, B, or a single final) of one event, with full results and heat ids.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['event_slug'],
        properties: { event_slug: { type: 'string' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'heat_results',
      description: 'One race in detail: results, times, gaps, penalties and facts from the lap data.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['heat_id'],
        properties: { heat_id: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_sql',
      description: `Run one read-only SELECT for counts, rankings and comparisons the other tools can't answer. At most 200 rows come back; select ids (skater.id, heat.id) so you can link them.\n${SCHEMA}`,
      parameters: {
        type: 'object', additionalProperties: false, required: ['sql', 'purpose'],
        properties: {
          sql: { type: 'string', description: 'A single SELECT (or WITH ... SELECT) statement' },
          purpose: { type: 'string', description: "Shown to the user while it runs, e.g. 'Looked up 500 m A finals since Oct 2025'" },
        },
      },
    },
  },
];

export class ChatTools {
  private readonly athletes: Athletes;
  private readonly repo: Repo;

  constructor(private readonly pool: pg.Pool) {
    this.athletes = new Athletes(pool);
    this.repo = new Repo(pool);
  }

  async run(name: string, args: Args): Promise<ToolResult> {
    switch (name) {
      case 'search_athletes': return this.searchAthletes(args);
      case 'athlete_races': return this.athleteRaces(args);
      case 'list_events': return this.listEvents(args);
      case 'event_finals': return this.eventFinals(args);
      case 'heat_results': return this.heatResults(args);
      case 'run_sql': return this.runSql(args);
      default: return { data: { error: `Unknown tool ${name}` }, step: 'Looked something up' };
    }
  }

  private async searchAthletes(args: Args): Promise<ToolResult> {
    const query = str(args.query) ?? '';
    const results = query.length >= 2 ? await this.athletes.search(query, 10) : [];
    return { data: results, step: `Searched athletes for “${query}”` };
  }

  private async athleteRaces(args: Args): Promise<ToolResult> {
    const id = int(args.athlete_id);
    const athlete = id ? await this.athletes.athlete(id) : null;
    if (!id || !athlete) return { data: { error: 'Unknown athlete id' }, step: 'Looked up an athlete' };
    const page = await this.athletes.races(id, {
      season: str(args.season), event: str(args.event_slug), distance: str(args.distance),
    }, { sort: args.oldest_first === true ? 'asc' : 'desc', limit: Math.min(int(args.limit) ?? 50, 100) });
    return {
      data: {
        athlete: athlete.athlete, stats: athlete.stats, bests: athlete.bests, totalMatching: page.total,
        races: page.races.map((r) => ({
          heatId: r.heatId, season: r.season, event: r.event.name, eventSlug: r.event.slug, city: r.event.city, day: r.day,
          distance: r.distance, round: r.round, rank: r.rank, time: r.time, status: r.status, qualification: r.badge,
          medal: r.medal, relayTeam: r.team,
        })),
      },
      step: `Looked up ${athlete.athlete.name}’s races`,
    };
  }

  private async listEvents(args: Args): Promise<ToolResult> {
    const season = str(args.season);
    const res = await this.pool.query(
      `select e.slug, e.name, e.series, e.city, n.name as country, to_char(e.starts_on, 'YYYY-MM-DD') as starts_on,
         to_char(e.ends_on, 'YYYY-MM-DD') as ends_on, e.state, s.title as season
       from event e join season s on s.id = e.season_id left join nation n on n.code = e.country_code
       where $1::text is null or s.title = $1 order by e.starts_on`, [season]);
    return {
      data: res.rows.map((r) => ({ ...r, shortName: shortEventName(r.name) })),
      step: season ? `Looked up the ${season} events` : 'Looked up the events',
    };
  }

  private async eventFinals(args: Args): Promise<ToolResult> {
    const slug = str(args.event_slug);
    const res = await this.pool.query<{
      event: string; competition: string; heat_id: number; heat: string; rank: number | null; name: string;
      athlete_id: number | null; nation: string | null; time_text: string | null; status: string | null;
    }>(
      `select e.name as event, c.name as competition, h.id as heat_id, h.name as heat, en.rank,
         coalesce(s.first_name || ' ' || s.last_name, s.last_name, t.name) as name, s.id as athlete_id,
         en.nation, en.time_text, en.status
       from event e join competition c on c.event_id = e.id join round r on r.competition_id = c.id
       join heat h on h.round_id = r.id join entry en on en.heat_id = h.id
       left join skater s on s.id = en.skater_id left join relay_team t on t.id = en.team_id
       where e.slug = $1 and h.name ilike 'final%'
       order by c.display_order nulls last, c.name, h.name, en.rank nulls last`, [slug]);
    if (!res.rows.length) return { data: { error: 'No finals found for that event slug' }, step: 'Looked up an event' };
    const finals = new Map<number, { competition: string; heat: string; heatId: number; results: unknown[] }>();
    for (const r of res.rows) {
      const f = finals.get(r.heat_id) ?? { competition: r.competition, heat: r.heat, heatId: r.heat_id, results: [] };
      f.results.push({ rank: r.rank, name: r.name, athleteId: r.athlete_id, nation: r.nation, time: r.time_text, status: r.status });
      finals.set(r.heat_id, f);
    }
    const event = shortEventName(res.rows[0]!.event);
    return { data: { event, finals: [...finals.values()] }, step: `Looked up the finals at ${event}` };
  }

  private async heatResults(args: Args): Promise<ToolResult> {
    const id = int(args.heat_id);
    const heat = id ? await this.repo.heat(id) : null;
    const round = heat ? await this.repo.round(heat.round_id) : null;
    if (!heat || !round) return { data: { error: 'Unknown heat id' }, step: 'Looked up a race' };
    const view = heatView(round, heat, await this.repo.entriesForHeat(heat.id), await this.repo.lapsForHeat(heat.id));
    return {
      data: {
        heatId: heat.id, event: shortEventName(view.heat.event), competition: view.heat.competition, round: view.heat.round,
        heat: view.heat.name, state: view.heat.state,
        results: view.results.map((e) => ({
          rank: e.rank, name: e.name, athleteId: e.athleteId, nation: e.nat, time: e.time, gap: e.gap, status: e.status, qualification: e.badge,
        })),
        summary: view.summary, notes: view.notes,
      },
      step: `Looked up ${view.heat.competition} ${view.heat.round === 'Finals' ? '' : `${view.heat.round} `}${view.heat.name}`,
    };
  }

  /** Model-written SQL: one SELECT, read-only transaction, as chat_reader, 5 s, 200 rows. */
  private async runSql(args: Args): Promise<ToolResult> {
    const step = str(args.purpose) ?? 'Looked up results';
    const sql = (str(args.sql) ?? '').replace(/;\s*$/, '');
    if (!/^(select|with)\b/i.test(sql) || sql.includes(';')) {
      return { data: { error: 'Only one SELECT statement is allowed.' }, step };
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin read only');
      await client.query("set local statement_timeout = '5s'");
      await client.query('set local role chat_reader');
      const res = await client.query(`select * from (${sql}) as q limit 200`);
      return { data: { rows: res.rows, rowCount: res.rowCount, truncated: res.rowCount === 200 }, step };
    } catch (err) {
      return { data: { error: (err as Error).message }, step };
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  }
}
