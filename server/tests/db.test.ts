// Loads the sample events into a real Postgres and exercises the API.
// Runs only when TEST_DATABASE_URL points at a disposable database (it drops
// and recreates the public schema), e.g.
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/shorttrack_test npm test

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { createPool } from '../src/db/pool.js';
import { Ingest } from '../src/db/ingest.js';
import { OLYMPICS, WORLDS, WT1_2025, WT1_2026, tree } from './fixtures.js';

const url = process.env.TEST_DATABASE_URL;
const MIGRATION = path.resolve(import.meta.dirname, '../../supabase/migrations/0001_init.sql');
// Mid-event in Vancouver: Men 1500 m QF Heat 5 was racing when the fixture was pulled.
const NOW = new Date('2026-10-23T23:45:00Z');

describe.skipIf(!url)('database + API', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await pool.query<T>(sql, params)).rows[0]!;

  beforeAll(async () => {
    pool = createPool(url);
    await pool.query('drop schema public cascade; create schema public;');
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    const ingest = new Ingest(pool);
    for (const slug of [WT1_2026, WT1_2025, OLYMPICS, WORLDS]) await ingest.loadTree(tree(slug));
    app = createApp(pool, { now: () => NOW });
  }, 120_000);

  afterAll(async () => { await pool?.end(); });

  it('loads a heat with its laps', async () => {
    const heat = await one<{ entries: number; laps: number }>(
      `select (select count(*) from entry en where en.heat_id = h.id)::int as entries,
              (select count(*) from lap l join entry en on en.id = l.entry_id where en.heat_id = h.id)::int as laps
       from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id join event e on e.id = c.event_id
       where e.slug = $1 and c.name = 'Men 1500 m' and r.name = 'Quarterfinals' and h.name = 'Heat 1'`, [WT1_2026]);
    expect(heat).toEqual({ entries: 7, laps: 6 * 14 });
  });

  it('is idempotent', async () => {
    const before = await one<{ n: number }>('select count(*)::int as n from lap');
    await new Ingest(pool).loadTree(tree(WT1_2026));
    expect(await one<{ n: number }>('select count(*)::int as n from lap')).toEqual(before);
  });

  it('builds schedules from ISU, from names, and from round times', async () => {
    const counts = await pool.query<{ slug: string; items: number; linked: number; source: string }>(
      `select e.slug, count(*)::int as items, count(si.round_id)::int as linked, min(si.source::text) as source
       from schedule_item si join event e on e.id = si.event_id group by e.slug`);
    const by = Object.fromEntries(counts.rows.map((r) => [r.slug, r]));
    expect(by[WT1_2026]).toMatchObject({ items: 52, linked: 52, source: 'isu' });
    expect(by[OLYMPICS]!.linked).toBe(by[OLYMPICS]!.items); // matched on "Women's 500m" + "Heats"
    expect(by[WT1_2025]).toMatchObject({ source: 'derived' }); // ISU has no schedule for it
  });

  it('GET /events/:slug/schedule groups the running order by venue day', async () => {
    const res = await request(app).get(`/events/${WT1_2026}/schedule`).expect(200);
    expect(res.body.days.map((d: { label: string }) => d.label)).toEqual(['Fri 23', 'Sat 24', 'Sun 25']);
    const fri = res.body.days[0];
    expect(fri.items).toHaveLength(13);
    expect(fri.live).toBe(true);
    expect(fri.items[10]).toMatchObject({ venueTime: '16:41', title: 'Men 1500 m', round: 'Quarterfinals', state: 'live', liveDetail: 'Heat 5 of 7' });
  });

  it('GET /rounds/:id has the places card, the live heat and start lists', async () => {
    const { id } = await one<{ id: number }>(
      `select r.id from round r join competition c on c.id = r.competition_id join event e on e.id = c.event_id
       where e.slug = $1 and c.name = 'Men 1500 m' and r.name = 'Quarterfinals'`, [WT1_2026]);
    const res = await request(app).get(`/rounds/${id}`).expect(200);
    const body = res.body;
    expect(body.places.qualified).toMatchObject({ count: 8, total: 14 });
    expect(body.places.time).toMatchObject({ filled: 4, total: 5, note: '1 spot open' });
    expect(body.progress).toEqual({ finished: 4, total: 7, running: 5 });
    const live = body.heats.find((h: { state: string }) => h.state === 'running');
    expect(live.name).toBe('Heat 5');
    expect(live.lap).toEqual({ current: 3, total: 14 });
    expect(live.entries[0]).toMatchObject({ rank: 1, last: 'Pigeon', iso2: 'PL', lastLap: '11.210', time: null });
    expect(body.heats[0]).toMatchObject({ name: 'Heat 1', state: 'official', sanctions: '1 PEN' });
    // Moon (third, "p") is still waiting on time, so he isn't listed as qualified yet.
    expect(body.heats[0].qualified.map((q: { last: string }) => q.last)).toEqual(['Nadalini', 'Lee']);
    expect(body.siblings.find((s: { current: boolean }) => s.current).name).toBe('Quarterfinals');
  });

  it('GET /heats/:id has results, the chart, lap table and summary', async () => {
    const { id } = await one<{ id: number }>(
      `select h.id from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id join event e on e.id = c.event_id
       where e.slug = $1 and c.name = 'Men 1500 m' and r.name = 'Quarterfinals' and h.name = 'Heat 1'`, [WT1_2026]);
    const { body } = await request(app).get(`/heats/${id}`).expect(200);
    expect(body.results.map((r: { last: string }) => r.last)).toEqual(['Nadalini', 'Lee', 'Moon', 'Antonioli', 'Song', 'Bozdag', 'Pelletier']);
    expect(body.results[1]).toMatchObject({ time: '2:19.315', gap: '+0.317', badge: 'Q' });
    expect(body.results[6]).toMatchObject({ rank: null, status: 'PEN', time: 'PEN' });
    expect(body.summary[0]).toBe('Nadalini took the lead on lap 8 and led the last 7 laps.');
    expect(body.chart).toMatchObject({ laps: 14, winner: 'Nadalini', climber: 'Moon' });
    expect(body.lapTable.rows[7].cells[0]).toEqual({ time: '8.640', best: false, fastest: true });
    expect(body.notes[0]).toMatch(/^Pelletier \(CAN\) was penalized/);
  });

  it('GET /seasons/2026-2027/events shows the live event and what is on the ice', async () => {
    const { body } = await request(app).get('/seasons/2026-2027/events').expect(200);
    expect(body.live).toMatchObject({ slug: WT1_2026, day: 1, days: 3, iso2: 'CA' });
    expect(body.live.onTheIce).toMatchObject({ competition: 'Men 1500 m', round: 'Quarterfinals', heat: 'Heat 5 of 7', lap: 'Lap 3 of 14' });
  });

  it('answers 304 when nothing changed', async () => {
    const first = await request(app).get(`/events/${WT1_2026}/schedule`).expect(200);
    await request(app).get(`/events/${WT1_2026}/schedule`).set('If-None-Match', first.headers.etag!).expect(304);
  });
});
