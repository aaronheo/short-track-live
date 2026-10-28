// Loads the sample events into a real Postgres and exercises the API.
// Runs only when TEST_DATABASE_URL points at a disposable database (it drops
// and recreates the public schema), e.g.
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/shorttrack_test npm test

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { createPool } from '../src/db/pool.js';
import { Ingest } from '../src/db/ingest.js';
import { OLYMPICS, WORLDS, WT1_2025, WT1_2026, tree } from './fixtures.js';

const url = process.env.TEST_DATABASE_URL;
const MIGRATIONS = path.resolve(import.meta.dirname, '../../supabase/migrations');
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
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await pool.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
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

  it('starts each round with its first heat (ISU round dates are local time in 2025/26 data)', async () => {
    const off = await one<{ n: number }>(
      `select count(*)::int as n from round r
       where r.starts_at is distinct from (select min(h.starts_at) from heat h where h.round_id = r.id)
         and exists (select 1 from heat h where h.round_id = r.id and h.starts_at is not null)`);
    expect(off.n).toBe(0);
    // WT1 2025 Montréal has no ISU schedule; the derived one starts with the
    // first heat (Men 500 m Preliminaries, raced at 07:23:58 local).
    const { body } = await request(app).get(`/events/${WT1_2025}/schedule`).expect(200);
    expect(body.event.timeZone).toBe('America/Toronto');
    expect(body.days[0].items[0]).toMatchObject({ venueTime: '07:23', title: 'Men 500 m', round: 'Preliminaries' });
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
    expect(body.chart).toMatchObject({ laps: 14, winner: 'NAD', climber: 'MOO' });
    expect(body.chart.series.map((x: { code: string }) => x.code)).toEqual(['NAD', 'LEE', 'MOO', 'ANT', 'SON', 'BOZ']);
    expect(body.lapTable.rows[7].cells[0]).toEqual({ time: '8.640', best: false, fastest: true });
    expect(body.notes[0]).toMatch(/^Pelletier \(CAN\) was penalized/);
  });

  it('GET /seasons/2026-2027/events shows the live event and what is on the ice', async () => {
    const { body } = await request(app).get('/seasons/2026-2027/events').expect(200);
    expect(body.live).toMatchObject({ slug: WT1_2026, day: 1, days: 3, iso2: 'CA' });
    expect(body.live.onTheIce).toMatchObject({ competition: 'Men 1500 m', round: 'Quarterfinals', heat: 'Heat 5 of 7', lap: 'Lap 3 of 14' });
    const current = await request(app).get('/seasons/current/events').expect(200);
    expect(current.body.season).toBe('2026/2027');
  });

  it('requires the token when one is set, except for the health check', async () => {
    const locked = createApp(pool, { now: () => NOW, token: 'secret' });
    await request(locked).get('/health').expect(200);
    await request(locked).get('/seasons').expect(401);
    await request(locked).get('/seasons').set('Authorization', 'Bearer wrong').expect(401);
    await request(locked).get('/seasons').set('Authorization', 'Bearer secret').expect(200);
  });

  describe('athletes', () => {
    const jens = async () => {
      const { body } = await request(app).get('/athletes?q=van%20%27t%20wout').expect(200);
      return body.results.find((r: { name: string }) => r.name === "Jens Van 't Wout").id as number;
    };
    type Race = { entryId: number; startsAt: string; distance: string; season: string; team: string | null; medal: number | null };
    const all = async (id: number, query: string) => {
      const races: Race[] = [];
      let cursor: string | null = null;
      let total: number | null = null;
      do {
        const { body }: { body: { races: Race[]; nextCursor: string | null; total: number | null } } =
          await request(app).get(`/athletes/${id}/races?${query}&limit=7${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        total ??= body.total;
        races.push(...body.races);
        cursor = body.nextCursor;
      } while (cursor);
      return { races, total };
    };

    it('finds athletes by any part of the name, most races first', async () => {
      const { body } = await request(app).get('/athletes?q=van').expect(200);
      expect(body.results.map((r: { name: string }) => r.name)).toContain("Jens Van 't Wout");
      const races = body.results.map((r: { races: number }) => r.races);
      expect(races).toEqual([...races].sort((a: number, b: number) => b - a));
      expect((await request(app).get('/athletes?q=v').expect(200)).body.results).toEqual([]);
      expect((await request(app).get('/athletes?q=%25').expect(200)).body.results).toEqual([]);
    });

    it('pages through every race once, newest first, and oldest first reversed', async () => {
      const id = await jens();
      const desc = await all(id, 'sort=desc');
      expect(desc.races).toHaveLength(desc.total!);
      expect(new Set(desc.races.map((r) => r.entryId)).size).toBe(desc.total);
      const times = desc.races.map((r) => r.startsAt);
      expect(times).toEqual([...times].sort().reverse());
      const asc = await all(id, 'sort=asc');
      expect(asc.races.map((r) => r.entryId)).toEqual(desc.races.map((r) => r.entryId).reverse());
      expect(desc.races.some((r) => r.team)).toBe(true); // relays count
    });

    it('filters by distance, season and event, with counts for each option', async () => {
      const id = await jens();
      const { body } = await request(app).get(`/athletes/${id}/races`).expect(200);
      const thousand = body.facets.distances.find((d: { value: string }) => d.value === '1000');
      const only1000 = await all(id, 'distance=1000');
      expect(only1000.races.every((r) => r.distance === '1000 m')).toBe(true);
      expect(only1000.total).toBe(thousand.count);
      const relays = await all(id, 'distance=relay');
      expect(relays.races.every((r) => r.team)).toBe(true);
      const season = await all(id, 'season=2025-2026&distance=1000');
      expect(season.races.every((r) => r.season === '2025/2026' && r.distance === '1000 m')).toBe(true);
      const first = await request(app).get(`/athletes/${id}/races?event=${WORLDS}`).expect(200);
      expect(first.body.facets.events.length).toBeGreaterThan(1); // the event filter doesn't narrow its own menu
      expect(first.body.races.every((r: { event: { slug: string } }) => r.event.slug === WORLDS)).toBe(true);
    });

    it('sums medals from A finals and finds best times', async () => {
      const id = await jens();
      const { body } = await request(app).get(`/athletes/${id}`).expect(200);
      expect(body.athlete).toMatchObject({ name: "Jens Van 't Wout", nat: 'NED', iso2: 'NL', gender: 'Men' });
      const { races } = await all(id, 'sort=desc');
      expect(body.stats.races).toBe(races.length);
      expect(body.stats.gold).toBe(races.filter((r) => r.medal === 1).length);
      expect(body.bests.map((b: { distance: string }) => b.distance)).toEqual(['500 m', '1000 m', '1500 m']);
      await request(app).get('/athletes/999999').expect(404);
    });
  });

  it('GET /favorites/races has the next heat up and official results', async () => {
    // Men 1500 m QF Heat 5 is racing; the first heat still to race is up next.
    const next = await one<{ heat_id: number; skater_id: number }>(
      `select h.id as heat_id, en.skater_id
       from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id
       join event e on e.id = c.event_id join entry en on en.heat_id = h.id
       where e.slug = $1 and h.state in ('scheduled', 'start_list') and en.skater_id is not null
       order by h.starts_at, h.run_order nulls last, h.id, en.id limit 1`, [WT1_2026]);
    const search = await request(app).get('/athletes?q=van%20%27t%20wout').expect(200);
    const jens = search.body.results.find((r: { name: string }) => r.name === "Jens Van 't Wout").id as number;
    const { body } = await request(app).get(`/favorites/races?skaters=${next.skater_id},${jens},x`).expect(200);
    type Race = { heatId: number; upNext: boolean; skaters: number[]; start: { title: string }; result: { title: string; body: string } | null };
    const races = body.races as Race[];
    const upcoming = races.find((r) => r.heatId === next.heat_id)!;
    expect(upcoming).toMatchObject({ upNext: true, result: null, skaters: [next.skater_id] });
    expect(upcoming.start.title).toMatch(/ is up next$/);
    expect(races.filter((r) => r.upNext)).toHaveLength(1);
    // His 500 m heat earlier that evening is official.
    expect(races.find((r) => r.result?.title === "Jens Van 't Wout 1st in Heat 4")?.result?.body).toMatch(/^40\.699 · Qualified/);
    expect((await request(app).get('/favorites/races').expect(200)).body).toEqual({ races: [] });
  });

  it('GET /heats/:id lists who skated for each relay team', async () => {
    const heat = await one<{ id: number; team: string; n: number }>(
      `select h.id, t.name as team, count(rm.*)::int as n
       from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id
       join entry en on en.heat_id = h.id join relay_team t on t.id = en.team_id join relay_member rm on rm.entry_id = en.id
       where c.is_relay and h.state = 'official' group by h.id, t.name order by h.id limit 1`);
    const { body } = await request(app).get(`/heats/${heat.id}`).expect(200);
    const row = body.results.find((r: { name: string }) => r.name === heat.team);
    expect(row.members).toHaveLength(heat.n);
    expect(row.members[0]).toEqual({ id: expect.any(Number), name: expect.any(String), short: expect.any(String) });
  });

  it('GET /favorites/races counts a relay still to come for a skater who skated it for that team', async () => {
    // WT1 2026 relays are start lists without names; the skater raced that relay for the team at WT1 2025.
    const pick = await one<{ heat_id: number; skater_id: number; team: string }>(
      `select h.id as heat_id, rm.skater_id, t.name as team
       from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id join event e on e.id = c.event_id
       join entry en on en.heat_id = h.id join relay_team t on t.id = en.team_id
       join entry past on past.nation = en.nation and past.team_id is not null join relay_member rm on rm.entry_id = past.id
       join heat ph on ph.id = past.heat_id join round pr on pr.id = ph.round_id join competition pc on pc.id = pr.competition_id
       where e.slug = $1 and c.is_relay and h.state = 'start_list' and h.starts_at > $2 and pc.name = c.name
         and ph.starts_at > h.starts_at - interval '1 year'
       order by h.starts_at, h.id limit 1`, [WT1_2026, NOW]);
    const { body } = await request(app).get(`/favorites/races?skaters=${pick.skater_id}`).expect(200);
    const race = body.races.find((r: { heatId: number }) => r.heatId === pick.heat_id);
    expect(race.start.title).toBe(`${pick.team} is up next`);
    expect(race.start.body).toMatch(/’s team · /);
    expect(race.result).toBeNull();
  });

  it('GET /favorites/suggested lists the latest medalists', async () => {
    const { body } = await request(app).get('/favorites/suggested').expect(200);
    expect(body.event).toBe('World Championships');
    expect(body.skaters.length).toBeGreaterThanOrEqual(9);
    for (const s of body.skaters) expect(s.note).toMatch(/^(Gold|Silver|Bronze) \d/);
  });

  describe('accounts', () => {
    // Stands in for Google: "ok:<sub>:<name>" is a valid ID token.
    const signIn = () => createApp(pool, {
      now: () => NOW,
      google: async (idToken) => {
        const [ok, sub, name] = idToken.split(':');
        if (ok !== 'ok' || !sub) throw new Error('Bad token');
        return { sub, email: `${sub}@example.com`, name: name ?? null };
      },
    });
    const skaterId = async (last: string) => (await one<{ id: number }>('select id from skater where last_name = $1 limit 1', [last])).id;

    it('signs in with Google, saves favorites and settings, signs out and deletes', async () => {
      const api = signIn();
      expect((await request(app).post('/auth/google').send({ idToken: 'ok:a' }).expect(503)).body.error).toMatch(/isn’t set up/);
      await request(api).post('/auth/google').send({ idToken: 'forged' }).expect(401);
      await request(api).get('/me').expect(401);

      const first = (await request(api).post('/auth/google').send({ idToken: 'ok:g-123:Aaron Heo' }).expect(200)).body;
      expect(first).toMatchObject({ account: { name: 'Aaron Heo', email: 'g-123@example.com', provider: 'google' }, favorites: [], settings: {} });
      const session = first.session as string;
      expect(session).toMatch(/^[\w-]{43}$/);

      const velzeboer = await skaterId('Velzeboer');
      const sarault = await skaterId('Sarault');
      const put = await request(api).put('/me').set('X-Session', session).send({
        favorites: [
          { id: velzeboer, addedAt: '2026-10-20T10:00:00Z' },
          { id: sarault, addedAt: '2026-10-21T10:00:00Z' },
          { id: 999_999_999, addedAt: '2026-10-21T10:00:00Z' }, // not a skater: left out
        ],
        settings: { notifyStarts: false, notifyResults: true, appearance: 'dark', extra: 'dropped' },
      }).expect(200);
      expect(put.body.favorites.map((f: { last: string }) => f.last)).toEqual(['Velzeboer', 'Sarault']);
      expect(put.body.favorites[0]).toMatchObject({ id: velzeboer, name: 'Xandra Velzeboer', nat: 'NED', iso2: 'NL', gender: 'Women', addedAt: '2026-10-20T10:00:00.000Z' });
      expect(put.body.settings).toEqual({ notifyStarts: false, notifyResults: true, appearance: 'dark' });
      await request(api).put('/me').set('X-Session', session).send({ favorites: [{ id: 'x' }] }).expect(400);

      // Signing in on another phone finds the same account; removing a favorite there sticks.
      const second = (await request(api).post('/auth/google').send({ idToken: 'ok:g-123' }).expect(200)).body;
      expect(second.session).not.toBe(session);
      expect(second.account.name).toBe('Aaron Heo');
      expect(second.favorites).toHaveLength(2);
      await request(api).put('/me').set('X-Session', second.session).send({ favorites: [{ id: sarault, addedAt: '2026-10-21T10:00:00Z' }], settings: put.body.settings }).expect(200);
      expect((await request(api).get('/me').set('X-Session', session).expect(200)).body.favorites.map((f: { id: number }) => f.id)).toEqual([sarault]);

      await request(api).post('/auth/signout').set('X-Session', session).expect(204);
      await request(api).get('/me').set('X-Session', session).expect(401);
      await request(api).delete('/me').set('X-Session', second.session).expect(204);
      await request(api).get('/me').set('X-Session', second.session).expect(401);
      expect(await one('select count(*)::int as n from account_favorite')).toEqual({ n: 0 });
      // A new sign-in after deleting starts empty.
      expect((await request(api).post('/auth/google').send({ idToken: 'ok:g-123' }).expect(200)).body.favorites).toEqual([]);
    });

    it('keeps accounts away from the Ask role', async () => {
      const client = await pool.connect();
      try {
        await client.query('begin; set local role chat_reader');
        await expect(client.query('select * from account')).rejects.toThrow(/permission denied/);
      } finally {
        await client.query('rollback');
        client.release();
      }
    });
  });

  it('answers 304 when nothing changed', async () => {
    const first = await request(app).get(`/events/${WT1_2026}/schedule`).expect(200);
    await request(app).get(`/events/${WT1_2026}/schedule`).set('If-None-Match', first.headers.etag!).expect(304);
  });
  // Last: it drops the Worlds' results.
  it('settles a finished event a week on; keeps one with gaps, leaves out one with no results', async () => {
    const ingest = new Ingest(pool);
    const live = await one<{ id: number }>('select id from event where slug = $1', [WT1_2026]);
    expect(await ingest.markSynced(live.id)).toEqual({ complete: false, gaps: null, noResults: false });

    const worlds = await one<{ id: number }>('select id from event where slug = $1', [WORLDS]);
    expect(await ingest.gaps(worlds.id)).toBeNull();
    await pool.query(
      `update entry set rank = null, time_ms = null, time_text = null, status = null, qualification = null where id = (
         select x.id from entry x join heat h on h.id = x.heat_id join round r on r.id = h.round_id
         join competition c on c.id = r.competition_id where c.event_id = $1 limit 1)`, [worlds.id]);
    expect(await ingest.markSynced(worlds.id)).toEqual({ complete: true, gaps: '1 skaters without a result', noResults: false });
    await request(app).get(`/events/${WORLDS}/schedule`).expect(200);
    const blank = await one<{ id: number }>(
      `select h.id from heat h join entry x on x.heat_id = h.id where x.rank is null and x.time_ms is null
         and x.status is null and x.qualification is null and h.round_id in (
           select r.id from round r join competition c on c.id = r.competition_id where c.event_id = $1)`, [worlds.id]);
    const heat = await request(app).get(`/heats/${blank.id}`).expect(200);
    expect(heat.body.results.map((r: { time: string | null }) => r.time)).toContain('No time');

    await pool.query(
      `update entry set rank = null, time_ms = null, status = null, qualification = null where heat_id in (
         select h.id from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id where c.event_id = $1)`,
      [worlds.id]);
    expect(await ingest.markSynced(worlds.id)).toEqual({ complete: true, gaps: null, noResults: true });
    expect(await one('select no_results, results_complete from event where id = $1', [worlds.id]))
      .toEqual({ no_results: true, results_complete: true });
    expect(await one<{ n: number }>('select count(*)::int as n from competition where event_id = $1', [worlds.id])).toEqual({ n: 0 });
    await request(app).get(`/events/${WORLDS}/schedule`).expect(404);
    const { body } = await request(app).get('/seasons/2025-2026/events').expect(200);
    expect(JSON.stringify(body)).not.toContain(WORLDS);
  });
});
