// What happens when ISU changes or drops what it sent before, and when one
// event's data is bad. Like db.test.ts, runs only with TEST_DATABASE_URL (it
// drops and recreates the public schema).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { createPool } from '../src/db/pool.js';
import { Ingest } from '../src/db/ingest.js';
import type { IsuClient } from '../src/isu/client.js';
import type { EventTree, IsuEvent, IsuHeat } from '../src/isu/types.js';
import type { PushMessage } from '../src/push/apns.js';
import { PushDevices } from '../src/push/devices.js';
import { SyncWorker } from '../src/sync/worker.js';
import { WT1_2025, WT1_2026, tree } from './fixtures.js';

const url = process.env.TEST_DATABASE_URL;
const MIGRATIONS = path.resolve(import.meta.dirname, '../../supabase/migrations');
// Mid-event in Vancouver: Men 1500 m QF Heat 5 was racing when the fixture was pulled.
const NOW = new Date('2026-10-23T23:45:00Z');

type Heats = EventTree['competitions'][number]['rounds'][number]['heats'];

/** The same heats as ISU sends them after renumbering every competitor (and, optionally, the heats). */
function renumbered(heats: Heats, opts: { heats?: boolean } = {}): Heats {
  return structuredClone(heats).map((h) => ({
    ...h,
    event_result_round_heats_id: h.event_result_round_heats_id + (opts.heats ? 9_000_000 : 0),
    event_result_round_heats_competitors: (h.event_result_round_heats_competitors ?? []).map((c) => ({
      ...c, event_result_round_heats_competitors_id: c.event_result_round_heats_competitors_id + 9_000_000,
    })),
  }));
}

describe.skipIf(!url)('when ISU changes what it sent before', () => {
  let pool: pg.Pool;
  let accountId: number;
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await pool.query<T>(sql, params)).rows[0]!;
  const heatsOf = (t: EventTree, comp: string, rnd: string) =>
    t.competitions.find((c) => c.name === comp)!.rounds.find((r) => r.name === rnd)!;
  /** Our heat row for an ISU heat. */
  const heatRow = (isuId: number) => one<{ id: number; round_id: number }>('select id, round_id from heat where isu_id = $1', [isuId]);
  /** Skater (or relay nation) per entry id. */
  const racers = async (entryIds: number[]) => {
    const rows = (await pool.query<{ id: string; who: string }>(
      `select id, coalesce(skater_id::text, nation) as who from entry where id = any($1::bigint[])`, [entryIds])).rows;
    const by = new Map(rows.map((r) => [Number(r.id), r.who]));
    return entryIds.map((id) => by.get(id) ?? null);
  };
  const pickOf = async (heatId: number) => {
    const p = (await pool.query<{ finish: string[]; penalized: string[]; advanced: string[] }>(
      'select finish, penalized, advanced from pick where account_id = $1 and heat_id = $2', [accountId, heatId])).rows[0];
    return p && { finish: p.finish.map(Number), penalized: p.penalized.map(Number), advanced: p.advanced.map(Number) };
  };
  /** Picks every entry of a heat in start order, the last penalized and the first advanced. */
  const pickAll = async (heatId: number) => {
    const ids = (await pool.query<{ id: string }>('select id from entry where heat_id = $1 order by start_position, id', [heatId]))
      .rows.map((r) => Number(r.id));
    await pool.query(
      `insert into pick (account_id, heat_id, finish, penalized, advanced) values ($1, $2, $3, $4, $5)
       on conflict (account_id, heat_id) do update set finish = excluded.finish, penalized = excluded.penalized, advanced = excluded.advanced`,
      [accountId, heatId, ids.slice(0, -1), ids.slice(-1), ids.slice(0, 1)]);
    return { finish: ids.slice(0, -1), penalized: ids.slice(-1), advanced: ids.slice(0, 1) };
  };

  beforeAll(async () => {
    pool = createPool(url);
    await pool.query('drop schema public cascade; create schema public;');
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await pool.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
    await new Ingest(pool).loadTree(tree(WT1_2026));
    accountId = (await one<{ id: number }>(
      `insert into account (google_sub, email, name, nickname) values ('changes', 'changes@example.com', 'Changes', 'Changes') returning id`)).id;
  }, 120_000);

  afterAll(async () => { await pool?.end(); });

  /** A session for the test account, through the API's own sign-in. */
  const session = async () => {
    const app = createApp(pool, { now: () => NOW, google: async () => ({ sub: 'changes', email: 'changes@example.com', name: 'Changes' }) });
    return (await request(app).post('/auth/google').send({ idToken: 'changes' }).expect(200)).body.session as string;
  };

  describe('picks', () => {
    it('follow their skaters when ISU renumbers a heat\'s entries', async () => {
      // Men 1500 m QF Heat 7: a start list, two races after the one racing.
      const qf = heatsOf(tree(WT1_2026), 'Men 1500 m', 'Quarterfinals');
      const heat = await heatRow(qf.heats[6]!.event_result_round_heats_id);
      const before = await pickAll(heat.id);
      const who = { finish: await racers(before.finish), penalized: await racers(before.penalized), advanced: await racers(before.advanced) };

      await new Ingest(pool).loadRoundHeats(qf.event_result_round_id, renumbered(qf.heats), false);

      const after = (await pickOf(heat.id))!;
      expect(after.finish).not.toEqual(before.finish); // the old entries are gone...
      expect(await racers(before.finish)).toEqual(before.finish.map(() => null));
      // ...and the pick names the same skaters, in the same order.
      expect({ finish: await racers(after.finish), penalized: await racers(after.penalized), advanced: await racers(after.advanced) }).toEqual(who);
      // It still scores against the heat's entries.
      const view = (await request(createApp(pool, { now: () => NOW })).get(`/picks/heats/${heat.id}`)
        .set('X-Session', await session()).expect(200)).body;
      expect(view.myPick).toEqual(after);
      expect(view.entries.map((e: { entryId: number }) => e.entryId)).toEqual(expect.arrayContaining(after.finish));
    });

    it('follow relay teams too', async () => {
      const qf = heatsOf(tree(WT1_2026), 'Men 5000 m Relay', 'Quarterfinals');
      const heat = await heatRow(qf.heats[0]!.event_result_round_heats_id);
      const before = await pickAll(heat.id);
      const nations = await racers(before.finish);
      await new Ingest(pool).loadRoundHeats(qf.event_result_round_id, renumbered(qf.heats), true);
      const after = (await pickOf(heat.id))!;
      expect(after.finish).not.toEqual(before.finish);
      expect(await racers(after.finish)).toEqual(nations);
    });

    it('move to the heat that replaced theirs when ISU renumbers a heat', async () => {
      const t = tree(WT1_2026);
      const qf = heatsOf(t, 'Mixed Team Relay', 'Quarterfinals');
      const old = await heatRow(qf.heats[1]!.event_result_round_heats_id);
      await pickAll(old.id);
      const who = await racers((await pickOf(old.id))!.finish);

      qf.heats = renumbered(qf.heats, { heats: true });
      await new Ingest(pool).loadTree(t);

      expect((await pool.query('select 1 from heat where id = $1', [old.id])).rowCount).toBe(0);
      const replacement = await heatRow(qf.heats[1]!.event_result_round_heats_id);
      expect(replacement.round_id).toBe(old.round_id);
      const moved = (await pickOf(replacement.id))!;
      expect(await racers(moved.finish)).toEqual(who);
    });
  });

  describe('a heat ISU stops listing', () => {
    // A skater in the next real heat to race, and that heat.
    const nextHeat = () => one<{ heat_id: number; round_id: number; skater_id: number }>(
      `select h.id as heat_id, h.round_id, en.skater_id from heat h join round r on r.id = h.round_id
       join competition c on c.id = r.competition_id join event e on e.id = c.event_id join entry en on en.heat_id = h.id
       where e.slug = $1 and h.state in ('scheduled', 'start_list') and en.skater_id is not null and not c.is_relay
       order by h.starts_at, h.run_order nulls last, h.id, en.id limit 1`, [WT1_2026]);
    const upNext = async (skaterId: number, heatId: number) => {
      const { races } = (await request(createApp(pool, { now: () => NOW })).get('/favorites/races')
        .query({ skaters: String(skaterId) }).expect(200)).body as { races: { heatId: number; upNext: boolean }[] };
      return races.find((r) => r.heatId === heatId)?.upNext;
    };

    it('stops blocking "up next" once ISU drops it', async () => {
      const next = await nextHeat();
      expect(await upNext(next.skater_id, next.heat_id)).toBe(true);

      // ISU briefly lists an extra start list in that round, due an hour ago, then drops it.
      const { isu_id: roundIsuId } = await one<{ isu_id: number }>('select isu_id from round where id = $1', [next.round_id]);
      const rnd = tree(WT1_2026).competitions.flatMap((c) => c.rounds).find((r) => r.event_result_round_id === roundIsuId)!;
      const listed = rnd.heats.find((h) => h.result_status === 'Start List') ?? rnd.heats[0]!;
      const ghost: IsuHeat = {
        ...renumbered([listed], { heats: true })[0]!, name: 'Heat 99', display_order: 99, status: 'Scheduled', result_status: 'Start List',
        date: '2026-10-23T12:00:00.000Z', // hours ago, read as UTC or as Vancouver time
      };
      const ingest = new Ingest(pool);
      await ingest.loadRoundHeats(roundIsuId, [...rnd.heats, ghost], false);
      const ghostRow = await heatRow(ghost.event_result_round_heats_id);
      expect(ghostRow).toBeDefined();
      expect(await upNext(next.skater_id, next.heat_id)).toBe(false); // the bug: the stale heat is "next"

      await ingest.loadRoundHeats(roundIsuId, rnd.heats, false);
      expect((await pool.query('select 1 from heat where id = $1', [ghostRow.id])).rowCount).toBe(0);
      expect(await upNext(next.skater_id, next.heat_id)).toBe(true);
    });

    it('drops rounds and competitions ISU stops listing, but keeps official results', async () => {
      const t = tree(WT1_2026);
      // A distance still to come (no heat raced yet), and one with official results.
      const upcoming = t.competitions.find((c) => c.rounds.every((r) => r.heats.every((h) => h.result_status !== 'Official')))!;
      const raced = t.competitions.find((c) => c.rounds.some((r) => r.heats.some((h) => h.result_status === 'Official')))!;
      const lastRound = upcoming.rounds.at(-1)!;
      upcoming.rounds = upcoming.rounds.slice(0, -1);
      await new Ingest(pool).loadTree(t);
      expect((await pool.query('select 1 from round where isu_id = $1', [lastRound.event_result_round_id])).rowCount).toBe(0);

      t.competitions = t.competitions.filter((c) => c !== upcoming && c !== raced);
      await new Ingest(pool).loadTree(t);
      expect((await pool.query('select 1 from competition where isu_id = $1', [upcoming.event_result_id])).rowCount).toBe(0);
      // The raced one keeps its official heats (and so its rounds); its unraced heats go.
      const left = await one<{ official: number; other: number }>(
        `select count(*) filter (where h.state = 'official')::int as official, count(*) filter (where h.state <> 'official')::int as other
         from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id where c.isu_id = $1`, [raced.event_result_id]);
      expect(left.official).toBeGreaterThan(0);
      expect(left.other).toBe(0);

      // A response that's clearly partial (most of the event missing) changes nothing.
      const before = await one<{ n: number }>('select count(*)::int as n from competition');
      const partial = tree(WT1_2026);
      partial.competitions = partial.competitions.slice(0, 1);
      await new Ingest(pool).loadTree(partial);
      expect(await one<{ n: number }>('select count(*)::int as n from competition')).toEqual(before);

      await new Ingest(pool).loadTree(tree(WT1_2026)); // back to the full event for the tests below
    });
  });

  describe('sync worker', () => {
    const logs: string[] = [];
    let pushes = 0;
    const event = (t: EventTree): IsuEvent => t.event;

    /** A stand-in for ISU: Vancouver live, plus finished events, one of which ISU sends broken. */
    function fakeIsu(opts: { events: IsuEvent[]; trees: Record<string, EventTree>; failRound?: number }): IsuClient {
      const live = tree(WT1_2026);
      return {
        requests: 0, recording: false,
        seasons: async () => [{ title: '2026/2027', is_current: 1 }],
        events: async () => opts.events,
        pullEvent: async (ev: IsuEvent) => opts.trees[ev.slug]!,
        heats: async (_comp: number, roundId: number) => {
          if (roundId === opts.failRound) throw new Error('ISU sent garbage');
          return live.competitions.flatMap((c) => c.rounds).find((r) => r.event_result_round_id === roundId)?.heats ?? [];
        },
        competitions: async () => live.competitions,
        rounds: async (compId: number) => live.competitions.find((c) => c.event_result_id === compId)?.rounds ?? [],
        schedule: async () => live.schedule,
        standingLists: async () => [],
      } as unknown as IsuClient;
    }
    const worker = (isu: IsuClient) => new SyncWorker(isu, pool, (m) => logs.push(m), {
      push: { enabled: true, sendDue: async () => { pushes++; return 0; } } as unknown as PushDevices,
    });

    beforeEach(() => { logs.length = 0; pushes = 0; });

    it('keeps going when one finished event fails to load, and still polls and pushes the live one', async () => {
      const good = tree(WT1_2025);
      const broken = tree(WT1_2025);
      broken.event = { ...broken.event, slug: 'broken-event', id: '999999', event_id: '999999', api_id: null, name: 'Broken' };
      // A competition without its rounds: ingest throws on it.
      broken.competitions = [{ ...broken.competitions[0]!, rounds: undefined as unknown as [] }];
      const running = await one<{ isu_id: number }>(
        `select r.isu_id from heat h join round r on r.id = h.round_id where h.state = 'running' limit 1`);

      await worker(fakeIsu({
        events: [event(broken), event(good)], trees: { 'broken-event': broken, [WT1_2025]: good }, failRound: running.isu_id,
      })).tick(NOW.getTime());

      expect(logs.some((l) => l.startsWith('Broken:'))).toBe(true);
      expect(logs.some((l) => l.startsWith(`round ${running.isu_id}:`))).toBe(true);
      // The good event after the broken one loaded, and the live event's pushes still went.
      expect((await one<{ synced: boolean }>('select synced_at is not null as synced from event where slug = $1', [WT1_2025])).synced).toBe(true);
      expect(pushes).toBe(1);
    });

    it('backfills past an event ISU sends malformed', async () => {
      const good = { ...tree(WT1_2026).event, slug: 'coming-up', id: '888888', event_id: '888888', api_id: null, state: 'On' };
      const bad = { ...good, slug: 'malformed', id: '777777', event_id: '777777', season: undefined as unknown as string };
      await worker(fakeIsu({ events: [bad, good], trees: {} })).backfill(['2026/2027']);
      expect(logs.some((l) => l.includes('skipped'))).toBe(true);
      expect((await pool.query('select 1 from event where slug = $1', ['coming-up'])).rowCount).toBe(1);
    });
  });

  describe('"Picks are open"', () => {
    it('comes once per round, even when a round has more open races than the app lists', async () => {
      const token = '9f'.repeat(32);
      await pool.query('delete from pick where account_id = $1', [accountId]);
      // Women 500 m QF start lists for tomorrow (cloned from the heats): with
      // the relay quarterfinals ahead of them, more than the app's 12 open races.
      const t = tree(WT1_2026);
      const from = heatsOf(t, 'Women 500 m', 'Heats');
      const qf = heatsOf(t, 'Women 500 m', 'Quarterfinals');
      const startLists = renumbered(from.heats, { heats: true }).map((h, i) => ({
        ...h, status: 'Scheduled', result_status: 'Start List', date: `2026-10-24T12:${String(i * 4).padStart(2, '0')}:00.000Z`,
        event_result_round_heats_competitors: (h.event_result_round_heats_competitors ?? []).map((c) => ({
          ...c, final_rank: null, final_result: '', result_status: '', qualification_code: '', record_flag: '', lap: null,
        })),
      })) as Heats;
      await new Ingest(pool).loadRoundHeats(qf.event_result_round_id, startLists, false);
      const app = createApp(pool, { now: () => NOW });
      const open = (await request(app).get('/picks').set('X-Session', await session()).expect(200)).body.open as { round: string; title: string }[];
      expect(open).toHaveLength(12);
      expect(open.filter((o) => o.title === 'Women 500 m').length).toBeGreaterThan(0);
      expect(open.filter((o) => o.title === 'Women 500 m').length).toBeLessThan(8);
      // Registered directly, so nothing counts as already sent.
      await pool.query(
        `insert into push_device (token, environment, notify_starts, notify_results, notify_picks, account_id)
         values ($1, 'sandbox', false, false, true, $2)`, [token, accountId]);
      const sends: PushMessage[] = [];
      const push = new PushDevices(pool, { send: async (_t, _e, message) => { sends.push(message); return 'ok'; } }, () => {});
      // Through the evening: earlier races lock, later ones (and more of each round) come into view.
      for (let minutes = 0; minutes <= 240; minutes += 10) await push.sendDue(new Date(NOW.getTime() + minutes * 60_000));

      const titles = sends.map((m) => (m.payload as { aps: { alert: { title: string } } }).aps.alert.title);
      expect(titles.length).toBeGreaterThan(1);
      expect(titles.every((t) => t.startsWith('Picks are open: '))).toBe(true);
      expect(new Set(titles).size).toBe(titles.length);
      expect(sends.every((m) => /^picks-round-\d+$/.test(m.collapseId ?? ''))).toBe(true);
    });
  });
});
